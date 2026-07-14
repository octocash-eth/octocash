import type { Account, Address, Chain, Hex, HttpTransport, Log, WalletClient } from "viem";
import { type Call, encodeFunctionData, formatUnits, getAddress, isAddressEqual, parseAbi, zeroAddress } from "viem";
import { estimateGas, waitForTransactionReceipt } from "viem/actions";
import { gnosis, mainnet } from "viem/chains";
import { tokenMessenger } from "~/data/cctp-contracts";
import { FOREIGN_OMNIBRIDGE, HOME_OMNIBRIDGE, USDC_ON_XDAI } from "~/data/omnibridge-contracts";
import { BPS_DENOMINATOR, RAILGUN_PROXY, RAILGUN_SHIELD_FEE_BPS } from "~/data/railgun";
import { chains, transports } from "~/data/supported-chains";
import { USDC } from "~/data/token-contracts";
import { accountFor, isSmartAccount, toAccountsMap } from "./accounts";
import { executeCCTPBurn, executeCCTPMint, retrieveAttestations } from "./cctp";
import {
  buildDeloraCalls,
  deriveSwapOutputAmount,
  executeDeloraSwap,
  getSwapQuote,
  SLIPPAGE_LIMIT,
  simulateSwapDelivery,
} from "./delora";
import { createTransactionError } from "./errors";
import { getNativeBalance } from "./gas";
import {
  estimateChainGasCosts,
  fetchMaxFeePerGas,
  InsufficientNativeForGasError,
  type OperationType,
} from "./gas-estimation";
import { type GasRefuelRecord, getGasRefuelQuote, waitForRefuelDelivery } from "./gas-refuel";
import {
  executeOmnibridgeBurn,
  executeOmnibridgeClaim,
  executeOmnibridgeDeposit,
  retrieveOmnibridgeClaims,
  waitForOmnibridgeDelivery,
} from "./omnibridge";
import { getPublicClient, retryOnRateLimit } from "./public-client";
import { isSafeWallet, prepareStepSendCalls, type SafeStepHooks, type StepSendHooks } from "./safe-send-calls";
import { SendCallsError } from "./send-calls";
import type { SmartStepHooks } from "./smart-send-calls";
import { getTokenBalance } from "./tokens";
import type {
  ConsolidationState,
  SafeProposalRecord,
  SendCallsBundleRecord,
  StepResult,
  TokenAmount,
  TransactionStep,
} from "./types";

/**
 * Thrown when a step's preflight balance check finds the wallet doesn't hold
 * enough of one of the input tokens. Surfaced before any signing prompt so
 * the user knows exactly which token / wallet is short rather than seeing a
 * cryptic on-chain revert.
 */
/** Quotes younger than this are reused; older ones get a fresh Delora round-trip. */
const SWAP_QUOTE_STALE_MS = 10_000;

/**
 * Quote-drift tolerance in basis points, single-sourced from the on-chain
 * slippage limit ({@link SLIPPAGE_LIMIT}): a fresh quote may under-deliver the
 * plan's expected output by at most this fraction before execution pauses.
 */
const QUOTE_DRIFT_TOLERANCE_BPS = BigInt(Math.round(SLIPPAGE_LIMIT * 10_000));

/**
 * Thrown (into the step's error, pausing the plan) when the fresh pre-swap
 * quote under-delivers the plan's expected output by more than the slippage
 * tolerance. The plan is updated with the fresh amounts BEFORE pausing, so the
 * user reviews reality and an explicit retry proceeds on the new baseline.
 *
 * The message deliberately contains "slippage" so `createTransactionError`
 * classifies it as SLIPPAGE_EXCEEDED ("Price changed too much / Retry for new
 * quote") — and deliberately NOT the `ExternalAPIError:` prefix, which would
 * trigger the plan-error auto-retry loop; drift needs explicit user consent.
 */
export class QuoteDriftError extends Error {
  override name = "QuoteDriftError" as const;
  stepId: string;
  plannedAmount: bigint;
  freshAmount: bigint;
  driftBps: number;
  toleranceBps: number;
  constructor(step: TransactionStep, plannedAmount: bigint, freshAmount: bigint) {
    const { decimals, symbol } = step.outputToken;
    const driftBps = plannedAmount > 0n ? Number(((plannedAmount - freshAmount) * 10_000n) / plannedAmount) : 0;
    super(
      `Swap quote moved beyond the slippage tolerance: the plan expected at least ` +
        `${formatUnits(plannedAmount, decimals)} ${symbol}, but a fresh quote returns ` +
        `${formatUnits(freshAmount, decimals)} ${symbol} (${(driftBps / 100).toFixed(2)}% less). ` +
        `The plan has been updated with current quotes — review it and retry to continue.`,
    );
    this.stepId = step.id;
    this.plannedAmount = plannedAmount;
    this.freshAmount = freshAmount;
    this.driftBps = driftBps;
    this.toleranceBps = Number(QUOTE_DRIFT_TOLERANCE_BPS);
  }
}

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
 * A progress update for an in-flight waiting step (gas-refuel delivery, or
 * CCTP attestation). Delivered out-of-band via {@link ExecuteOptions.onStepProgress}
 * because the wait happens inside an awaited `executeStep` — the generator cannot
 * `yield` mid-step. Display-only; never mutates persisted {@link ConsolidationState}.
 */
export type StepProgressEvent =
  | { kind: "refuel"; stepId: string; txHash: string; fromChainId: number; toChainId: number; delivered: boolean }
  | { kind: "attestation"; stepId: string; received: number; total: number }
  // Omnibridge wait: "exit" = AMB signature collection (Gnosis -> mainnet),
  // "enter" = USDC.e delivery watch on Gnosis (mainnet -> Gnosis).
  | { kind: "omnibridge"; stepId: string; direction: "exit" | "enter"; ready: number; total: number }
  // Safe submission lifecycle. `stepIds` lists every member of the batch
  // group so the UI can fan the status out to all rows executing together.
  | {
      kind: "safe";
      stepId: string;
      stepIds: string[];
      phase: "signing" | "proposed" | "confirmations" | "executing";
      confirmed: number;
      threshold: number;
      safeTxHash?: string;
      chainId: number;
    }
  // ERC-4337 smart-wallet submission (EIP-5792 bundle) lifecycle.
  | {
      kind: "smart";
      stepId: string;
      stepIds: string[];
      phase: "sending" | "confirming";
      chainId: number;
      bundleId?: string;
      call?: { index: number; total: number };
    };

export interface ExecuteOptions {
  onStepProgress?: (event: StepProgressEvent) => void;
  /**
   * Called with a cloned state whenever a step persists mid-step progress
   * that must survive a tab close (e.g. a freshly-POSTed Safe proposal —
   * losing it would orphan a pending co-signer flow). The regular per-yield
   * persistence only fires between steps.
   */
  onInterimState?: (state: ConsolidationState) => void;
}

export async function validateInputBalances(step: TransactionStep, _state: ConsolidationState): Promise<void> {
  // Wait/claim steps consume in-flight bridge outputs, not wallet-held funds.
  if (
    step.type === "claim" ||
    step.type === "attestation" ||
    step.type === "gnosis-wait" ||
    step.type === "gnosis-claim"
  )
    return;

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

    // Partial-dependency pruning: drop inputs produced by failed/skipped steps
    // so a step that still has usable inputs (independently-held funds or
    // successfully-produced outputs) runs on only what remains, rather than
    // over-counting a balance that no longer exists. `shouldSkipStep` above has
    // already guaranteed at least one usable input survives.
    const prunedStep = pruneUnusableInputs(workingState.plan[i], workingState.results);
    if (prunedStep !== workingState.plan[i]) {
      workingState.plan = [...workingState.plan];
      workingState.plan[i] = prunedStep;
      workingState.updatedAt = Date.now();
    }

    // Refresh swap quote immediately before execution so the UI shows the
    // freshest amount (and any delta vs the previously displayed quote).
    // Skip when the quote was fetched within `SWAP_QUOTE_STALE_MS` to avoid
    // an extra Delora round-trip on rapid retry/skip cycles — quotes don't
    // meaningfully drift on that timescale, and each skip saves a unit of
    // Delora's per-IP rate-limit quota.
    //
    // Drift policy (time passes between planning and execution, and between
    // steps): a fresh quote within the slippage tolerance is adopted and
    // execution continues; a fresh quote below `planned × (1 − tolerance)` is
    // ALSO adopted (the paused plan must show reality, and the on-chain
    // minOutputAmount floor would otherwise protect only the degraded quote)
    // but the step fails with QuoteDriftError and the plan pauses for an
    // explicit user retry on the new baseline.
    if (step.type === "swap" && (step.quotedAt === undefined || Date.now() - step.quotedAt >= SWAP_QUOTE_STALE_MS)) {
      const refreshedStep = await refreshSwapQuote(step);
      if (refreshedStep.outputToken.amount !== step.outputToken.amount) {
        const plannedAmount = step.outputToken.amount;
        const freshAmount = refreshedStep.outputToken.amount;

        // Quote changed - update plan and recalculate downstream steps
        workingState.plan = [...workingState.plan];
        workingState.plan[i] = refreshedStep;

        // Recalculate downstream steps with new quote estimate
        const { plan } = await recalculatePlan(workingState, i, refreshedStep.outputToken);
        workingState.plan = plan;
        workingState.updatedAt = Date.now();

        const driftFloor = plannedAmount - (plannedAmount * QUOTE_DRIFT_TOLERANCE_BPS) / 10_000n;
        if (freshAmount < driftFloor) {
          const txError = createTransactionError(new QuoteDriftError(refreshedStep, plannedAmount, freshAmount));
          const failedStep = { ...workingState.plan[i], status: "failed" as const, error: txError };
          workingState.plan = [...workingState.plan];
          workingState.plan[i] = failedStep;
          workingState.results = {
            ...workingState.results,
            [failedStep.id]: {
              stepId: failedStep.id,
              status: "failed",
              chainId: failedStep.chainId,
              error: txError,
            },
          };
          workingState.status = "paused";
          workingState.currentStepIndex = i;
          workingState.updatedAt = Date.now();
          yield structuredClone(workingState);
          return;
        }

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

    // Atomic batch groups (independent same-chain steps of one Safe or one
    // ERC-4337 smart wallet) execute as ONE on-chain submission when the
    // first member is reached; the remaining members are resolved from the
    // shared result and skipped by the "already completed" check on their own
    // iterations. They succeed, fail, and retry together (the batch is
    // atomic). Reconciliation of a prior attempt happens through the
    // persisted proposal/bundle record inside the account's send path, not
    // the per-step tx-hash probe.
    const groupMembers = getBatchGroupMembers(workingState, executingStep);
    if (groupMembers.length > 1) {
      // Mark every member as executing so the whole group shows live status.
      workingState.plan = workingState.plan.map((planStep) =>
        groupMembers.some((member) => member.id === planStep.id)
          ? { ...planStep, status: "executing" as const }
          : planStep,
      );
      workingState.updatedAt = Date.now();
      yield structuredClone(workingState);

      try {
        const groupResults = await executeAtomicBatchGroup(
          getBatchGroupMembers(workingState, executingStep),
          workingState,
          walletClient,
          opts,
        );

        workingState.plan = [...workingState.plan];
        for (const result of groupResults) {
          const memberIndex = workingState.plan.findIndex((planStep) => planStep.id === result.stepId);
          if (memberIndex >= 0) {
            workingState.plan[memberIndex] = {
              ...workingState.plan[memberIndex],
              status: "success",
              transactionHash: result.transactionHash,
              executedAt: Date.now(),
              retryHints: undefined,
            };
          }
          workingState.results = { ...workingState.results, [result.stepId]: result };
        }
        for (const result of groupResults) {
          if (result.actualOutput) {
            const memberIndex = workingState.plan.findIndex((planStep) => planStep.id === result.stepId);
            const { plan } = await recalculatePlan(workingState, memberIndex, result.actualOutput);
            workingState.plan = plan;
          }
        }
        workingState.updatedAt = Date.now();
        yield structuredClone(workingState);
        continue;
      } catch (error) {
        // Atomic failure: every member of the group fails with the same
        // error/hash/hints, and the plan pauses at the first member.
        const txError = createTransactionError(error);
        const recoveredHash = error instanceof SendCallsError ? error.transactionHash : undefined;
        const retryHints =
          error instanceof SendCallsError && error.nonce !== undefined && error.maxFeePerGas !== undefined
            ? {
                nonce: error.nonce,
                maxFeePerGas: error.maxFeePerGas,
                maxPriorityFeePerGas: error.maxPriorityFeePerGas,
              }
            : undefined;
        workingState.plan = [...workingState.plan];
        for (const member of groupMembers) {
          const memberIndex = workingState.plan.findIndex((planStep) => planStep.id === member.id);
          if (memberIndex >= 0) {
            workingState.plan[memberIndex] = {
              ...workingState.plan[memberIndex],
              status: "failed",
              error: txError,
              transactionHash: recoveredHash ?? workingState.plan[memberIndex].transactionHash,
              retryHints: retryHints ?? workingState.plan[memberIndex].retryHints,
            };
          }
          workingState.results = {
            ...workingState.results,
            [member.id]: {
              stepId: member.id,
              status: "failed",
              chainId: member.chainId,
              error: txError,
              transactionHash: recoveredHash,
            },
          };
        }
        workingState.status = "paused";
        workingState.currentStepIndex = i;
        workingState.updatedAt = Date.now();
        yield structuredClone(workingState);
        return;
      }
    }

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
        // A reconciled step can carry metadata too (e.g. a reconstructed
        // Omnibridge delivery record) — apply it like the normal path does.
        if (outcome.result.metadataPatch) {
          workingState.metadata = { ...workingState.metadata, ...outcome.result.metadataPatch };
        }
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
 * Whether a mined receipt plausibly belongs to this step's expected contract
 * interaction.
 *
 * EOA and Safe steps match on the OUTER `to` (the target contract, or the
 * Safe whose execTransaction wraps the inner calldata). Smart-account steps
 * can't: the outer tx is a UserOperation submitted via the ERC-4337
 * EntryPoint (or a bundler multiplexer), so the receipt's `to` is never the
 * target — and, critically, outer receipt success does NOT imply the inner
 * call succeeded (the EntryPoint tx succeeds even when the UserOp's call
 * reverted). For smart steps the discriminator is therefore LOG-based: a
 * genuine burn/deposit/shield always emits ≥1 event FROM the expected
 * contract, and its absence covers both "unrelated tx" and "inner revert".
 */
function receiptMatchesTarget(
  receipt: { to?: Address | null; logs?: { address: Address }[] },
  expectedTo: Address | undefined,
  execution: TransactionStep["execution"],
): boolean {
  if (execution?.via === "smart") {
    if (!expectedTo) return true;
    return (receipt.logs ?? []).some((log) => isAddressEqual(log.address, expectedTo));
  }
  const target = execution?.via === "safe" ? execution.safeAddress : expectedTo;
  const receiptTo = receipt.to;
  if (!target || !receiptTo) return true;
  return isAddressEqual(receiptTo, target);
}

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
      // Smart-account steps: the outer tx is a UserOperation sent by the
      // EntryPoint/bundler, so the account's own eth_getTransactionCount never
      // advances — the nonce probe cannot distinguish anything. (The smart
      // path also never sets retryHints, so this guard is belt-and-braces.)
      if (step.execution?.via === "smart") {
        return { kind: "not-found" };
      }
      if (step.retryHints?.nonce !== undefined) {
        // For Safe steps the on-chain tx is the owner EOA's execTransaction —
        // probing the Safe's eth_getTransactionCount would be meaningless
        // (contract nonce ≠ account nonce) and could false-positive.
        const proposal =
          step.execution?.via === "safe" ? state.metadata?.safe?.proposals?.[step.execution.batchId] : undefined;
        const broadcaster =
          step.execution?.via === "safe"
            ? (proposal?.executor ?? step.execution.ownerAddress)
            : (step.inputTokens[0]?.walletAddress ?? step.outputToken.walletAddress);
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
      // Safe steps go on-chain as execTransaction TO the Safe itself, not to
      // the TokenMessenger; smart-account steps match on logs instead (see
      // receiptMatchesTarget).
      if (!receiptMatchesTarget(receipt, tokenMessenger[step.chainId], step.execution)) {
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
    case "gnosis-bridge": {
      // Same defensive discriminator as "bridge": the recorded hash must point
      // at the bridging call — the USDC egress `transferAndCall` on the legacy
      // USDC token, the direct-route egress `relayTokens` on the home
      // Omnibridge, or the ingress relay on the foreign Omnibridge — never at
      // a preceding approve or transmuter withdraw.
      const inputToken = step.inputTokens[0]?.token;
      const isUsdcEgress = inputToken !== undefined && isAddressEqual(inputToken, USDC[gnosis.id]);
      const expectedTo =
        step.chainId === gnosis.id ? (isUsdcEgress ? USDC_ON_XDAI : HOME_OMNIBRIDGE) : FOREIGN_OMNIBRIDGE;
      if (!receiptMatchesTarget(receipt, expectedTo, step.execution)) {
        return { kind: "reverted" };
      }
      const amount = step.inputTokens.reduce((sum, t) => sum + t.amount, 0n);

      // Ingress deposits normally persist their delivery record (pre-deposit
      // delivered-token baseline) from executeOmnibridgeDeposit. When the
      // executor died between broadcast and that write, reconcile must
      // reconstruct it or the downstream gnosis-wait fails with "No Omnibridge
      // deposits found" while the funds are in flight. The true baseline is
      // unknowable after the fact; assume 0 so the wait completes once the
      // receiver's balance covers the deposited amount — for a consolidation
      // intermediate wallet that balance is overwhelmingly bridge-delivered
      // funds.
      let metadataPatch: StepResult["metadataPatch"];
      if (step.chainId !== gnosis.id) {
        const deliveries = state.metadata?.omnibridge?.deliveries ?? [];
        if (!deliveries.some((d) => d.txHash === hash)) {
          metadataPatch = {
            omnibridge: {
              ...state.metadata?.omnibridge,
              deliveries: [
                ...deliveries,
                {
                  txHash: hash,
                  toAddress: step.outputToken.walletAddress,
                  tokenAddress: step.outputToken.token,
                  baselineUnits: "0",
                  minDeliveredUnits: amount.toString(),
                },
              ],
            },
          };
        }
      }

      return {
        kind: "success",
        result: {
          stepId: step.id,
          status: "success",
          chainId: step.chainId,
          transactionHash: hash,
          actualOutput: { ...step.outputToken, amount, provenance: step.id },
          ...(metadataPatch ? { metadataPatch } : {}),
        },
      };
    }
    case "gnosis-claim": {
      const claims = state.metadata?.omnibridge?.claims;
      const amount =
        claims && claims.length > 0
          ? claims.reduce((sum, claim) => sum + BigInt(claim.amount), 0n)
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
    case "shield": {
      // Same defensive discriminator as "bridge": the recorded hash must point
      // at the RailgunSmartWallet shield call, not the preceding ERC20 approve.
      // (Shield steps are never Safe/smart-executed — planning gates them —
      // but the guard keeps the discriminator honest if that ever changes.)
      if (!receiptMatchesTarget(receipt, RAILGUN_PROXY[step.chainId], step.execution)) {
        return { kind: "reverted" };
      }
      const total = step.inputTokens.reduce((sum, t) => sum + t.amount, 0n);
      const amount = total - (total * RAILGUN_SHIELD_FEE_BPS) / BPS_DENOMINATOR;
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
 * Re-quote a swap step against Delora right before execution.
 *
 * Called unconditionally for every swap step (no staleness gate) so the UI
 * surfaces the most up-to-date output amount — and any delta vs the
 * previously displayed value — before signing. Note that execution fetches
 * its own quote again inside `buildDeloraCalls` (the Delora quote *is* the
 * executable calldata); drift between the displayed and executed quote is
 * bounded on-chain by the quote's `minOutputAmount`.
 *
 * Best-effort: if the quote request fails (RPC/Delora outage), the original
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
  } catch (error) {
    // Transient re-quote failure: proceed on the planned numbers — the swap's
    // on-chain minOutputAmount floor (from the execution-time quote) still
    // protects the funds. Rate limits surface later via executeDeloraSwap.
    console.warn("[execution] swap quote refresh failed; proceeding with planned amounts", error);
    return step;
  }
}

/**
 * Re-estimates gas at execution time and adjusts the native token amount if the
 * planned amount can no longer be afforded (e.g. gas prices rose since planning).
 * Only intervenes when adjustedNativeAmount < selectedAmount.
 *
 * Prefers the plan's per-step `estimatedGas` units (measured via
 * `eth_simulateV1` at planning time) repriced at the current fee; falls back
 * to the static shape-based budgets when any remaining step lacks an estimate
 * (e.g. plans persisted before estimates existed).
 */
async function adjustNativeTokenForGas(
  tokens: [TokenAmount, ...TokenAmount[]],
  step: TransactionStep,
  state: ConsolidationState,
): Promise<[TokenAmount, ...TokenAmount[]]> {
  // Safe-executed steps pay no gas from the Safe's own native balance — the
  // owner EOA funds execTransaction — so nothing is reserved out of the
  // amounts here. Planning already validated the Safe's native *value* spend
  // against its balance and charged gas to the owner.
  if (step.execution?.via === "safe") return tokens;

  const nativeIdx = tokens.findIndex((t) => isAddressEqual(t.token, zeroAddress));
  if (nativeIdx < 0) return tokens;

  const nativeToken = tokens[nativeIdx];
  const chainId = step.chainId;

  // Remaining unfinished gas-consuming steps this wallet signs on this chain
  // (including the current one).
  const remainingSteps = remainingChainStepsForWallet(step, state, nativeToken.walletAddress);
  if (remainingSteps.length === 0) return tokens;

  let balance: bigint;
  let totalGasCost: bigint;
  try {
    const maxFeePerGas = await fetchMaxFeePerGas(chainId);
    if (remainingSteps.every((s) => s.estimatedGas !== undefined)) {
      const gasUnits = remainingSteps.reduce((sum, s) => sum + (s.estimatedGas?.gasUnits ?? 0n), 0n);
      totalGasCost = gasUnits * maxFeePerGas;
    } else {
      const remainingOps = estimateRemainingChainOps(step, state);
      if (remainingOps.length === 0) return tokens;
      const gasCost = await estimateChainGasCosts(chainId, remainingOps, maxFeePerGas);
      totalGasCost = gasCost.totalGasCost;
    }

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
 * Collects the remaining unfinished gas-consuming steps that `wallet` signs on
 * the same chain as `currentStep` (including `currentStep` itself). Gas is
 * paid per wallet, so other wallets' steps on the chain don't reserve against
 * this wallet's native balance.
 */
function remainingChainStepsForWallet(
  currentStep: TransactionStep,
  state: ConsolidationState,
  wallet: Address,
): TransactionStep[] {
  const remaining: TransactionStep[] = [];
  let foundCurrent = false;
  for (const planStep of state.plan) {
    if (planStep.id === currentStep.id) foundCurrent = true;
    if (!foundCurrent) continue;
    if (planStep.chainId !== currentStep.chainId) continue;
    if (planStep.status === "success" || planStep.status === "skipped") continue;
    if (planStep.type === "attestation" || planStep.type === "gas-topup-wait" || planStep.type === "gnosis-wait")
      continue;
    const stepWallet = planStep.inputTokens[0]?.walletAddress;
    if (!stepWallet || !isAddressEqual(stepWallet, wallet)) continue;
    remaining.push(planStep);
  }
  return remaining;
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
      case "swap": {
        // One approval (ERC20 only) + one Delora swap tx per unique token
        // address (same-address entries share one quote/swap).
        const uniqueTokens = new Set(planStep.inputTokens.map((input) => input.token.toLowerCase()));
        for (const token of uniqueTokens) {
          if (!isAddressEqual(token as Address, zeroAddress)) ops.push("erc20-approval");
          ops.push("swap");
        }
        break;
      }
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
      case "shield":
        ops.push("erc20-approval", "shield");
        break;
      case "gnosis-bridge":
        // Egress: approve + transmuter withdraw + transferAndCall; ingress:
        // approve + relayTokensAndCall.
        if (planStep.chainId === gnosis.id) {
          ops.push("erc20-approval", "omnibridge-relay", "omnibridge-relay");
        } else {
          ops.push("erc20-approval", "omnibridge-relay");
        }
        break;
      case "gnosis-claim":
        // One executeSignatures per AMB message (one message per bridge step).
        for (const _ of planStep.inputTokens) ops.push("omnibridge-claim");
        break;
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
/**
 * The still-executable members of the step's Safe batch group, in plan order.
 * Members already resolved (success/failed/skipped) or whose dependencies
 * failed are excluded — the group executes with whatever remains usable.
 * Returns just `[step]` for untagged steps and singleton groups.
 */
export function getBatchGroupMembers(state: ConsolidationState, step: TransactionStep): TransactionStep[] {
  const batchId = step.execution?.batchId;
  if (!batchId) return [step];
  const members = state.plan.filter((planStep) => {
    if (planStep.execution?.batchId !== batchId) return false;
    const result = state.results[planStep.id];
    if (result?.status === "success" || result?.status === "skipped" || result?.status === "failed") return false;
    return !shouldSkipStep(planStep, state.results);
  });
  return members.length > 0 ? members : [step];
}

/**
 * Executes a multi-member atomic batch group as ONE on-chain submission:
 * every member's calls are built up front (fresh Delora calldata for swaps,
 * plain transfers as-is), concatenated in plan order, and routed through the
 * account's transport — a Safe MultiSend execTransaction, or an ERC-4337
 * wallet's atomic `wallet_sendCalls` bundle. One signature round either way;
 * members succeed together (the batch is atomic) and the caller fails them
 * together.
 *
 * Per-member output attribution: both transports preserve call order and the
 * receipt(s) carry all logs, so each member's output is summed from Transfer
 * logs of ITS output token to its recipient. Members sharing an output token
 * split the summed total proportionally to their planned amounts —
 * downstream steps on the same wallet+chain consume the sum anyway, so the
 * split only affects display granularity.
 */
async function executeAtomicBatchGroup(
  members: TransactionStep[],
  state: ConsolidationState,
  walletClient: WalletClient<HttpTransport, Chain, Account>,
  opts?: ExecuteOptions,
): Promise<StepResult[]> {
  const first = members[0];
  const execution = first.execution;
  if (!execution) throw new Error("Atomic batch group requires tagged steps");
  const chainId = first.chainId;
  const batchWallet = execution.via === "safe" ? execution.safeAddress : execution.smartAddress;

  for (const member of members) {
    await validateInputBalances(member, state);
  }

  const buildMemberCalls = async (): Promise<{ member: TransactionStep; calls: Call[] }[]> => {
    const built: { member: TransactionStep; calls: Call[] }[] = [];
    for (const member of members) {
      if (member.type === "swap") {
        const inputs = filterZeroAmounts(member.inputTokens, member.id, "swap");
        const { calls, minOutputAmount } = await buildDeloraCalls(inputs, member.outputToken);
        // Per-member delivery simulation: inner calls run with the batching
        // account as msg.sender (MultiSend delegatecall / UserOp execution),
        // which is exactly what simulateCalls models with `account`.
        await simulateSwapDelivery(chainId, batchWallet, calls, member.outputToken, minOutputAmount);
        built.push({ member, calls });
      } else if (member.type === "transfer") {
        const totalAmount = member.inputTokens.reduce((sum, t) => sum + t.amount, 0n);
        const call: Call = isAddressEqual(member.outputToken.token, zeroAddress)
          ? { to: member.outputToken.walletAddress, data: "0x", value: totalAmount }
          : {
              to: member.outputToken.token,
              data: encodeFunctionData({
                abi: parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]),
                args: [member.outputToken.walletAddress, totalAmount],
              }),
            };
        built.push({ member, calls: [call] });
      } else {
        // Planning only groups swaps and transfers (see tagExecutionSteps).
        throw new Error(`Atomic batch group cannot contain a ${member.type} step`);
      }
    }
    return built;
  };

  const builtCalls = await buildMemberCalls();
  const allCalls = builtCalls.flatMap((entry) => entry.calls);

  const hooks = buildStepSendHooks(first, state, opts);
  if (execution.via === "safe") {
    // A stale Safe proposal (co-signers took hours) can be replaced with
    // freshly-quoted calldata; smart bundles quote-and-send immediately.
    hooks.safe.rebuildCalls = async () => (await buildMemberCalls()).flatMap((entry) => entry.calls);
  }
  const sendCalls = prepareStepSendCalls(walletClient, first, state, hooks);
  const [transactionHash, logs] = await sendCalls(
    "batch",
    chainId,
    batchWallet,
    allCalls,
    "atomic-steps",
    first.retryHints,
  );
  const flatLogs = logs.flat() as unknown as Log[];

  // Attribute swap outputs: exact per distinct (output token, recipient)
  // pair, proportional among swap members that share one. A batched transfer
  // may deliver the SAME token to the SAME recipient as the swaps (e.g.
  // claimed USDC transferred out alongside DAI→USDC swaps paying the
  // destination directly) — its known amount is subtracted from the derived
  // total so it isn't double-counted as swap output.
  const swapAmounts = new Map<string, bigint>();
  const byTarget = new Map<string, TransactionStep[]>();
  const targetKey = (member: TransactionStep) =>
    `${member.outputToken.token.toLowerCase()}:${member.outputToken.walletAddress.toLowerCase()}`;
  for (const member of members) {
    if (member.type !== "swap") continue;
    byTarget.set(targetKey(member), [...(byTarget.get(targetKey(member)) ?? []), member]);
  }
  const transferredByTarget = new Map<string, bigint>();
  for (const member of members) {
    if (member.type !== "transfer") continue;
    const key = targetKey(member);
    const amount = member.inputTokens.reduce((sum, t) => sum + t.amount, 0n);
    transferredByTarget.set(key, (transferredByTarget.get(key) ?? 0n) + amount);
  }
  for (const [key, targetMembers] of byTarget) {
    const derived = deriveSwapOutputAmount(flatLogs, targetMembers[0].outputToken);
    const transferred = transferredByTarget.get(key) ?? 0n;
    const plannedSum = targetMembers.reduce((sum, member) => sum + member.outputToken.amount, 0n);
    // With real logs the derived total always CONTAINS the transferred amount
    // (both landed at the same recipient), so derived <= transferred can only
    // mean deriveSwapOutputAmount hit its no-logs fallback (quoted amount of
    // one member) — attribute the planned outputs instead of clamping to 0.
    const total = derived > transferred ? derived - transferred : plannedSum;
    let assigned = 0n;
    targetMembers.forEach((member, index) => {
      const share =
        index === targetMembers.length - 1
          ? total - assigned
          : plannedSum > 0n
            ? (total * member.outputToken.amount) / plannedSum
            : 0n;
      assigned += share;
      swapAmounts.set(member.id, share);
    });
  }

  return members.map((member) => {
    const amount =
      member.type === "swap"
        ? (swapAmounts.get(member.id) ?? member.outputToken.amount)
        : member.inputTokens.reduce((sum, t) => sum + t.amount, 0n);
    return {
      stepId: member.id,
      status: "success" as const,
      chainId,
      actualOutput: { ...member.outputToken, amount, provenance: member.id },
      transactionHash,
    };
  });
}

/**
 * Builds the smart-account-path hooks for one step (see also
 * {@link buildStepSendHooks}): mid-step bundle persistence goes through
 * `state.metadata.smart.bundles[batchId]` and is pushed out immediately via
 * `onInterimState` — the bundle id surviving a tab close is the entire
 * reconcile story for wallet-scoped EIP-5792 ids.
 */
function buildSmartStepHooks(step: TransactionStep, state: ConsolidationState, opts?: ExecuteOptions): SmartStepHooks {
  const batchId = step.execution?.batchId ?? step.id;
  const stepIds = state.plan
    .filter((planStep) => step.execution && planStep.execution?.batchId === step.execution.batchId)
    .map((planStep) => planStep.id);

  return {
    getBundle: () => state.metadata?.smart?.bundles?.[batchId],
    persistBundle: (record: SendCallsBundleRecord) => {
      state.metadata = {
        ...state.metadata,
        smart: { bundles: { ...state.metadata?.smart?.bundles, [batchId]: record } },
      };
      opts?.onInterimState?.(structuredClone(state));
    },
    onProgress: (event) =>
      opts?.onStepProgress?.({
        kind: "smart",
        stepId: step.id,
        stepIds: stepIds.length > 0 ? stepIds : [step.id],
        ...event,
      }),
  };
}

/**
 * Builds the account-kind router hooks for one step: Safe proposal
 * persistence goes through `state.metadata.safe.proposals[batchId]` (mutating
 * the executor's working state — the generator is suspended awaiting this
 * step, so there's a single writer) and is pushed out immediately via
 * `onInterimState` so a pending proposal survives a tab close. Quote-bearing
 * Safe steps also get `rebuildCalls` so a proposal that went stale during a
 * long co-signer wait can be replaced with freshly-quoted calldata (smart
 * bundles quote-and-send immediately — no stale-proposal problem).
 */
function buildStepSendHooks(step: TransactionStep, state: ConsolidationState, opts?: ExecuteOptions): StepSendHooks {
  const batchId = step.execution?.batchId ?? step.id;
  const stepIds = state.plan
    .filter((planStep) => step.execution && planStep.execution?.batchId === step.execution.batchId)
    .map((planStep) => planStep.id);

  const safe: SafeStepHooks = {
    getProposal: () => state.metadata?.safe?.proposals?.[batchId],
    persistProposal: (record: SafeProposalRecord) => {
      state.metadata = {
        ...state.metadata,
        safe: { proposals: { ...state.metadata?.safe?.proposals, [batchId]: record } },
      };
      opts?.onInterimState?.(structuredClone(state));
    },
    onProgress: (event) =>
      opts?.onStepProgress?.({
        kind: "safe",
        stepId: step.id,
        stepIds: stepIds.length > 0 ? stepIds : [step.id],
        ...event,
      }),
    ...(step.type === "swap"
      ? {
          rebuildCalls: async () => {
            const { calls } = await buildDeloraCalls(
              step.inputTokens.filter((t) => t.amount > 0n),
              step.outputToken,
            );
            return calls;
          },
        }
      : {}),
  };

  return { safe, smart: buildSmartStepHooks(step, state, opts) };
}

async function executeStep(
  step: TransactionStep,
  state: ConsolidationState,
  walletClient: WalletClient<HttpTransport, Chain, Account>,
  opts?: ExecuteOptions,
): Promise<StepResult> {
  // Account-kind router: calls from the step's Safe execute as one Safe
  // transaction (batched, proposed, co-signed as needed); calls from an
  // ERC-4337 smart wallet go out as EIP-5792 bundles; every other sender
  // takes the untouched EOA path. Plain-EOA steps never diverge from the
  // pre-Safe behavior.
  const sendCalls = prepareStepSendCalls(walletClient, step, state, buildStepSendHooks(step, state, opts));

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

      // Execute swap using Delora with non-zero tokens
      const { amount: actualAmount, transactionHash } = await executeDeloraSwap(
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

      // Execute CCTP mint. When the recipient is a Safe, the owner EOA
      // submits it directly — receiveMessage is permissionless and the mint
      // credits `mintRecipient` regardless of the sender, so co-signers are
      // never bothered for claims.
      const mintSender = isSafeWallet(state, step.outputToken.walletAddress) ? walletClient.account.address : undefined;
      const [mintTx] = await executeCCTPMint(attestations, step.outputToken, sendCalls, step.retryHints, mintSender);

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

      // Get fresh refuel quotes (Gas.zip, Delora fallback) only for
      // cross-chain destinations — target-output quoting so cross-token pairs
      // like ETH→POL are priced correctly.
      const quotes = await Promise.all(
        crossChainDests.map((dest) =>
          getGasRefuelQuote(sourceChainId, dest.chainId, BigInt(dest.amountWei), sourceAddress, dest.address),
        ),
      );

      const txClient = walletClient;
      try {
        await txClient.switchChain({ id: sourceChainId });
      } catch {
        await txClient.addChain({ chain: sourceChain });
      }

      // A smart-wallet source must send through the account-kind router
      // (EIP-5792 bundles): a raw eth_sendTransaction to a 4337 wallet may
      // return a userOp hash that no receipt wait ever resolves. In an
      // all-smart plan the smart account is the only possible refuel source,
      // so this is required, not cosmetic.
      const sourceIsSmart = isSmartAccount(toAccountsMap(state.accounts), sourceAddress);

      const gasRefuels: GasRefuelRecord[] = [];
      let totalValue = 0n;
      let firstTxHash: Hex | undefined;

      // Same-chain destinations: simple native value transfers
      for (const dest of sameChainDests) {
        const value = BigInt(dest.amountWei);
        totalValue += value;

        let hash: string;
        if (sourceIsSmart) {
          [hash] = await sendCalls("gas-topup", sourceChainId, sourceAddress, [
            { to: dest.address, data: "0x" as Hex, value },
          ]);
        } else {
          hash = await txClient.sendTransaction({
            account: sourceAddress,
            to: dest.address,
            data: "0x" as Hex,
            value,
            chain: sourceChain,
          });
          const receipt = await waitForTransactionReceipt(txClient, { hash: hash as Hex });
          if (receipt.status !== "success") {
            throw new Error("Gas top-up transaction reverted");
          }
        }

        firstTxHash ??= hash as Hex;
      }

      // Cross-chain destinations: send each refuel deposit individually so the
      // delivery wait can track them per destination.
      for (let i = 0; i < quotes.length; i++) {
        const quote = quotes[i];
        const dest = crossChainDests[i];
        const value = quote.tx.value;
        totalValue += value;

        // Record the destination's balance BEFORE depositing: the wait step
        // confirms delivery when the balance clears baseline + minDelivered,
        // independent of any provider status API.
        const destChain = chains[dest.chainId as keyof typeof chains] as Chain;
        const baseline = await getNativeBalance(
          destChain,
          dest.address,
          transports?.[dest.chainId as keyof typeof transports],
        );

        let hash: string;
        if (sourceIsSmart) {
          [hash] = await sendCalls("gas-topup", sourceChainId, sourceAddress, [
            { to: quote.tx.to, data: quote.tx.data, value },
          ]);
        } else {
          let gas: bigint | undefined;
          try {
            const estimated = await estimateGas(txClient, {
              account: sourceAddress,
              to: quote.tx.to,
              data: quote.tx.data,
              value,
            });
            gas = (estimated * 120n) / 100n;
          } catch {
            gas = undefined;
          }

          hash = await txClient.sendTransaction({
            account: sourceAddress,
            to: quote.tx.to,
            data: quote.tx.data,
            value,
            gas,
            chain: sourceChain,
          });

          const receipt = await waitForTransactionReceipt(txClient, { hash: hash as Hex });
          if (receipt.status !== "success") {
            throw new Error("Gas top-up transaction reverted");
          }
        }

        firstTxHash ??= hash as Hex;
        gasRefuels.push({
          provider: quote.provider,
          txHash: hash,
          fromChainId: sourceChainId,
          toChainId: dest.chainId,
          toAddress: dest.address,
          baselineWei: baseline.toString(),
          minDeliveredWei: quote.minDeliveredWei.toString(),
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
        metadataPatch: { gasRefuels },
      };
    }

    case "shield": {
      // Deposit the consolidated ERC20 into Railgun for the 0zk recipient.
      const railgunAddress = step.railgunAddress ?? state.destinationToken.railgunAddress;
      if (!railgunAddress) {
        throw new Error("Shield step is missing the Railgun (0zk) destination address");
      }

      const nonZeroTokens = filterZeroAmounts(step.inputTokens, step.id, "shield");

      // All inputs must be the same ERC20 held by the same wallet on this chain.
      const first = nonZeroTokens[0];
      for (const token of nonZeroTokens) {
        if (
          !isAddressEqual(token.token, first.token) ||
          token.chainId !== first.chainId ||
          !isAddressEqual(token.walletAddress, first.walletAddress)
        ) {
          throw new Error(`Cannot combine heterogeneous input tokens for shield step ${step.id}`);
        }
      }
      if (isAddressEqual(first.token, zeroAddress)) {
        throw new Error("Native coins cannot be shielded into Railgun");
      }

      await validateInputBalances(step, state);

      const totalAmount = nonZeroTokens.reduce((sum, t) => sum + t.amount, 0n);
      const combinedInput = { ...first, amount: totalAmount };

      // Lazy import keeps the shield crypto (noble/poseidon) out of the main chunk.
      const { deriveShieldPrivateKey, executeRailgunShield, randomShieldPrivateKey } = await import("./railgun-shield");
      // The shield private key is an ephemeral ENCRYPTION key (its public
      // half travels with the note), so it need not come from the wallet
      // holding the funds. EOAs keep the Railgun SDK convention (sign as the
      // depositor — re-derivable sender history); a Safe's key derives from
      // the connected owner EOA's signature (the Safe still sends the tx);
      // smart wallets get a random key (no session EOA; 4337 personal_sign is
      // non-deterministic for passkeys and would cost an extra popup).
      const depositorKind = accountFor(toAccountsMap(state.accounts), first.walletAddress).kind;
      const shieldPrivateKey =
        depositorKind === "smart"
          ? randomShieldPrivateKey()
          : await deriveShieldPrivateKey(
              walletClient,
              depositorKind === "safe" ? walletClient.account.address : first.walletAddress,
            );
      const [transactionHash, shieldedAmount] = await executeRailgunShield(
        combinedInput,
        railgunAddress,
        shieldPrivateKey,
        sendCalls,
        step.retryHints,
      );

      return {
        stepId: step.id,
        status: "success",
        chainId: step.chainId,
        actualOutput: {
          ...step.outputToken,
          amount: shieldedAmount,
          provenance: step.id,
        },
        transactionHash,
      };
    }

    case "gnosis-bridge": {
      // Validate all input tokens are homogeneous before combining (same
      // token/chain/wallet — mirrors the CCTP bridge case).
      const first = step.inputTokens[0];
      for (const token of step.inputTokens) {
        if (
          !isAddressEqual(token.token, first.token) ||
          token.chainId !== first.chainId ||
          !isAddressEqual(token.walletAddress, first.walletAddress)
        ) {
          throw new Error(`Cannot combine heterogeneous input tokens for gnosis-bridge step ${step.id}`);
        }
      }

      const nonZeroTokens = filterZeroAmounts(step.inputTokens, step.id, "gnosis-bridge");
      const totalAmount = nonZeroTokens.reduce((sum, t) => sum + t.amount, 0n);
      const combinedInput = { ...nonZeroTokens[0], amount: totalAmount };

      await validateInputBalances(step, state);

      if (step.chainId === gnosis.id) {
        // Egress: relay the token into the home Omnibridge (USDC.e is first
        // unwrapped through the transmuter).
        const [bridgeTx] = await executeOmnibridgeBurn(combinedInput, step.outputToken, sendCalls, step.retryHints);
        return {
          stepId: step.id,
          status: "success",
          chainId: step.chainId,
          actualOutput: { ...step.outputToken, amount: totalAmount, provenance: step.id },
          transactionHash: bridgeTx,
        };
      }

      // Ingress: deposit the mainnet token into the foreign Omnibridge (USDC
      // routes through the transmuter); persist the delivery record (with
      // pre-deposit baseline) for the wait step.
      const [depositTx, delivery] = await executeOmnibridgeDeposit(
        combinedInput,
        step.outputToken,
        sendCalls,
        step.retryHints,
      );
      return {
        stepId: step.id,
        status: "success",
        chainId: step.chainId,
        actualOutput: { ...step.outputToken, amount: totalAmount, provenance: step.id },
        transactionHash: depositTx,
        metadataPatch: {
          omnibridge: {
            ...state.metadata?.omnibridge,
            deliveries: [...(state.metadata?.omnibridge?.deliveries ?? []), delivery],
          },
        },
      };
    }

    case "gnosis-wait": {
      if (step.chainId === mainnet.id) {
        // Egress: wait for the home AMB validators to sign the bridge
        // messages, then persist the signed claims for the gnosis-claim step.
        const bridgeStepIds = getProvenanceSteps(step);
        const bridgeTxs = Array.from(bridgeStepIds)
          .map((stepId) => state.results[stepId]?.transactionHash)
          .filter((tx): tx is string => !!tx);

        if (bridgeTxs.length === 0) {
          throw new Error("No Omnibridge transactions found for signature collection");
        }

        const claims = await retrieveOmnibridgeClaims(bridgeTxs, undefined, (ready, total) =>
          opts?.onStepProgress?.({ kind: "omnibridge", stepId: step.id, direction: "exit", ready, total }),
        );

        const actualAmount = claims.reduce((sum, claim) => sum + BigInt(claim.amount), 0n);
        return {
          stepId: step.id,
          status: "success",
          chainId: step.chainId,
          actualOutput: { ...step.outputToken, amount: actualAmount, provenance: step.id },
          metadataPatch: { omnibridge: { ...state.metadata?.omnibridge, claims } },
        };
      }

      // Ingress: watch each receiver's bridged-token balance on Gnosis until
      // the validators mint the deposits (no claim transaction exists). The
      // deliveries bucket is shared by every ingress leg, so restrict to the
      // records produced by THIS step's own bridge transactions — a mixed
      // plan runs one wait per bridged token (USDC.e + the direct-route
      // token). An empty match falls back to the whole bucket so plans
      // reconciled without step results still complete.
      const allDeliveries = state.metadata?.omnibridge?.deliveries ?? [];
      const ownBridgeTxs = new Set(
        Array.from(getProvenanceSteps(step))
          .map((stepId) => state.results[stepId]?.transactionHash)
          .filter((tx): tx is string => !!tx),
      );
      const ownDeliveries = allDeliveries.filter((d) => ownBridgeTxs.has(d.txHash));
      const deliveries = ownDeliveries.length > 0 ? ownDeliveries : allDeliveries;
      if (deliveries.length === 0) {
        throw new Error("No Omnibridge deposits found to wait for");
      }

      await waitForOmnibridgeDelivery(deliveries, undefined, (ready, total) =>
        opts?.onStepProgress?.({ kind: "omnibridge", stepId: step.id, direction: "enter", ready, total }),
      );

      const deliveredAmount = deliveries.reduce((sum, d) => sum + BigInt(d.minDeliveredUnits), 0n);
      return {
        stepId: step.id,
        status: "success",
        chainId: step.chainId,
        actualOutput: { ...step.outputToken, amount: deliveredAmount, provenance: step.id },
      };
    }

    case "gnosis-claim": {
      const claims = state.metadata?.omnibridge?.claims;
      if (!claims || claims.length === 0) {
        throw new Error("No Omnibridge claims found");
      }

      // executeSignatures on the mainnet AMB; already-relayed messages are
      // filtered inside, so retries are safe. Safe receivers get the claim
      // submitted by the owner EOA — it's permissionless, same as CCTP mint.
      const omniClaimSender = isSafeWallet(state, step.outputToken.walletAddress)
        ? walletClient.account.address
        : undefined;
      const [claimTx] = await executeOmnibridgeClaim(
        claims,
        step.outputToken,
        sendCalls,
        step.retryHints,
        omniClaimSender,
      );

      const actualAmount = claims.reduce((sum, claim) => sum + BigInt(claim.amount), 0n);
      return {
        stepId: step.id,
        status: "success",
        chainId: step.chainId,
        actualOutput: { ...step.outputToken, amount: actualAmount, provenance: step.id },
        transactionHash: claimTx,
      };
    }

    case "gas-topup-wait": {
      const refuels = state.metadata?.gasRefuels;

      // If all destinations were same-chain, there are no refuels to wait for
      if (refuels && refuels.length > 0) {
        await Promise.all(
          refuels.map((r) =>
            waitForRefuelDelivery(r, undefined, undefined, (delivered) =>
              opts?.onStepProgress?.({
                kind: "refuel",
                stepId: step.id,
                txHash: r.txHash,
                fromChainId: r.fromChainId,
                toChainId: r.toChainId,
                delivered,
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
 *
 * A step is skipped only when EVERY one of its input tokens is unusable — i.e.
 * produced by a failed/skipped step. An input keeps the step alive when it has
 * no provenance (independently-held funds, e.g. USDC already on the chain) or
 * when its provenance step succeeded.
 *
 * This matters when a step combines dependent and independent inputs — e.g. a
 * bridge that carries both a swap's USDC output and USDC the wallet already
 * held. Skipping the swap must NOT skip the bridge; the bridge should still
 * move the independently-held USDC. {@link pruneUnusableInputs} then drops the
 * unusable inputs so the step only processes what actually exists.
 *
 * @param step - Transaction step
 * @param results - Map of step results
 * @returns True if step should be skipped
 */
export function shouldSkipStep(step: TransactionStep, results: Record<string, StepResult>): boolean {
  // No provenance on any input → fully independent funds, never auto-skipped.
  if (getProvenanceSteps(step).size === 0) return false;

  return step.inputTokens.every((input) => {
    if (!input.provenance) return false; // independently-held funds remain usable
    const result = results[input.provenance];
    return result?.status === "failed" || result?.status === "skipped";
  });
}

/**
 * Drops input tokens produced by a failed/skipped step so a partially-fed step
 * executes on only the funds that actually exist. Returns the original step
 * when nothing is pruned (or when pruning would leave no inputs — that case is
 * already handled upstream by {@link shouldSkipStep}, which skips the step).
 */
function pruneUnusableInputs(step: TransactionStep, results: Record<string, StepResult>): TransactionStep {
  const usable = step.inputTokens.filter((input) => {
    if (!input.provenance) return true;
    const result = results[input.provenance];
    return result?.status !== "failed" && result?.status !== "skipped";
  });

  if (usable.length === step.inputTokens.length || usable.length === 0) return step;
  return { ...step, inputTokens: usable as [TokenAmount, ...TokenAmount[]] };
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
    case "gnosis-bridge":
    case "gnosis-wait":
    case "gnosis-claim": {
      // The Omnibridge is fee-free 1:1: every leg outputs the sum of its inputs.
      const totalAmount = updatedInputs.reduce((sum, t) => sum + t.amount, 0n);
      return {
        ...step.outputToken,
        amount: totalAmount,
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
    case "shield": {
      // Shield outputs sum of inputs minus the 0.25% Railgun protocol fee.
      const totalAmount = updatedInputs.reduce((sum, t) => sum + t.amount, 0n);
      return {
        ...step.outputToken,
        amount: totalAmount - (totalAmount * RAILGUN_SHIELD_FEE_BPS) / BPS_DENOMINATOR,
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
