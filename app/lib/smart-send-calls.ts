import type { Account, Address, Call, Chain, Hex, HttpTransport, WalletClient } from "viem";
import { getPublicClient, retryOnRateLimit } from "./public-client";
import {
  type BundleHooks,
  encodeMulticall3Call,
  SendCallsError,
  type SendCallsMode,
  sendCallsBundle,
  switchChain,
} from "./send-calls";
import type { SendCallsBundleRecord, SmartStepExecution } from "./types";

/** Progress signal for the smart-wallet submission UI. */
export interface SmartStepProgress {
  phase: "sending" | "confirming";
  chainId: number;
  bundleId?: string;
  /** Sub-call position in sequential (non-atomic) mode. */
  call?: { index: number; total: number };
}

export interface SmartStepHooks {
  /** Reads the persisted bundle record for this step's batch group, if any. */
  getBundle: () => SendCallsBundleRecord | undefined;
  /** Persists the record immediately (mid-step, survives tab close). */
  persistBundle: (record: SendCallsBundleRecord) => void;
  onProgress?: (event: SmartStepProgress) => void;
}

/**
 * Whether the wallet refused `forceAtomic` (EIP-5792 error 5757 or viem's
 * AtomicityNotSupportedError) — the plan-time capability snapshot was stale
 * and the submission degrades to sequential single-call bundles once.
 */
function isAtomicityUnsupported(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth++) {
    const name = (current as { name?: string }).name ?? "";
    const code = (current as { code?: number }).code;
    const message = (current as { message?: string }).message ?? "";
    if (name === "AtomicityNotSupportedError" || code === 5757) return true;
    if (/atomic/i.test(message) && /not.{0,10}support/i.test(message)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

interface SmartSendContext {
  client: WalletClient<HttpTransport, Chain, Account>;
  txId: string;
  chainId: number;
  execution: SmartStepExecution;
  stepIds: string[];
  calls: Call[];
  mode: SendCallsMode | undefined;
  hooks: SmartStepHooks;
}

type Logs = { address: Address; data: Hex; topics: Hex[] }[][];

/** What the RESUME reconciliation decided. */
type ReconcileOutcome =
  | { kind: "done"; result: [string, Logs] }
  | { kind: "resume-at"; index: number } // sequential: calls 0..index-1 already mined
  | { kind: "fresh" }; // prior bundle definitively failed — full fresh attempt

/**
 * The EIP-5792 smart-account submission path. Deliberately much smaller than
 * the Safe state machine: the connected smart wallet signs SYNCHRONOUSLY and
 * submits its own UserOperation — there is no proposal service and no
 * co-signer wait. What remains is transport care:
 *
 * RESUME     — a persisted bundle record reconciles first: confirmed → settle
 *              from its receipt; pending → re-enter the status wait; unknown
 *              id (bundle ids are wallet-scoped; the wallet restarted or a
 *              different one connected) → verify via the persisted tx hash,
 *              else pause recoverably — never blind-resend.
 * ATOMIC     — all calls in one `forceAtomic` bundle; if the wallet refuses
 *              atomicity (stale capability snapshot), degrade once to
 *              SEQUENTIAL.
 * SEQUENTIAL — one single-call bundle per call, record overwritten per
 *              sub-bundle (callIndex), stop on first failure with
 *              per-iteration error scoping.
 */
export async function sendCallsViaSmart(context: SmartSendContext): Promise<[string, Logs]> {
  const { client, chainId, execution, hooks } = context;

  // CCTP mints keep their Multicall3 wrapper: `destinationCaller` was pinned
  // to Multicall3 at burn time, so the smart account must call aggregate3.
  const calls = context.mode === "atomic-multicall" ? [encodeMulticall3Call(context.calls)] : context.calls;

  let startIndex = 0;
  const existing = hooks.getBundle();
  if (existing && existing.chainId === chainId && existing.status !== "failed") {
    const outcome = await reconcileBundle(context, existing, calls.length);
    if (outcome.kind === "done") return outcome.result;
    if (outcome.kind === "resume-at") startIndex = Math.min(outcome.index, calls.length - 1);
  }

  // Several wallets reject wallet_sendCalls whose chainId isn't the active
  // chain, even though the request names it.
  await switchChain(client, chainId);

  if (execution.atomic && startIndex === 0) {
    hooks.onProgress?.({ phase: "sending", chainId });
    try {
      return await sendCallsBundle(client, {
        txId: context.txId,
        chainId,
        from: execution.smartAddress,
        calls,
        forceAtomic: true,
        hooks: bundleHooks(context, undefined),
      });
    } catch (error) {
      if (!isAtomicityUnsupported(error)) throw error;
      // Stale capability snapshot — the wallet can't batch atomically after
      // all. Nothing was accepted, so degrading to sequential is safe.
    }
  }

  return sendSequential(context, calls, startIndex);
}

/** Per-bundle persistence hooks: the record survives BEFORE any waiting. */
function bundleHooks(context: SmartSendContext, callIndex: number | undefined): BundleHooks {
  const base = {
    chainId: context.chainId,
    account: context.execution.smartAddress,
    stepIds: context.stepIds,
    atomic: callIndex === undefined,
    ...(callIndex !== undefined ? { callIndex } : {}),
  };
  return {
    onBundleSent: (id) => {
      context.hooks.persistBundle({ ...base, id, sentAt: Date.now(), status: "sent" });
      context.hooks.onProgress?.({
        phase: "confirming",
        chainId: context.chainId,
        bundleId: id,
        ...(callIndex !== undefined ? { call: { index: callIndex, total: context.calls.length } } : {}),
      });
    },
    onBundleSettled: (id, status, transactionHash) => {
      context.hooks.persistBundle({
        ...base,
        id,
        sentAt: Date.now(),
        status: status === "confirmed" ? "confirmed" : "failed",
        transactionHash,
      });
    },
  };
}

async function sendSequential(context: SmartSendContext, calls: Call[], startIndex: number): Promise<[string, Logs]> {
  const { client, chainId, execution, hooks } = context;
  const allLogs: Logs = [];
  let lastHash = "";

  for (let index = startIndex; index < calls.length; index++) {
    hooks.onProgress?.({ phase: "sending", chainId, call: { index, total: calls.length } });
    // Per-iteration scoping: a thrown error carries only THIS sub-bundle's
    // id/hash — an earlier successful call's identity never bleeds into the
    // failure of a later one (preserves the approve-vs-burn reconcile
    // invariant documented in send-calls.ts).
    const [hash, logs] = await sendCallsBundle(client, {
      txId: context.txId,
      chainId,
      from: execution.smartAddress,
      calls: [calls[index]],
      forceAtomic: false,
      hooks: bundleHooks(context, index),
    });
    allLogs.push(...logs);
    lastHash = hash;
  }

  return [lastHash, allLogs];
}

/**
 * Reconciles a persisted bundle record against the wallet (getCallsStatus)
 * with the persisted transaction hash as the chain-verifiable fallback for
 * wallet-scoped ids the current session can't resolve.
 */
async function reconcileBundle(
  context: SmartSendContext,
  record: SendCallsBundleRecord,
  totalCalls: number,
): Promise<ReconcileOutcome> {
  const { client, hooks } = context;
  const isLastPiece = record.callIndex === undefined || record.callIndex >= totalCalls - 1;

  const settleConfirmed = async (transactionHash: Hex | undefined): Promise<ReconcileOutcome> => {
    hooks.persistBundle({ ...record, status: "confirmed", transactionHash });
    if (!isLastPiece) return { kind: "resume-at", index: (record.callIndex ?? 0) + 1 };
    // The whole submission already executed — settle from its receipt logs.
    if (!transactionHash) return { kind: "fresh" };
    const receipt = await retryOnRateLimit(() =>
      getPublicClient(context.chainId).getTransactionReceipt({ hash: transactionHash }),
    );
    const logs = (receipt.logs ?? []) as unknown as { address: Address; data: Hex; topics: Hex[] }[];
    return { kind: "done", result: [transactionHash, [logs]] };
  };

  // Crash-after-confirm: the record already carries the outcome.
  if (record.status === "confirmed") {
    return settleConfirmed(record.transactionHash);
  }

  try {
    const status = await client.getCallsStatus({ id: record.id });
    if (status.status === "pending") {
      // Re-enter the wait on the same id; success falls through the shared
      // bundle path (settle hooks persist), timeout throws recoverable.
      const result = await sendCallsBundle(client, {
        txId: context.txId,
        chainId: context.chainId,
        from: context.execution.smartAddress,
        calls: [], // unused on the resume path
        forceAtomic: record.atomic,
        hooks: bundleHooks(context, record.callIndex),
        existingBundleId: record.id,
      });
      return isLastPiece ? { kind: "done", result } : { kind: "resume-at", index: (record.callIndex ?? 0) + 1 };
    }

    const receipts = status.receipts ?? [];
    const allSucceeded =
      status.status === "success" && receipts.length > 0 && receipts.every((r) => r.status === "success");
    if (allSucceeded) {
      return settleConfirmed(receipts.at(-1)?.transactionHash as Hex | undefined);
    }
    hooks.persistBundle({ ...record, status: "failed" });
    return record.callIndex !== undefined ? { kind: "resume-at", index: record.callIndex } : { kind: "fresh" };
  } catch {
    // The wallet doesn't know the id (restarted session, different wallet —
    // ids are wallet-scoped). Fall back to the chain-verifiable anchor.
    if (record.transactionHash) {
      try {
        const receipt = await retryOnRateLimit(() =>
          getPublicClient(context.chainId).getTransactionReceipt({ hash: record.transactionHash as Hex }),
        );
        if (receipt.status === "success") return settleConfirmed(record.transactionHash);
        hooks.persistBundle({ ...record, status: "failed" });
        return record.callIndex !== undefined ? { kind: "resume-at", index: record.callIndex } : { kind: "fresh" };
      } catch {
        // Receipt not found either — keep the record, pause recoverably.
      }
    }
    throw new SendCallsError(
      `Cannot verify the previous call bundle ${record.id} — the wallet session changed and no transaction hash is ` +
        `known yet. Check your wallet's activity, then retry (a confirmed bundle will be picked up automatically).`,
      { bundleId: record.id },
    );
  }
}
