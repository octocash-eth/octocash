import type { Account, Address, Chain, Hex, HttpTransport, WalletClient } from "viem";
import { type Call, encodeFunctionData, erc20Abi, getAddress, isAddressEqual, parseAbi, zeroAddress } from "viem";
import { chains, transports } from "~/data/supported-chains";
import {
  executeCCTPBurn,
  executeCCTPMint,
  getApproveAndBurnUsdcCalls,
  getMintUsdcCalls,
  retrieveAttestations,
} from "./cctp";
import { createTransactionError } from "./errors";
import { getNativeBalance } from "./gas";
import {
  estimateChainGasCosts,
  fetchMaxFeePerGas,
  InsufficientNativeForGasError,
  type OperationType,
} from "./gas-estimation";
import { buildOdosCalls, executeOdosSwap, getSwapQuote } from "./odos";
import { getPublicClient } from "./public-client";
import type { SendCallsFn, SendCallsOptions, StallInfo } from "./send-calls";
import { encodeMulticall3Aggregate3, MULTICALL3_ADDRESS, prepareSendCalls } from "./send-calls";
import type { ConsolidationState, StepResult, TokenAmount, TransactionStep } from "./types";

/**
 * Thrown when a step's preflight balance check finds the wallet doesn't hold
 * enough of one of the input tokens. Surfaced before any signing prompt so
 * the user knows exactly which token / wallet is short rather than seeing a
 * cryptic on-chain revert.
 */
export class InsufficientInputBalanceError extends Error {
  override name = "InsufficientInputBalanceError" as const;
  chainId: number;
  walletAddress: Address;
  token: Address;
  required: bigint;
  actual: bigint;
  constructor(chainId: number, walletAddress: Address, token: Address, required: bigint, actual: bigint) {
    super(
      `Insufficient balance for ${token} on chain ${chainId} for wallet ${walletAddress}: required ${required}, have ${actual}.`,
    );
    this.chainId = chainId;
    this.walletAddress = walletAddress;
    this.token = token;
    this.required = required;
    this.actual = actual;
  }
}

/**
 * Aggregates required amounts per `(chainId, wallet, token)` and verifies the
 * wallet holds at least that much. Throws {@link InsufficientInputBalanceError}
 * on shortfall. RPC failures during balance reads are logged and skipped —
 * the broadcast itself will surface the failure if the chain genuinely lacks
 * the funds.
 *
 * Skipped entirely for `claim` and `attestation` steps (no wallet-held inputs).
 * Aggregation happens BEFORE the per-token check so e.g. two `0.6 USDC` rows
 * from the same wallet require `1.2 USDC` (not `0.6 USDC` per row).
 *
 * For native (zero-address) inputs, the caller is responsible for running
 * `adjustNativeTokenForGas` first; this validator checks the post-adjustment
 * amount directly against the wallet balance.
 */
export async function validateInputBalances(step: TransactionStep, _state: ConsolidationState): Promise<void> {
  if (step.type === "claim" || step.type === "attestation") return;

  const required = new Map<string, { chainId: number; wallet: Address; token: Address; amount: bigint }>();
  for (const input of step.inputTokens) {
    const tokenAddr = getAddress(input.token);
    const walletAddr = getAddress(input.walletAddress);
    const key = `${input.chainId}:${walletAddr}:${tokenAddr}`;
    const existing = required.get(key);
    if (existing) {
      existing.amount += input.amount;
    } else {
      required.set(key, { chainId: input.chainId, wallet: walletAddr, token: tokenAddr, amount: input.amount });
    }
  }

  for (const { chainId, wallet, token, amount } of required.values()) {
    if (amount === 0n) continue;
    let balance: bigint;
    try {
      if (isAddressEqual(token, zeroAddress)) {
        const chain = chains[chainId as keyof typeof chains];
        balance = await getNativeBalance(chain, wallet, transports?.[chainId as keyof typeof transports]);
      } else {
        const publicClient = getPublicClient(chainId);
        balance = await publicClient.readContract({
          address: token,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [wallet],
        });
      }
    } catch (err) {
      // RPC failure: don't synthesize a balance shortfall — let the actual
      // broadcast surface a meaningful error if the funds really are missing.
      console.warn(`[validateInputBalances] balance read failed for ${token} on chain ${chainId}:`, err);
      continue;
    }
    if (balance < amount) {
      throw new InsufficientInputBalanceError(chainId, wallet, token, amount, balance);
    }
  }
}

/**
 * Re-prepares a single pending step against current chain / market state.
 * Returns either the same step reference (no change) or a new step with
 * refreshed `outputToken` (and `quotedAt` for swap).
 *
 * - `swap`: re-quote via Odos and update the output amount.
 * - `bridge`/`claim`/`transfer`/`attestation`: no-op (deterministic enough
 *   that there is nothing to refresh today; structure preserved so future
 *   per-type refreshes plug in cleanly).
 *
 * Soft-fails on quote errors: returns the original step rather than
 * propagating the error, mirroring the existing
 * `refreshSwapQuoteIfNeeded` philosophy. The actual failure surfaces only
 * if/when the step reaches `executeStep` and broadcast is attempted.
 */
export async function refreshStep(step: TransactionStep, _state: ConsolidationState): Promise<TransactionStep> {
  if (step.type !== "swap") return step;
  try {
    const fresh = await getSwapQuote(step.inputTokens, step.outputToken);
    if (fresh.amount === step.outputToken.amount) return step;
    return {
      ...step,
      outputToken: { ...fresh, provenance: step.outputToken.provenance ?? step.id },
      quotedAt: Date.now(),
    };
  } catch {
    return step;
  }
}

/**
 * Walks every step with `status === "pending"` whose upstream dependencies
 * are settled (so its `inputTokens` are stable) and runs `refreshStep` on
 * each. When a swap step's quote shifts, cascades via `recalculatePlan` so
 * downstream steps' input amounts stay in sync.
 *
 * Returns the same state reference when nothing changed — the hook can use
 * referential equality to skip an unnecessary `setState` / save.
 */
export async function refreshPendingSteps(state: ConsolidationState): Promise<ConsolidationState> {
  const settled = new Set<string>();
  for (const s of state.plan) {
    if (s.status === "success" || s.status === "skipped" || s.status === "failed") {
      settled.add(s.id);
    }
  }

  let working: ConsolidationState | null = null;

  for (let i = 0; i < state.plan.length; i++) {
    const step = (working ?? state).plan[i];
    if (step.status !== "pending") continue;

    // Skip refresh while the step still depends on an in-flight upstream:
    // its `inputTokens.amount` may not reflect the eventual actuals.
    const provs = new Set(step.inputTokens.map((t) => t.provenance).filter((p): p is string => p !== undefined));
    let depsSettled = true;
    for (const p of provs) {
      if (!settled.has(p)) {
        depsSettled = false;
        break;
      }
    }
    if (!depsSettled) continue;

    const refreshed = await refreshStep(step, working ?? state);
    if (refreshed === step) continue;

    if (!working) {
      working = { ...state, plan: [...state.plan] };
    }
    working.plan[i] = refreshed;

    if (refreshed.outputToken.amount !== step.outputToken.amount) {
      await recalculatePlan(working, i, refreshed.outputToken);
    }
  }

  if (!working) return state;
  return { ...working, updatedAt: Date.now() };
}

/**
 * Information passed to `onStepStall` when an in-flight step's transaction
 * appears stuck in the wallet's internal pool (e.g. a wallet/relayer is
 * holding it and not broadcasting). Same shape as the underlying
 * {@link StallInfo} but with the step-level `stepId` so UIs can correlate
 * to the plan.
 */
export interface StepStallInfo extends StallInfo {
  /** ID of the {@link TransactionStep} whose tx has stalled. */
  stepId: string;
}

/**
 * Information passed to `onStepHashSent` each time the wallet returns a hash
 * for a step's transaction — fired for the original send and for each resend.
 * Used by the hook to persist the full attempt history.
 */
export interface StepHashSentInfo {
  /** ID of the {@link TransactionStep} whose tx was just sent. */
  stepId: string;
  hash: Hex;
  nonce: number | undefined;
  account: Address;
  chainId: number;
}

/**
 * Optional callbacks the executor can use to report soft execution events
 * that don't change the plan's status (e.g. a stalled tx that is still
 * recoverable via resend, or a hash that was just broadcast).
 */
export interface ExecutionCallbacks {
  onStepStall?: (info: StepStallInfo) => void;
  onStepHashSent?: (info: StepHashSentInfo) => void;
  /**
   * Optional accessor for the hook's latest known state. Lets the executor
   * pick up downstream-step refreshes done by the hook's 30s background
   * timer without overwriting in-flight progress. The hook keeps a ref
   * mirror of its React state and exposes it through this getter.
   */
  getLatestStateRef?: () => ConsolidationState | null;
}

/**
 * Execute consolidation plan with dependency tracking and error handling (T014)
 * Yields state after each significant change for progress tracking and persistence.
 * @param state - Consolidation state
 * @param walletClient - Wallet client for transaction execution
 * @param callbacks - Optional soft-event callbacks (e.g. stall detection)
 * @yields Updated consolidation state after each step change
 */
export async function* executeConsolidationPlan(
  state: ConsolidationState,
  walletClient: WalletClient<HttpTransport, Chain, Account>,
  callbacks?: ExecutionCallbacks,
): AsyncGenerator<ConsolidationState, void, void> {
  // Validate initial state - allow ready, paused, or executing (for recovery scenarios)
  if (state.status !== "ready" && state.status !== "paused" && state.status !== "executing") {
    throw new Error("Invalid state: must be 'ready', 'paused', or 'executing'");
  }

  // Create a working copy of the state to avoid mutating the parameter
  const workingState: ConsolidationState = {
    ...state,
    status: "executing",
    updatedAt: Date.now(),
    results: { ...state.results },
    plan: [...state.plan],
    metadata: state.metadata ? { ...state.metadata } : undefined,
  };

  // Yield initial state change
  yield structuredClone(workingState);

  let pausedDueToFailure = false;

  // Execute steps in order
  for (let i = workingState.currentStepIndex; i < workingState.plan.length; i++) {
    const step = workingState.plan[i];
    const updatedState = {
      ...workingState,
      currentStepIndex: i,
    };
    Object.assign(workingState, updatedState);

    // Skip if already completed or failed
    const existingResult = workingState.results[step.id];
    if (existingResult?.status === "success" || existingResult?.status === "failed") {
      continue;
    }

    // Check if step should be skipped (T015)
    if (shouldSkipStep(step, workingState.results)) {
      const skipReason = getSkipReason(step, workingState.results);
      const skippedStep = { ...step, status: "skipped" as const };
      workingState.results = {
        ...workingState.results,
        [step.id]: {
          stepId: step.id,
          status: "skipped",
          chainId: step.chainId,
          skipReason,
        },
      };
      workingState.plan = [...workingState.plan];
      workingState.plan[i] = skippedStep;
      workingState.updatedAt = Date.now();

      // Yield state after skipping step
      yield structuredClone(workingState);
      continue;
    }

    // Adopt any background refresh the hook performed against this step
    // before we fall through to the on-entry refresh. The hook's 30s timer
    // only ever rewrites pending downstream steps' `outputToken`/`quotedAt`
    // (via `refreshPendingSteps`), so it's safe to merge those fields into
    // workingState even though the generator owns `status`/`results`/etc.
    const latest = callbacks?.getLatestStateRef?.();
    if (latest) {
      const latestStep = latest.plan[i];
      const ws = workingState.plan[i];
      if (
        latestStep &&
        latestStep.id === ws.id &&
        ws.status === "pending" &&
        latestStep.status === "pending" &&
        (latestStep.quotedAt ?? 0) > (ws.quotedAt ?? 0)
      ) {
        workingState.plan = [...workingState.plan];
        workingState.plan[i] = {
          ...ws,
          inputTokens: latestStep.inputTokens,
          outputToken: latestStep.outputToken,
          quotedAt: latestStep.quotedAt,
        };
      }
    }

    // Right-before-broadcast refresh: replaces the old conditional
    // `refreshSwapQuoteIfNeeded` so the executor's last view of the quote
    // (the one the user is about to sign against) is always recently
    // re-quoted, regardless of what the background timer did.
    {
      const currentStep = workingState.plan[i];
      const refreshedStep = await refreshStep(currentStep, workingState);
      if (refreshedStep !== currentStep) {
        workingState.plan = [...workingState.plan];
        workingState.plan[i] = refreshedStep;
        if (refreshedStep.outputToken.amount !== currentStep.outputToken.amount) {
          await recalculatePlan(workingState, i, refreshedStep.outputToken);
        }
        workingState.updatedAt = Date.now();
        yield structuredClone(workingState);
      }
    }

    // Execute step - create new step reference with executing status
    const executingStep = { ...workingState.plan[i], status: "executing" as const };
    workingState.plan = [...workingState.plan];
    workingState.plan[i] = executingStep;
    workingState.updatedAt = Date.now();

    // Yield state when starting step execution
    yield structuredClone(workingState);

    try {
      const result = await executeStep(executingStep, workingState, walletClient, callbacks);

      // Success - create new step reference with success status
      const successStep = {
        ...executingStep,
        status: "success" as const,
        transactionHash: result.transactionHash,
        executedAt: Date.now(),
      };
      workingState.results = {
        ...workingState.results,
        [successStep.id]: result,
      };
      workingState.plan = [...workingState.plan];
      workingState.plan[i] = successStep;
      workingState.updatedAt = Date.now();

      // Recalculate remaining steps with actual amounts (T016)
      if (result.actualOutput) {
        await recalculatePlan(workingState, i, result.actualOutput);
        workingState.updatedAt = Date.now();
      }

      // Yield state after successful step execution
      yield structuredClone(workingState);
    } catch (error) {
      // Failure - create new step reference with failed status
      const txError = createTransactionError(error);
      const failedStep = {
        ...executingStep,
        status: "failed" as const,
        error: txError,
      };
      workingState.results = {
        ...workingState.results,
        [failedStep.id]: {
          stepId: failedStep.id,
          status: "failed",
          chainId: failedStep.chainId,
          error: txError,
        },
      };
      workingState.plan = [...workingState.plan];
      workingState.plan[i] = failedStep;
      workingState.updatedAt = Date.now();

      // If hasSubsequentExecution is false, pause for retry
      if (!workingState.hasSubsequentExecution) {
        pausedDueToFailure = true;
        workingState.status = "paused";
        workingState.currentStepIndex = i;

        // Yield paused state and return
        yield structuredClone(workingState);
        return;
      }

      // Otherwise, yield state and continue to next step
      yield structuredClone(workingState);
    }
  }

  // All steps completed (only if we didn't pause)
  if (!pausedDueToFailure) {
    const hasSkipped = Object.values(workingState.results).some((r) => r.status === "skipped");
    const hasFailed = Object.values(workingState.results).some((r) => r.status === "failed");
    const finalStatus = hasSkipped || hasFailed ? ("partial" as const) : ("completed" as const);
    workingState.status = finalStatus;
    workingState.currentStepIndex = workingState.plan.length;
    workingState.updatedAt = Date.now();

    // Yield final state and return
    yield structuredClone(workingState);
    return;
  }
}

/**
 * Filters out tokens with zero amounts and validates at least one token remains
 * @param tokens - Array of tokens to filter
 * @param stepId - Step ID for error message
 * @param stepType - Step type for error message
 * @returns Non-empty array of tokens with amounts > 0
 * @throws {Error} If all tokens have zero amounts
 */
function filterZeroAmounts(
  tokens: readonly TokenAmount[],
  stepId: string,
  stepType: string,
): [TokenAmount, ...TokenAmount[]] {
  const nonZeroTokens = tokens.filter((t) => t.amount > 0n);

  if (nonZeroTokens.length === 0) {
    throw new Error(`Cannot execute ${stepType} with zero input amounts for step ${stepId}`);
  }

  return nonZeroTokens as [TokenAmount, ...TokenAmount[]];
}

/**
 * Re-estimates gas at execution time and adjusts the native token amount if the
 * planned amount can no longer be afforded (e.g. gas prices rose since planning).
 * Only intervenes when adjustedNativeAmount < selectedAmount.
 */
async function adjustNativeTokenForGas(
  tokens: [TokenAmount, ...TokenAmount[]],
  step: TransactionStep,
  state: ConsolidationState,
): Promise<[TokenAmount, ...TokenAmount[]]> {
  const nativeIdx = tokens.findIndex((t) => isAddressEqual(t.token, zeroAddress));
  if (nativeIdx < 0) return tokens;

  const nativeToken = tokens[nativeIdx];
  const chainId = step.chainId;

  // Estimate gas for remaining operations on this chain
  const remainingOps = estimateRemainingChainOps(step, state);
  if (remainingOps.length === 0) return tokens;

  let balance: bigint;
  let totalGasCost: bigint;
  try {
    const maxFeePerGas = await fetchMaxFeePerGas(chainId);
    const gasCost = await estimateChainGasCosts(chainId, remainingOps, maxFeePerGas);
    totalGasCost = gasCost.totalGasCost;

    const chain = chains[chainId as keyof typeof chains];
    balance = await getNativeBalance(
      chain,
      nativeToken.walletAddress,
      transports?.[chainId as keyof typeof transports],
    );
  } catch (error) {
    // RPC failure during pre-flight gas check: log and fall back to the planned
    // amount. The transaction itself will surface a meaningful error if it
    // genuinely lacks gas.
    console.warn(`[execution] gas re-estimation failed for chain ${chainId}, proceeding with planned amounts`, error);
    return tokens;
  }

  const adjustedAmount = balance > totalGasCost ? balance - totalGasCost : 0n;
  if (adjustedAmount >= nativeToken.amount) return tokens;

  // Gas costs eat into the planned swap amount
  const adjusted = [...tokens] as [TokenAmount, ...TokenAmount[]];
  if (adjustedAmount <= 0n) {
    adjusted.splice(nativeIdx, 1);
    if (adjusted.length === 0) {
      throw new InsufficientNativeForGasError(
        `Cannot execute swap on chain ${chainId}: all native token reserved for gas (balance=${balance}, required=${totalGasCost})`,
        chainId,
        nativeToken.walletAddress,
      );
    }
  } else {
    adjusted[nativeIdx] = { ...nativeToken, amount: adjustedAmount };
  }
  return adjusted;
}

/**
 * Determines remaining gas-consuming operations on the same chain as the given step.
 */
function estimateRemainingChainOps(currentStep: TransactionStep, state: ConsolidationState): OperationType[] {
  const ops: OperationType[] = [];
  const chainId = currentStep.chainId;
  let foundCurrent = false;

  for (const planStep of state.plan) {
    if (planStep.id === currentStep.id) {
      foundCurrent = true;
    }
    if (!foundCurrent) continue;
    if (planStep.chainId !== chainId) continue;
    // Only "pending", "executing", and "failed" (retry candidates) consume gas going forward.
    if (planStep.status === "success" || planStep.status === "skipped") continue;

    switch (planStep.type) {
      case "swap":
        for (const input of planStep.inputTokens) {
          if (!isAddressEqual(input.token, zeroAddress)) ops.push("erc20-approval");
        }
        ops.push(planStep.inputTokens.length > 1 ? "swap-multi" : "swap");
        break;
      case "bridge":
        ops.push("cctp-approval", "cctp-burn");
        break;
      case "claim":
        ops.push("cctp-claim");
        break;
      case "transfer": {
        const firstToken = planStep.inputTokens[0];
        if (firstToken) {
          ops.push(isAddressEqual(firstToken.token, zeroAddress) ? "transfer-native" : "transfer-erc20");
        }
        break;
      }
    }
  }

  return ops;
}

/**
 * Execute a single transaction step
 * @param step - Transaction step
 * @param state - Consolidation state
 * @param walletClient - Wallet client
 * @param callbacks - Optional soft-event callbacks (e.g. stall detection)
 * @returns Step result
 */
async function executeStep(
  step: TransactionStep,
  state: ConsolidationState,
  walletClient: WalletClient<HttpTransport, Chain, Account>,
  callbacks?: ExecutionCallbacks,
): Promise<StepResult> {
  // Tag any stall/hash-sent events fired by the underlying send-calls layer
  // with this step's id so the UI can correlate. We only build the base
  // options object when at least one callback is provided; otherwise we
  // leave it undefined so the default behavior is unchanged.
  const onStall = callbacks?.onStepStall;
  const onHashSent = callbacks?.onStepHashSent;
  const baseSendCallsOptions: SendCallsOptions | undefined =
    onStall || onHashSent
      ? {
          ...(onStall ? { onStall: (info) => onStall({ ...info, stepId: step.id }) } : {}),
          ...(onHashSent
            ? {
                onHashSent: (info) =>
                  onHashSent({
                    stepId: step.id,
                    hash: info.hash,
                    nonce: info.nonce,
                    account: info.account,
                    chainId: info.chainId,
                  }),
              }
            : {}),
        }
      : undefined;
  /**
   * Per-branch prepareSendCalls factory. Folds in the (optional) per-step
   * `rebuildCall` so the lib can re-broadcast freshly-built calldata at the
   * stuck nonce when the user clicks the Retry CTA. Each step type's
   * branch builds its own rebuild closure that knows how to re-quote /
   * re-build the relevant call.
   */
  const buildSendCalls = (rebuildCall?: SendCallsOptions["rebuildCall"]): SendCallsFn => {
    const opts: SendCallsOptions | undefined = rebuildCall
      ? { ...(baseSendCallsOptions ?? {}), rebuildCall }
      : baseSendCallsOptions;
    return prepareSendCalls(walletClient, undefined, undefined, opts);
  };

  switch (step.type) {
    case "swap": {
      // Filter out tokens with zero amounts.
      let nonZeroTokens = filterZeroAmounts(step.inputTokens, step.id, "swap");

      // Re-adjust native token amount at execution time if needed (gas prices may
      // have moved since planning). We mutate the step in place so downstream
      // recalculatePlan() sees the adjusted inputs.
      const adjustedTokens = await adjustNativeTokenForGas(nonZeroTokens, step, state);
      if (adjustedTokens !== nonZeroTokens) {
        nonZeroTokens = adjustedTokens;
        step.inputTokens = adjustedTokens;
      }

      // Preflight: confirm the wallet actually holds what we're about to swap,
      // including the post-adjustment native amount.
      await validateInputBalances(step, state);

      // Rebuild closure: invoked by the lib when the user clicks a Retry CTA
      // (sim of the original swap calldata reverted — quote went stale).
      // Re-runs the input-balance check and re-quotes via Odos. We always
      // return the fresh swap call (the LAST entry in buildOdosCalls's
      // result); for the rare case where an approval at a lower stepIndex
      // is the one that stalled, the lib would replace it with the swap
      // calldata at the same nonce — which reverts because the allowance
      // hasn't been set yet, and the user recovers via the PausedActions
      // Skip / Retry buttons.
      const rebuildCall: SendCallsOptions["rebuildCall"] = async (_stepIndex) => {
        await validateInputBalances(step, state);
        const newCalls = await buildOdosCalls(nonZeroTokens, step.outputToken);
        const swap = newCalls[newCalls.length - 1];
        return swap ? { to: swap.to, data: swap.data, value: swap.value } : null;
      };
      const sendCalls = buildSendCalls(rebuildCall);

      // Execute swap using Odos with non-zero tokens
      const { amount: actualAmount, transactionHash } = await executeOdosSwap(
        nonZeroTokens,
        step.outputToken,
        sendCalls,
      );

      const actualOutput: TokenAmount = {
        ...step.outputToken,
        amount: actualAmount,
        provenance: step.id,
      };

      return {
        stepId: step.id,
        status: "success",
        chainId: step.chainId,
        actualOutput,
        transactionHash,
      };
    }

    case "bridge": {
      // Validate all input tokens are homogeneous before combining
      if (step.inputTokens.length > 1) {
        const firstToken = step.inputTokens[0];
        for (let i = 1; i < step.inputTokens.length; i++) {
          const token = step.inputTokens[i];
          if (
            token.token !== firstToken.token ||
            token.chainId !== firstToken.chainId ||
            token.walletAddress !== firstToken.walletAddress
          ) {
            throw new Error(
              `Cannot combine heterogeneous input tokens for bridge step ${step.id}: ` +
                `token[0]={token: ${firstToken.token}, chainId: ${firstToken.chainId}, wallet: ${firstToken.walletAddress}} vs ` +
                `token[${i}]={token: ${token.token}, chainId: ${token.chainId}, wallet: ${token.walletAddress}}`,
            );
          }
        }
      }

      // Filter out tokens with zero amounts
      const nonZeroTokens = filterZeroAmounts(step.inputTokens, step.id, "bridge");

      // Sum all non-zero input amounts (bridge may have multiple USDC sources)
      const totalAmount = nonZeroTokens.reduce((sum, t) => sum + t.amount, 0n);
      const combinedInput = { ...nonZeroTokens[0], amount: totalAmount };

      await validateInputBalances(step, state);

      // Rebuild closure: bridge calls are deterministic given (amount, dest,
      // address) so re-running `getApproveAndBurnUsdcCalls` produces the
      // same burn call. We still re-run it (cheap) so the structure plugs
      // in the same as swap and so any future fee-refresh inside CCTP
      // surfaces here automatically. Approvals (lower stepIndex) return
      // null — they're idempotent and a stuck approval should Resend.
      const rebuildCall: SendCallsOptions["rebuildCall"] = async (_stepIndex) => {
        await validateInputBalances(step, state);
        const newCalls = await getApproveAndBurnUsdcCalls(
          combinedInput.chainId,
          combinedInput.amount,
          step.outputToken.chainId,
          step.outputToken.walletAddress,
          combinedInput.walletAddress,
        );
        const burn = newCalls[newCalls.length - 1];
        return burn ? { to: burn.to, data: burn.data, value: burn.value } : null;
      };
      const sendCalls = buildSendCalls(rebuildCall);

      // Execute CCTP burn
      const [burnTx] = await executeCCTPBurn(combinedInput, step.outputToken, sendCalls);

      return {
        stepId: step.id,
        status: "success",
        chainId: step.chainId,
        actualOutput: {
          ...step.outputToken,
          provenance: step.id, // When bridge is successful, the amount of all dependent steps will update
        },
        transactionHash: burnTx,
      };
    }

    case "attestation": {
      // Collect transaction hashes from successful bridge steps using input token provenance
      const bridgeStepIds = getProvenanceSteps(step);
      const bridgeTxs = Array.from(bridgeStepIds)
        .map((stepId) => {
          const depResult = state.results[stepId];
          if (!depResult?.transactionHash) return null;
          return [depResult.transactionHash, depResult.chainId] as [string, number];
        })
        .filter((tx): tx is [string, number] => tx !== null);

      if (bridgeTxs.length === 0) {
        throw new Error("No bridge transactions found for attestation");
      }

      // Retrieve attestations
      const attestations = await retrieveAttestations(bridgeTxs);

      // Store attestations for claim step (mutation of working state during execution)
      const updatedMetadata = { ...state.metadata, attestations };
      Object.assign(state, { metadata: updatedMetadata });

      // Calculate actual bridged amount from attestations
      const actualAmount = attestations.reduce(
        (sum, attestation) =>
          sum +
          BigInt(attestation.decodedMessage.decodedMessageBody.amount) -
          BigInt(attestation.decodedMessage.decodedMessageBody.feeExecuted),
        0n,
      );

      const actualOutput: TokenAmount = {
        ...step.outputToken,
        amount: actualAmount,
        provenance: step.id, // When attestation is successful, the amount of all dependent steps will update
      };

      return {
        stepId: step.id,
        status: "success",
        chainId: step.chainId,
        actualOutput,
      };
    }

    case "claim": {
      // Get attestations from previous attestation step
      const attestations = state.metadata?.attestations;
      if (!attestations || attestations.length === 0) {
        throw new Error("No attestations found for claim");
      }

      // Claim has no wallet-held inputs so validateInputBalances is a no-op
      // for it; we still call it for symmetry / future-proofing.
      await validateInputBalances(step, state);

      // Rebuild closure: `executeCCTPMint` uses `atomic-multicall` mode, so
      // the underlying lib sees a single transaction at stepIndex 0 (the
      // Multicall3 aggregate3 call). On Retry, re-run getMintUsdcCalls
      // (which filters out attestations whose nonces are now used) and
      // re-encode as aggregate3 calldata. Returns null if all the mints
      // have been claimed already — at which point the original would
      // also revert and the receipt-timeout path kicks in.
      const rebuildCall: SendCallsOptions["rebuildCall"] = async (stepIndex) => {
        if (stepIndex !== 0) return null;
        const newMintCalls = await getMintUsdcCalls(step.chainId, attestations);
        if (newMintCalls.length === 0) return null;
        const allowFailure = false; // executeCCTPMint uses "atomic-multicall"
        const callData = encodeMulticall3Aggregate3(newMintCalls, allowFailure);
        return { to: MULTICALL3_ADDRESS, data: callData, value: 0n };
      };
      const sendCalls = buildSendCalls(rebuildCall);

      // Execute CCTP mint
      const [mintTx] = await executeCCTPMint(attestations, step.outputToken, sendCalls);

      // Calculate actual amount from attestations
      const actualAmount = attestations.reduce(
        (sum, attestation) =>
          sum +
          BigInt(attestation.decodedMessage.decodedMessageBody.amount) -
          BigInt(attestation.decodedMessage.decodedMessageBody.feeExecuted),
        0n,
      );

      const actualOutput: TokenAmount = {
        ...step.outputToken,
        amount: actualAmount,
        provenance: step.id, // When claim is successful, the amount of all dependent steps will update
      };

      return {
        stepId: step.id,
        status: "success",
        chainId: step.chainId,
        actualOutput,
        transactionHash: mintTx,
      };
    }

    case "transfer": {
      // Transfer is deterministic: no rebuild needed (a stuck transfer
      // should always be Resend, not Retry — same calldata).
      const sendCalls = buildSendCalls();

      // Execute simple token transfer
      if (step.inputTokens.length === 0) {
        throw new Error("Transfer step must have at least one input token");
      }

      // Validate all inputs match the output token (same token address, chain)
      // Only the wallet address should differ
      for (const token of step.inputTokens) {
        if (token.token !== step.outputToken.token) {
          throw new Error("All transfer input tokens must be the same token address as output");
        }
        if (token.chainId !== step.outputToken.chainId) {
          throw new Error("Transfer source and destination must be on the same chain");
        }
      }

      // All inputs must come from the same source wallet
      const sourceWallet = step.inputTokens[0].walletAddress;
      for (const token of step.inputTokens) {
        if (token.walletAddress !== sourceWallet) {
          throw new Error("All transfer input tokens must be from the same wallet");
        }
      }

      await validateInputBalances(step, state);

      // Calculate total amount to transfer
      const totalAmount = step.inputTokens.reduce((sum, t) => sum + t.amount, 0n);

      // Build transfer call - handle native tokens (ETH) specially
      const calls: Call[] = [];
      if (isAddressEqual(step.outputToken.token, zeroAddress)) {
        // Native token (ETH) - simple value transfer
        calls.push({
          to: step.outputToken.walletAddress,
          data: "0x",
          value: totalAmount,
        });
      } else {
        // ERC20 token - encode transfer function call
        calls.push({
          to: step.outputToken.token,
          data: encodeFunctionData({
            abi: parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]),
            args: [step.outputToken.walletAddress, totalAmount],
          }),
        });
      }

      // Execute transfer
      const [transactionHash] = await sendCalls("transfer", step.chainId, sourceWallet, calls);

      return {
        stepId: step.id,
        status: "success",
        chainId: step.chainId,
        actualOutput: {
          ...step.outputToken,
          amount: totalAmount,
          provenance: step.id, // When transfer is successful, the amount of all dependent steps will update
        },
        transactionHash,
      };
    }

    default:
      throw new Error(`Unknown step type: ${step.type}`);
  }
}

/**
 * Get unique step IDs from input token provenance
 * @param step - Transaction step
 * @returns Set of step IDs that produced the input tokens
 */
function getProvenanceSteps(step: TransactionStep): Set<string> {
  return new Set(step.inputTokens.map((t) => t.provenance).filter((p): p is string => p !== undefined));
}

/**
 * Check if a step should be skipped due to failed dependencies (T015)
 * Uses input token provenance to determine dependencies
 * @param step - Transaction step
 * @param results - Map of step results
 * @returns True if step should be skipped
 */
export function shouldSkipStep(step: TransactionStep, results: Record<string, StepResult>): boolean {
  const provenanceSteps = getProvenanceSteps(step);

  if (provenanceSteps.size === 0) return false; // No dependencies

  // Skip if ALL provenance steps failed/skipped
  return Array.from(provenanceSteps).every((stepId) => {
    const result = results[stepId];
    return result?.status === "failed" || result?.status === "skipped";
  });
}

/**
 * Get skip reason for a step
 * Uses input token provenance to identify failed dependencies
 * @param step - Transaction step
 * @param results - Map of step results
 * @returns Skip reason message
 */
function getSkipReason(step: TransactionStep, results: Record<string, StepResult>): string {
  const provenanceSteps = getProvenanceSteps(step);

  const failedDeps = Array.from(provenanceSteps).filter((stepId) => {
    const depResult = results[stepId];
    return depResult?.status === "failed";
  });

  if (failedDeps.length > 0) {
    return `Depends on failed step ${failedDeps[0]}`;
  }

  const skippedDeps = Array.from(provenanceSteps).filter((stepId) => {
    const depResult = results[stepId];
    return depResult?.status === "skipped";
  });

  if (skippedDeps.length > 0) {
    return `Depends on skipped step ${skippedDeps[0]}`;
  }

  // Note: This fallback should never be reached given current shouldSkipStep() logic,
  // but kept as defensive programming in case skip logic changes in the future
  return "Skipped";
}

/**
 * Calculate updated output for a step based on its type and updated inputs
 * @param step - Transaction step to calculate output for
 * @param updatedInputs - Updated input token amounts
 * @returns Updated output token amount
 */
async function calculateStepOutput(
  step: TransactionStep,
  updatedInputs: [TokenAmount, ...TokenAmount[]],
): Promise<TokenAmount> {
  switch (step.type) {
    case "swap":
      // Re-quote with ALL inputs for proportional adjustment
      try {
        return await getSwapQuote(updatedInputs, step.outputToken);
      } catch (_error) {
        return step.outputToken; // Keep original on failure
      }
    case "bridge": {
      // Bridge outputs sum of all inputs (minus bridge fees, handled elsewhere)
      const totalAmount = updatedInputs.reduce((sum, t) => sum + t.amount, 0n);
      return {
        ...step.outputToken,
        amount: totalAmount,
      };
    }
    case "claim": {
      // Claim outputs what it claims (sum of all bridged amounts)
      const totalClaimAmount = updatedInputs.reduce((sum, t) => sum + t.amount, 0n);
      return {
        ...step.outputToken,
        amount: totalClaimAmount,
      };
    }
    case "transfer": {
      // Transfer outputs sum of all inputs
      const totalAmount = updatedInputs.reduce((sum, t) => sum + t.amount, 0n);
      return {
        ...step.outputToken,
        amount: totalAmount,
      };
    }
    case "attestation":
      // Attestations don't change amounts
      return step.outputToken;

    default:
      return step.outputToken;
  }
}

/**
 * Recalculate plan after a step completes with actual amounts (T016)
 * Cascades changes through all dependent steps in the plan.
 * @param state - Consolidation state (mutated in place for working state)
 * @param completedStepIndex - Index of completed step
 * @param actualOutput - Actual output amount
 */
async function recalculatePlan(
  state: ConsolidationState,
  completedStepIndex: number,
  actualOutput: TokenAmount,
): Promise<void> {
  const completedStep = state.plan[completedStepIndex];

  // Create a new plan array with updated steps
  const updatedPlan = [...state.plan];

  // Track which outputs have changed, starting with the completed step
  const changedOutputs = new Map<string, TokenAmount>();
  changedOutputs.set(completedStep.id, actualOutput);

  // Iterate through remaining steps in order
  for (let i = completedStepIndex + 1; i < updatedPlan.length; i++) {
    const step = updatedPlan[i];

    // Check if this step depends on any changed outputs using input token provenance
    const dependenciesChanged = step.inputTokens.some(
      (input) => input.provenance && changedOutputs.has(input.provenance),
    );

    if (!dependenciesChanged) {
      continue; // Skip, no updates needed
    }

    // Update inputs: check each token's provenance to see if it needs updating
    const updatedInputs = step.inputTokens.map((input) => {
      const sourceStepId = input.provenance;

      if (sourceStepId) {
        const changedOutput = changedOutputs.get(sourceStepId);
        if (changedOutput) {
          // Update amount but preserve other metadata including provenance
          return { ...input, amount: changedOutput.amount };
        }
      }

      // No provenance or no change: keep input unchanged
      return input;
    }) as [TokenAmount, ...TokenAmount[]];

    // Recalculate output based on step type
    const newOutput = await calculateStepOutput(step, updatedInputs);

    // Update the step in the plan
    updatedPlan[i] = {
      ...step,
      inputTokens: updatedInputs,
      outputToken: newOutput,
    };

    // Track this change for downstream dependencies
    if (newOutput.amount !== step.outputToken.amount) {
      changedOutputs.set(step.id, newOutput);
    }
  }

  // Update state with new plan and timestamp
  Object.assign(state, {
    plan: updatedPlan,
    updatedAt: Date.now(),
  });
}
