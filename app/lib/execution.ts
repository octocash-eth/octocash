import type { Account, Address, Chain, Hex, HttpTransport, WalletClient } from "viem";
import { type Call, encodeFunctionData, getAddress, isAddressEqual, parseAbi, zeroAddress } from "viem";
import { estimateGas, waitForTransactionReceipt } from "viem/actions";
import { tokenMessenger } from "~/data/cctp-contracts";
import { chains, transports } from "~/data/supported-chains";
import { executeCCTPBurn, executeCCTPMint, retrieveAttestations } from "./cctp";
import { createTransactionError } from "./errors";
import { getNativeBalance } from "./gas";
import {
  estimateChainGasCosts,
  fetchMaxFeePerGas,
  InsufficientNativeForGasError,
  type OperationType,
} from "./gas-estimation";
import { getLiFiQuoteForTargetOutput, type LiFiStatusResponse, pollLiFiTransferStatus } from "./lifi";
import { deriveSwapOutputAmount, executeOdosSwap, getSwapQuote } from "./odos";
import { getPublicClient, retryOnRateLimit } from "./public-client";
import { prepareSendCalls, SendCallsError } from "./send-calls";
import { getTokenBalance } from "./tokens";
import type { ConsolidationState, StepResult, TokenAmount, TransactionStep } from "./types";

/**
 * Thrown when a step's preflight balance check finds the wallet doesn't hold
 * enough of one of the input tokens. Surfaced before any signing prompt so
 * the user knows exactly which token / wallet is short rather than seeing a
 * cryptic on-chain revert.
 */
/** Quotes younger than this are reused; older ones get a fresh Odos round-trip. */
const SWAP_QUOTE_STALE_MS = 10_000;

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
 * on shortfall.
 *
 * If a balance read fails (post-retry RPC error, etc.), the error propagates so
 * the executor pauses instead of broadcasting calldata that will revert on
 * chain — burning gas is worse than asking the user to retry the preflight.
 *
 * Skipped entirely for `claim` and `attestation` steps (no wallet-held inputs).
 * For native (zero-address) inputs, callers should run `adjustNativeTokenForGas`
 * first; this validator checks the post-adjustment amount directly against the
 * wallet balance.
 */
/**
 * A progress update for an in-flight waiting step (LI.FI gas-top-up bridge, or
 * CCTP attestation). Delivered out-of-band via {@link ExecuteOptions.onStepProgress}
 * because the wait happens inside an awaited `executeStep` — the generator cannot
 * `yield` mid-step. Display-only; never mutates persisted {@link ConsolidationState}.
 */
export type StepProgressEvent =
  | { kind: "lifi"; stepId: string; txHash: string; fromChainId: number; toChainId: number; status: LiFiStatusResponse }
  | { kind: "attestation"; stepId: string; received: number; total: number };

export interface ExecuteOptions {
  onStepProgress?: (event: StepProgressEvent) => void;
}

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
    const balance = await getTokenBalance(chainId, wallet, token);
    if (balance < amount) {
      throw new InsufficientInputBalanceError(chainId, wallet, token, amount, balance);
    }
  }
}

/**
 * Execute consolidation plan with dependency tracking and error handling (T014)
 * Yields state after each significant change for progress tracking and persistence.
 * @param state - Consolidation state
 * @param walletClient - Wallet client for transaction execution
 * @param opts - Optional out-of-band hooks (e.g. {@link ExecuteOptions.onStepProgress})
 * @yields Updated consolidation state after each step change
 */
export async function* executeConsolidationPlan(
  state: ConsolidationState,
  walletClient: WalletClient<HttpTransport, Chain, Account>,
  opts?: ExecuteOptions,
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

    // Refresh swap quote immediately before execution so the UI shows the
    // freshest amount (and any delta vs the previously displayed quote).
    // Skip when the quote was fetched within `SWAP_QUOTE_STALE_MS` to avoid
    // an extra Odos round-trip on rapid retry/skip cycles — Odos quotes don't
    // meaningfully drift on that timescale.
    if (step.type === "swap" && (step.quotedAt === undefined || Date.now() - step.quotedAt >= SWAP_QUOTE_STALE_MS)) {
      const refreshedStep = await refreshSwapQuote(step);
      if (refreshedStep.outputToken.amount !== step.outputToken.amount) {
        // Quote changed - update plan and recalculate downstream steps
        workingState.plan = [...workingState.plan];
        workingState.plan[i] = refreshedStep;

        // Recalculate downstream steps with new quote estimate
        const { plan } = await recalculatePlan(workingState, i, refreshedStep.outputToken);
        workingState.plan = plan;
        workingState.updatedAt = Date.now();

        // Yield state after quote refresh so UI updates with new estimates
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

    // Verify-before-retry: if a prior attempt left a tx hash on this step
    // (e.g. log parsing threw after a successful on-chain swap, or
    // waitForReceipt failed after broadcast), check the chain before
    // re-broadcasting. The outcome decides whether to short-circuit with a
    // reconciled success, fall through with same-nonce replay (retryHints
    // intact), fall through with fresh nonce (chain-confirmed revert), or
    // pause for user intervention (nonce consumed by an unrelated tx).
    if (executingStep.transactionHash) {
      const outcome = await tryReconcileFromChain(executingStep, workingState);
      if (outcome?.kind === "success") {
        workingState.results = { ...workingState.results, [executingStep.id]: outcome.result };
        workingState.plan = [...workingState.plan];
        workingState.plan[i] = {
          ...executingStep,
          status: "success",
          transactionHash: outcome.result.transactionHash,
          executedAt: Date.now(),
        };
        if (outcome.result.actualOutput) {
          const { plan } = await recalculatePlan(workingState, i, outcome.result.actualOutput);
          workingState.plan = plan;
        }
        workingState.updatedAt = Date.now();
        yield structuredClone(workingState);
        continue;
      }
      if (outcome?.kind === "reverted") {
        // On-chain revert consumed the nonce. Clear retryHints so the next
        // broadcast goes out at a fresh nonce.
        executingStep.retryHints = undefined;
        workingState.plan = [...workingState.plan];
        workingState.plan[i] = executingStep;
      } else if (outcome?.kind === "nonce-consumed-other") {
        // The wallet's nonce advanced past our retryHints.nonce but our hash
        // isn't on chain — a different tx (wallet cancel, manual speedup)
        // consumed our nonce. We can't safely auto-retry; surface to the user.
        const txError = createTransactionError(
          new Error(
            "Original transaction's nonce was consumed by a different transaction (e.g. wallet speed-up, cancellation, or manual replacement). Review on-chain and skip this step if the replacement succeeded.",
          ),
        );
        const failedStep = {
          ...executingStep,
          status: "failed" as const,
          error: txError,
          retryHints: undefined,
        };
        workingState.results = {
          ...workingState.results,
          [failedStep.id]: {
            stepId: failedStep.id,
            status: "failed",
            chainId: failedStep.chainId,
            error: txError,
            transactionHash: executingStep.transactionHash,
          },
        };
        workingState.plan = [...workingState.plan];
        workingState.plan[i] = failedStep;
        workingState.status = "paused";
        workingState.currentStepIndex = i;
        workingState.updatedAt = Date.now();
        yield structuredClone(workingState);
        return;
      }
      // "not-found" / "rpc-error" / null: fall through with retryHints intact.
    }

    try {
      const result = await executeStep(executingStep, workingState, walletClient, opts);

      // Success - create new step reference with success status. Clear any
      // retryHints carried from a prior failed attempt so a fresh failure
      // starts the replacement cycle anew.
      const successStep = {
        ...executingStep,
        status: "success" as const,
        transactionHash: result.transactionHash,
        executedAt: Date.now(),
        retryHints: undefined,
      };
      workingState.results = {
        ...workingState.results,
        [successStep.id]: result,
      };
      workingState.plan = [...workingState.plan];
      workingState.plan[i] = successStep;
      workingState.updatedAt = Date.now();

      // Apply any metadata patch the step requested (e.g. attestation step
      // stashes Circle attestations here for the downstream claim step).
      if (result.metadataPatch) {
        workingState.metadata = { ...workingState.metadata, ...result.metadataPatch };
      }

      // Recalculate remaining steps with actual amounts (T016)
      if (result.actualOutput) {
        const { plan } = await recalculatePlan(workingState, i, result.actualOutput);
        workingState.plan = plan;
        workingState.updatedAt = Date.now();
      }

      // Yield state after successful step execution
      yield structuredClone(workingState);
    } catch (error) {
      // Failure - create new step reference with failed status. If the failure
      // surfaced after the wallet broadcast a tx (SendCallsError), preserve
      // the hash so the user has a chain link and the retry path can verify
      // on-chain status before re-broadcasting (avoids double-spend when the
      // tx actually succeeded but our parsing / receipt wait failed).
      const txError = createTransactionError(error);
      const recoveredHash = error instanceof SendCallsError ? error.transactionHash : undefined;
      // Whenever the wallet captured nonce + fees for this broadcast, preserve
      // them so the next attempt can replay at the same nonce. The retry path
      // probes the chain (`tryReconcileFromChain`) to decide whether to honor
      // the hints (replay) or drop them (chain-confirmed revert → fresh nonce).
      // USER_REJECTED self-excludes because the wallet throws before nonce is
      // captured, so `error.nonce` remains undefined.
      const retryHints =
        error instanceof SendCallsError && error.nonce !== undefined && error.maxFeePerGas !== undefined
          ? {
              nonce: error.nonce,
              maxFeePerGas: error.maxFeePerGas,
              maxPriorityFeePerGas: error.maxPriorityFeePerGas,
            }
          : undefined;
      const failedStep = {
        ...executingStep,
        status: "failed" as const,
        error: txError,
        transactionHash: recoveredHash ?? executingStep.transactionHash,
        retryHints: retryHints ?? executingStep.retryHints,
      };
      workingState.results = {
        ...workingState.results,
        [failedStep.id]: {
          stepId: failedStep.id,
          status: "failed",
          chainId: failedStep.chainId,
          error: txError,
          transactionHash: recoveredHash,
        },
      };
      workingState.plan = [...workingState.plan];
      workingState.plan[i] = failedStep;
      workingState.updatedAt = Date.now();

      // Always pause on failure so the user decides per step (retry, or skip
      // exactly this one and resume). Steps whose dependencies were skipped are
      // auto-skipped at the top of the loop on the next run — but we never run
      // the remainder of the plan unattended after a failure.
      workingState.status = "paused";
      workingState.currentStepIndex = i;

      // Yield paused state and return
      yield structuredClone(workingState);
      return;
    }
  }

  // All steps completed without an unhandled failure (failures pause + return
  // above). A plan that reaches here may still contain skipped steps.
  const hasSkipped = Object.values(workingState.results).some((r) => r.status === "skipped");
  const hasFailed = Object.values(workingState.results).some((r) => r.status === "failed");
  const finalStatus = hasSkipped || hasFailed ? ("partial" as const) : ("completed" as const);
  workingState.status = finalStatus;
  workingState.currentStepIndex = workingState.plan.length;
  workingState.updatedAt = Date.now();

  // Yield final state and return
  yield structuredClone(workingState);
}

/**
 * Outcome of probing the chain for a step's prior broadcast.
 *
 * - `success`: receipt found with status=success; we have a derived `StepResult`.
 * - `reverted`: receipt found with status=reverted; the nonce was consumed on-chain.
 *   Caller should clear `retryHints` so the next attempt uses a fresh nonce.
 * - `not-found`: receipt not yet indexed; tx may still be pending or never broadcast.
 *   Caller should keep `retryHints` for same-nonce replay.
 * - `nonce-consumed-other`: our hash isn't on chain but the wallet's next-nonce has
 *   advanced past `retryHints.nonce` — something else (cancellation, manual speedup)
 *   consumed the nonce. We can't safely retry without user intervention.
 * - `rpc-error`: probe failed even after rate-limit retries; treat as `not-found` for
 *   safety (keep `retryHints`, replay same-nonce — replay will either land or come
 *   back with another probe opportunity).
 */
export type ReconcileOutcome =
  | { kind: "success"; result: StepResult }
  | { kind: "reverted" }
  | { kind: "not-found" }
  | { kind: "nonce-consumed-other" }
  | { kind: "rpc-error" };

/**
 * Probes the chain for a step that already has an on-chain tx hash from a prior
 * attempt. Decides whether to short-circuit with a success result, fall through
 * to a fresh-nonce broadcast, fall through to a same-nonce replay, or pause for
 * user intervention.
 *
 * Returns `null` when the step has no prior hash (fresh attempt).
 */
async function tryReconcileFromChain(
  step: TransactionStep,
  state: ConsolidationState,
): Promise<ReconcileOutcome | null> {
  const hash = step.transactionHash;
  if (!hash) return null;

  const client = getPublicClient(step.chainId);
  let receipt: Awaited<ReturnType<typeof client.getTransactionReceipt>>;
  try {
    receipt = await retryOnRateLimit(() => client.getTransactionReceipt({ hash: hash as `0x${string}` }));
  } catch (error) {
    const name = (error as { name?: string } | null | undefined)?.name;
    if (name === "TransactionReceiptNotFoundError") {
      // Tx hash unknown to chain. Could be: still pending in mempool, never
      // broadcast, or replaced at the same nonce by another tx (wallet
      // cancellation / manual speedup). Probe the wallet's next-nonce to
      // distinguish "still ours to retry" from "consumed by something else".
      if (step.retryHints?.nonce !== undefined) {
        const broadcaster = step.inputTokens[0]?.walletAddress ?? step.outputToken.walletAddress;
        try {
          const latest = await retryOnRateLimit(() =>
            client.getTransactionCount({ address: broadcaster, blockTag: "latest" }),
          );
          if (latest > step.retryHints.nonce) {
            return { kind: "nonce-consumed-other" };
          }
        } catch {
          // Nonce probe failed; fall back to "not-found" (safer — caller will
          // keep retryHints and same-nonce replay).
        }
      }
      return { kind: "not-found" };
    }
    console.warn("[execution] reconcile-from-chain RPC failed; preserving retryHints for same-nonce replay", error);
    return { kind: "rpc-error" };
  }

  if (receipt.status !== "success") return { kind: "reverted" };

  // Receipt success — derive per-step result.
  switch (step.type) {
    case "swap": {
      // `receipt.logs ?? []` defends against flaky RPCs that return a
      // success receipt without the logs array. `deriveSwapOutputAmount`
      // itself already falls back to the quoted amount when logs are empty.
      const amount = deriveSwapOutputAmount(receipt.logs ?? [], step.outputToken);
      return {
        kind: "success",
        result: {
          stepId: step.id,
          status: "success",
          chainId: step.chainId,
          transactionHash: hash,
          actualOutput: { ...step.outputToken, amount, provenance: step.id },
        },
      };
    }
    case "bridge": {
      // Defensive discriminator: a bridge step's `transactionHash` should
      // only ever point to a CCTP burn (the call routed to TokenMessenger),
      // never to the preceding USDC approve. The send-calls per-iteration
      // scoping fix ensures this in normal flow, but a stale hash could
      // still arrive here from older persisted state. If the receipt's `to`
      // isn't the TokenMessenger, treat the prior tx as unrelated to this
      // step — return `reverted` so the executor clears retryHints (the
      // leaked approve's nonce was already consumed on chain) and falls
      // through to a fresh burn broadcast.
      const expectedTo = tokenMessenger[step.chainId];
      const receiptTo = (receipt as { to?: Address | null }).to;
      if (expectedTo && receiptTo && !isAddressEqual(receiptTo, expectedTo)) {
        return { kind: "reverted" };
      }
      return {
        kind: "success",
        result: {
          stepId: step.id,
          status: "success",
          chainId: step.chainId,
          transactionHash: hash,
          actualOutput: { ...step.outputToken, provenance: step.id },
        },
      };
    }
    case "claim": {
      const attestations = state.metadata?.attestations;
      const amount =
        attestations && attestations.length > 0
          ? attestations.reduce(
              (sum, a) =>
                sum +
                BigInt(a.decodedMessage.decodedMessageBody.amount) -
                BigInt(a.decodedMessage.decodedMessageBody.feeExecuted),
              0n,
            )
          : step.outputToken.amount;
      return {
        kind: "success",
        result: {
          stepId: step.id,
          status: "success",
          chainId: step.chainId,
          transactionHash: hash,
          actualOutput: { ...step.outputToken, amount, provenance: step.id },
        },
      };
    }
    case "transfer": {
      const amount = step.inputTokens.reduce((sum, t) => sum + t.amount, 0n);
      return {
        kind: "success",
        result: {
          stepId: step.id,
          status: "success",
          chainId: step.chainId,
          transactionHash: hash,
          actualOutput: { ...step.outputToken, amount, provenance: step.id },
        },
      };
    }
    default:
      return {
        kind: "success",
        result: {
          stepId: step.id,
          status: "success",
          chainId: step.chainId,
          transactionHash: hash,
          actualOutput: { ...step.outputToken, provenance: step.id },
        },
      };
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
 * Re-quote a swap step against Odos right before execution.
 *
 * Called unconditionally for every swap step (no staleness gate) so the UI
 * surfaces the most up-to-date output amount — and any delta vs the
 * previously displayed value — before signing.
 *
 * Best-effort: if the quote request fails (RPC/Odos outage), the original
 * step is returned and execution proceeds with the previously cached quote.
 *
 * @param step - The swap step to refresh
 * @returns Step with fresh quote, or the original step on quote failure
 */
async function refreshSwapQuote(step: TransactionStep): Promise<TransactionStep> {
  if (step.type !== "swap") {
    return step;
  }

  try {
    const freshQuote = await getSwapQuote(step.inputTokens, step.outputToken);
    return {
      ...step,
      outputToken: {
        ...freshQuote,
        provenance: step.id,
      },
      quotedAt: Date.now(),
    };
  } catch {
    return step;
  }
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
export function estimateRemainingChainOps(currentStep: TransactionStep, state: ConsolidationState): OperationType[] {
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
 * @returns Step result
 */
async function executeStep(
  step: TransactionStep,
  state: ConsolidationState,
  walletClient: WalletClient<HttpTransport, Chain, Account>,
  opts?: ExecuteOptions,
): Promise<StepResult> {
  const sendCalls = prepareSendCalls(walletClient);

  switch (step.type) {
    case "swap": {
      // Filter out tokens with zero amounts
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

      // Execute swap using Odos with non-zero tokens
      const { amount: actualAmount, transactionHash } = await executeOdosSwap(
        nonZeroTokens,
        step.outputToken,
        sendCalls,
        step.retryHints,
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

      // Execute CCTP burn
      const [burnTx] = await executeCCTPBurn(combinedInput, step.outputToken, sendCalls, "fast", step.retryHints);

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

      // Retrieve attestations, surfacing "X of N received" progress
      const attestations = await retrieveAttestations(bridgeTxs, undefined, (received, total) =>
        opts?.onStepProgress?.({ kind: "attestation", stepId: step.id, received, total }),
      );

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
        metadataPatch: { attestations },
      };
    }

    case "claim": {
      // Get attestations from previous attestation step
      const attestations = state.metadata?.attestations;
      if (!attestations || attestations.length === 0) {
        throw new Error("No attestations found for claim");
      }

      // Execute CCTP mint
      const [mintTx] = await executeCCTPMint(attestations, step.outputToken, sendCalls, step.retryHints);

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
      const [transactionHash] = await sendCalls(
        "transfer",
        step.chainId,
        sourceWallet,
        calls,
        undefined,
        step.retryHints,
      );

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

    case "gas-topup": {
      const destinations = step.gasTopUpDestinations;
      if (!destinations || destinations.length === 0) {
        throw new Error("Gas top-up step has no destinations");
      }

      const sourceAddress = step.inputTokens[0].walletAddress;
      const sourceChainId = step.chainId;
      const sourceChain = chains[sourceChainId as keyof typeof chains] as Chain;

      const sameChainDests = destinations.filter((d) => d.chainId === sourceChainId);
      const crossChainDests = destinations.filter((d) => d.chainId !== sourceChainId);

      // Get fresh LI.FI quotes only for cross-chain destinations (use target-output
      // quoting so cross-token pairs like ETH→POL are priced correctly)
      const quotes = await Promise.all(
        crossChainDests.map((dest) =>
          getLiFiQuoteForTargetOutput(sourceChainId, dest.chainId, BigInt(dest.amountWei), sourceAddress, dest.address),
        ),
      );

      const txClient = walletClient;
      try {
        await txClient.switchChain({ id: sourceChainId });
      } catch {
        await txClient.addChain({ chain: sourceChain });
      }

      const lifiTransfers: { txHash: string; bridge: string; fromChainId: number; toChainId: number }[] = [];
      let totalValue = 0n;
      let firstTxHash: Hex | undefined;

      // Same-chain destinations: simple native value transfers
      for (const dest of sameChainDests) {
        const value = BigInt(dest.amountWei);
        totalValue += value;

        const hash = await txClient.sendTransaction({
          account: sourceAddress,
          to: dest.address,
          data: "0x" as Hex,
          value,
          chain: sourceChain,
        });

        const receipt = await waitForTransactionReceipt(txClient, { hash });
        if (receipt.status !== "success") {
          throw new Error("Gas top-up transaction reverted");
        }

        firstTxHash ??= hash;
      }

      // Cross-chain destinations: send via LI.FI individually so status tracking works
      for (let i = 0; i < quotes.length; i++) {
        const quote = quotes[i];
        const txReq = quote.transactionRequest;
        const value = BigInt(txReq.value);
        totalValue += value;

        let gas: bigint | undefined;
        try {
          const estimated = await estimateGas(txClient, {
            account: sourceAddress,
            to: txReq.to,
            data: txReq.data,
            value,
          });
          gas = (estimated * 120n) / 100n;
        } catch {
          gas = undefined;
        }

        const hash = await txClient.sendTransaction({
          account: sourceAddress,
          to: txReq.to,
          data: txReq.data,
          value,
          gas,
          chain: sourceChain,
        });

        const receipt = await waitForTransactionReceipt(txClient, { hash });
        if (receipt.status !== "success") {
          throw new Error("Gas top-up transaction reverted");
        }

        firstTxHash ??= hash;
        lifiTransfers.push({
          txHash: hash,
          bridge: quote.tool,
          fromChainId: sourceChainId,
          toChainId: crossChainDests[i].chainId,
        });
      }

      return {
        stepId: step.id,
        status: "success",
        chainId: step.chainId,
        actualOutput: {
          ...step.outputToken,
          amount: totalValue,
          provenance: step.id,
        },
        transactionHash: firstTxHash as Hex,
        metadataPatch: { lifiTransfers },
      };
    }

    case "gas-topup-wait": {
      const transfers = state.metadata?.lifiTransfers;

      // If all destinations were same-chain, there are no LiFi transfers to poll
      if (transfers && transfers.length > 0) {
        await Promise.all(
          transfers.map((t) =>
            pollLiFiTransferStatus(t.txHash, t.bridge, t.fromChainId, t.toChainId, undefined, undefined, (status) =>
              opts?.onStepProgress?.({
                kind: "lifi",
                stepId: step.id,
                txHash: t.txHash,
                fromChainId: t.fromChainId,
                toChainId: t.toChainId,
                status,
              }),
            ),
          ),
        );
      }

      return {
        stepId: step.id,
        status: "success",
        chainId: step.chainId,
        actualOutput: {
          ...step.outputToken,
          provenance: step.id,
        },
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
    case "gas-topup": {
      // Gas top-up output mirrors the source-chain native deposit it consumed.
      const totalAmount = updatedInputs.reduce((sum, t) => sum + t.amount, 0n);
      return {
        ...step.outputToken,
        amount: totalAmount,
      };
    }
    case "attestation":
    case "gas-topup-wait":
      // No amount change; these are wait/synchronization steps.
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
): Promise<{ plan: TransactionStep[] }> {
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

  return { plan: updatedPlan };
}
