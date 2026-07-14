import type { Account, Address, Call, Chain, Hex, HttpTransport, WalletClient } from "viem";
import { isAddressEqual } from "viem";
import { toAccountsMap } from "./accounts";
import { getSafeTx, proposeSafeTx, type SafeServiceTx } from "./api/safe-transaction-service";
import { abortableSleep } from "./cctp";
import { getPublicClient, retryOnRateLimit } from "./public-client";
import {
  approvedHashSignature,
  buildSafeTx,
  encodeExecTransaction,
  hashSafeTx,
  isOwnerOf,
  readSafeInfo,
  SafeConfirmationTimeoutError,
  SafeNotOwnerError,
  type SafeTxData,
  SafeTxSupersededError,
  signSafeTx,
} from "./safe";
import { prepareSendCalls, SendCallsError, type SendCallsFn, switchChain } from "./send-calls";
import type { ConsolidationState, SafeProposalRecord, SafeStepExecution, TransactionStep } from "./types";

/** How often the confirmation wait polls the Transaction Service. */
const CONFIRMATION_POLL_INTERVAL_MS = 15_000;
/**
 * In-step wait budget before pausing with a recoverable timeout (mirrors the
 * CCTP attestation window). Multi-day co-signer waits work through the pause:
 * the proposal record persists in the plan state, the signatures live in the
 * Safe queue, and retry/resume re-enters the wait with everything intact.
 */
const CONFIRMATION_WAIT_TIMEOUT_MS = 20 * 60 * 1000;

/** Progress signal for the "awaiting co-signers" UI. */
export interface SafeStepProgress {
  phase: "signing" | "proposed" | "confirmations" | "executing";
  confirmed: number;
  threshold: number;
  safeTxHash?: Hex;
  chainId: number;
}

export interface SafeStepHooks {
  /** Reads the persisted proposal for this step's batch group, if any. */
  getProposal: () => SafeProposalRecord | undefined;
  /** Persists the proposal record immediately (mid-step, survives tab close). */
  persistProposal: (record: SafeProposalRecord) => void;
  onProgress?: (event: SafeStepProgress) => void;
  /**
   * Rebuilds the step's calls from fresh quotes. Wired for quote-bearing
   * steps (Delora swaps): when the pending proposal's execTransaction would
   * revert at estimation time (typically its stale `minOutputAmount` floor
   * can no longer be met — the multisig executed hours after quoting), the
   * proposal is superseded by a freshly-quoted replacement at the same Safe
   * nonce. 1/1 Safes execute the replacement immediately; multisigs pause so
   * co-signers can re-confirm.
   */
  rebuildCalls?: () => Promise<Call[]>;
}

/**
 * Wraps {@link prepareSendCalls} with a Safe-aware router: calls whose `from`
 * is the step's Safe execute as ONE Safe transaction (MultiSend-batched,
 * signed by the connected owner, proposed to the Transaction Service when
 * co-signers are needed); every other `from` — including the owner EOA's own
 * claim transactions — goes through the untouched EOA path.
 */
export const prepareStepSendCalls = (
  client: WalletClient<HttpTransport, Chain, Account>,
  step: TransactionStep,
  state: ConsolidationState,
  hooks: SafeStepHooks,
): SendCallsFn => {
  const eoaSend = prepareSendCalls(client);
  const execution = step.execution;
  return async (txId, chainId, from, calls, mode, retryHints) => {
    if (!execution || !isAddressEqual(from, execution.safeAddress)) {
      return eoaSend(txId, chainId, from, calls, mode, retryHints);
    }
    if (!calls?.length) return ["", []];
    return sendCallsViaSafe({
      client,
      eoaSend,
      txId,
      chainId,
      execution,
      stepIds: batchStepIds(state, execution),
      calls,
      hooks,
      retryHints,
      quotedAt: step.quotedAt,
    });
  };
};

/** All plan steps sharing the step's batch group (order preserved). */
function batchStepIds(state: ConsolidationState, execution: SafeStepExecution): string[] {
  const ids = state.plan
    .filter((planStep) => planStep.execution?.batchId === execution.batchId)
    .map((planStep) => planStep.id);
  return ids.length > 0 ? ids : [];
}

/** Reconstructs the SafeTxData persisted on a proposal record. */
function txFromRecord(record: SafeProposalRecord): SafeTxData {
  return {
    to: record.tx.to,
    value: BigInt(record.tx.value),
    data: record.tx.data,
    operation: record.tx.operation,
    safeTxGas: 0n,
    baseGas: 0n,
    gasPrice: 0n,
    gasToken: "0x0000000000000000000000000000000000000000",
    refundReceiver: "0x0000000000000000000000000000000000000000",
    nonce: record.safeNonce,
  };
}

/**
 * Merges service-reported confirmations into the local set. On-chain
 * approvals (approveHash) may come back without signature bytes — the
 * approved-hash sentinel encoding is valid for them regardless of who
 * executes, so it's synthesized.
 */
function mergeConfirmations(
  local: { owner: Address; signature: Hex }[],
  service: SafeServiceTx | null,
): { owner: Address; signature: Hex }[] {
  const byOwner = new Map<string, { owner: Address; signature: Hex }>();
  for (const confirmation of local) byOwner.set(confirmation.owner.toLowerCase(), confirmation);
  for (const confirmation of service?.confirmations ?? []) {
    const key = confirmation.owner.toLowerCase();
    if (byOwner.has(key)) continue;
    byOwner.set(key, {
      owner: confirmation.owner,
      signature: confirmation.signature ?? approvedHashSignature(confirmation.owner),
    });
  }
  return [...byOwner.values()];
}

/**
 * The executing owner's own confirmation must be the approved-hash sentinel
 * ONLY when they are the execTransaction sender; a persisted sentinel from a
 * previous session's owner is invalid if a different owner executes now.
 */
function isForeignApprovedHash(confirmation: { owner: Address; signature: Hex }, executor: Address): boolean {
  return (
    confirmation.signature.toLowerCase().endsWith("01") &&
    confirmation.signature.toLowerCase().includes(confirmation.owner.toLowerCase().slice(2)) &&
    !isAddressEqual(confirmation.owner, executor)
  );
}

async function readSafeNonce(chainId: number, safe: Address): Promise<number> {
  const info = await readSafeInfo(chainId, safe);
  return info.nonce;
}

interface SafeSendContext {
  client: WalletClient<HttpTransport, Chain, Account>;
  eoaSend: SendCallsFn;
  txId: string;
  chainId: number;
  execution: SafeStepExecution;
  stepIds: string[];
  calls: Call[];
  hooks: SafeStepHooks;
  retryHints?: Parameters<SendCallsFn>[5];
  quotedAt?: number;
  /** Set on the one allowed refresh attempt to prevent rebuild loops. */
  isRefreshAttempt?: boolean;
}

/**
 * The Safe submission state machine:
 *
 * RESUME  — a persisted non-terminal proposal reconciles against the service
 *           (executed elsewhere → done; nonce consumed → superseded) or
 *           re-enters AWAIT/EXEC with its stored signatures.
 * BUILD   — on-chain owners/threshold/nonce are the source of truth.
 * SIGN    — threshold met by the executor alone: approved-hash sentinel, no
 *           popup, no service round-trip. Otherwise: EIP-712 signTypedData.
 * PROPOSE — POST to the Transaction Service; the record persists BEFORE any
 *           waiting so a tab close never loses the proposal.
 * AWAIT   — poll confirmations; executed-by-someone-else and nonce
 *           supersession are detected here; 20 min → recoverable pause.
 * EXEC    — optional revalidate (quote staleness), then execTransaction goes
 *           out as ONE plain EOA call through the existing hardened
 *           send-calls machinery (nonce mgmt, fee bump, watchdog).
 */
async function sendCallsViaSafe(
  context: SafeSendContext,
): Promise<[string, { address: Address; data: Hex; topics: Hex[] }[][]]> {
  const { client, chainId, execution, hooks } = context;
  const safe = execution.safeAddress;
  const executor = client.account.address;

  // RESUME: a prior attempt left a live proposal for this batch.
  const existing = hooks.getProposal();
  if (existing && existing.status !== "superseded") {
    const resumed = await reconcileProposal(context, existing);
    if (resumed) return resumed;
    // reconcileProposal persisted a superseded record — fall through to BUILD.
  }

  // BUILD — verify against the chain, never against a discovery snapshot.
  await switchChain(client, chainId);
  const info = await readSafeInfo(chainId, safe);
  if (!isOwnerOf(info, executor)) {
    throw new SafeNotOwnerError(executor, safe, chainId);
  }

  const safeTx = buildSafeTx(context.calls, info.nonce, info.version);
  const safeTxHash = hashSafeTx(chainId, safe, safeTx);
  const record: SafeProposalRecord = {
    chainId,
    safeAddress: safe,
    stepIds: context.stepIds,
    safeTxHash,
    safeNonce: info.nonce,
    tx: { to: safeTx.to, value: safeTx.value.toString(), data: safeTx.data, operation: safeTx.operation },
    threshold: info.threshold,
    confirmations: [],
    executor,
    proposedAt: Date.now(),
    quotedAt: context.quotedAt,
    status: "proposed",
  };

  if (info.threshold === 1) {
    // 1/1 fast path: msg.sender == owner validates the approved-hash sentinel,
    // so no signature popup and no Transaction Service dependency at all.
    record.confirmations = [{ owner: executor, signature: approvedHashSignature(executor) }];
    return executeSafeTx(context, record);
  }

  // SIGN + PROPOSE
  hooks.onProgress?.({ phase: "signing", confirmed: 0, threshold: info.threshold, chainId });
  const signature = await signSafeTx(client, chainId, safe, safeTx);
  record.confirmations = [{ owner: executor, signature }];
  await proposeSafeTx(chainId, safe, {
    to: safeTx.to,
    value: safeTx.value.toString(),
    data: safeTx.data,
    operation: safeTx.operation,
    safeTxGas: "0",
    baseGas: "0",
    gasPrice: "0",
    gasToken: "0x0000000000000000000000000000000000000000",
    refundReceiver: "0x0000000000000000000000000000000000000000",
    nonce: info.nonce,
    contractTransactionHash: safeTxHash,
    sender: executor,
    signature,
    origin: JSON.stringify({ name: "octo.cash", url: "https://octo.cash" }),
  });
  hooks.persistProposal({ ...record });
  hooks.onProgress?.({ phase: "proposed", confirmed: 1, threshold: info.threshold, safeTxHash, chainId });

  return awaitConfirmationsAndExecute(context, record);
}

/**
 * Reconciles a persisted proposal against the service + chain. Returns the
 * final result when the transaction was already executed, null when the
 * record was superseded (caller rebuilds fresh), or continues into
 * AWAIT/EXEC.
 */
async function reconcileProposal(
  context: SafeSendContext,
  record: SafeProposalRecord,
): Promise<[string, { address: Address; data: Hex; topics: Hex[] }[][]] | null> {
  const { chainId, execution, hooks } = context;
  const executor = context.client.account.address;

  let service: SafeServiceTx | null = null;
  try {
    service = await getSafeTx(chainId, record.safeTxHash);
  } catch {
    // Service unreachable — the on-chain nonce probe below still decides.
  }

  if (service?.isExecuted) {
    return settleExecutedElsewhere(context, record, service);
  }

  let onChainNonce: number;
  try {
    onChainNonce = await readSafeNonce(chainId, execution.safeAddress);
  } catch {
    // Can't read the chain — keep waiting on the existing record; the next
    // poll (or resume) probes again.
    onChainNonce = record.safeNonce;
  }
  if (onChainNonce > record.safeNonce) {
    // The nonce was consumed by something that isn't our safeTxHash: an
    // on-chain rejection or a competing queued transaction won the slot.
    hooks.persistProposal({ ...record, status: "superseded" });
    throw new SafeTxSupersededError(record.safeTxHash, "its Safe nonce was consumed by another transaction");
  }

  // A 1/1 record whose approved-hash sentinel belongs to a different owner
  // than the currently connected one can't be executed by us — rebuild.
  const usable = record.confirmations.filter((confirmation) => !isForeignApprovedHash(confirmation, executor));
  if (usable.length === 0 && record.confirmations.length > 0 && record.threshold === 1) {
    hooks.persistProposal({ ...record, status: "superseded" });
    return null;
  }

  return awaitConfirmationsAndExecute(context, { ...record, confirmations: usable, executor });
}

/** Fetches the receipt of a proposal someone else executed and settles from it. */
async function settleExecutedElsewhere(
  context: SafeSendContext,
  record: SafeProposalRecord,
  service: SafeServiceTx,
): Promise<[string, { address: Address; data: Hex; topics: Hex[] }[][]]> {
  const { chainId, hooks } = context;
  const executedHash = service.transactionHash;
  if (service.isSuccessful === false) {
    hooks.persistProposal({ ...record, status: "superseded", executedTxHash: executedHash ?? undefined });
    throw new SendCallsError(`Safe transaction ${record.safeTxHash} was executed but its inner call failed`, {
      transactionHash: executedHash ?? undefined,
    });
  }
  if (!executedHash) {
    // Executed per the service but no hash yet (indexing lag) — treat as
    // still pending; the AWAIT loop will pick it up.
    return awaitConfirmationsAndExecute(context, record);
  }
  const receipt = await retryOnRateLimit(() => getPublicClient(chainId).getTransactionReceipt({ hash: executedHash }));
  if (receipt.status !== "success") {
    hooks.persistProposal({ ...record, status: "superseded", executedTxHash: executedHash });
    throw new SendCallsError(`Safe transaction ${record.safeTxHash} execution reverted on-chain`, {
      transactionHash: executedHash,
    });
  }
  hooks.persistProposal({ ...record, status: "executed", executedTxHash: executedHash });
  const logs = (receipt.logs ?? []) as { address: Address; data: Hex; topics: Hex[] }[];
  return [executedHash, [logs]];
}

/** AWAIT: poll the service until threshold is met, then EXEC. */
async function awaitConfirmationsAndExecute(
  context: SafeSendContext,
  record: SafeProposalRecord,
): Promise<[string, { address: Address; data: Hex; topics: Hex[] }[][]]> {
  const { chainId, execution, hooks } = context;
  let confirmations = record.confirmations;
  let threshold = record.threshold;
  const deadline = Date.now() + CONFIRMATION_WAIT_TIMEOUT_MS;

  while (confirmations.length < threshold) {
    let service: SafeServiceTx | null = null;
    try {
      service = await getSafeTx(chainId, record.safeTxHash);
    } catch {
      // Poll errors are swallowed (like the attestation poll) — keep waiting.
    }

    if (service?.isExecuted) {
      return settleExecutedElsewhere(context, { ...record, confirmations }, service);
    }
    if (service?.confirmationsRequired) threshold = service.confirmationsRequired;

    confirmations = mergeConfirmations(confirmations, service);
    hooks.onProgress?.({
      phase: "confirmations",
      confirmed: confirmations.length,
      threshold,
      safeTxHash: record.safeTxHash,
      chainId,
    });
    if (confirmations.length >= threshold) break;

    try {
      const onChainNonce = await readSafeNonce(chainId, execution.safeAddress);
      if (onChainNonce > record.safeNonce) {
        hooks.persistProposal({ ...record, confirmations, status: "superseded" });
        throw new SafeTxSupersededError(record.safeTxHash, "a co-signer rejected or replaced it in the Safe");
      }
    } catch (error) {
      if (error instanceof SafeTxSupersededError) throw error;
      // Chain probe failed — keep waiting.
    }

    if (Date.now() >= deadline) {
      hooks.persistProposal({ ...record, confirmations });
      throw new SafeConfirmationTimeoutError(record.safeTxHash, confirmations.length, threshold);
    }
    await abortableSleep(CONFIRMATION_POLL_INTERVAL_MS);
  }

  return executeSafeTx(context, { ...record, confirmations, threshold });
}

/** EXEC: submit execTransaction from the owner EOA. */
async function executeSafeTx(
  context: SafeSendContext,
  record: SafeProposalRecord,
): Promise<[string, { address: Address; data: Hex; topics: Hex[] }[][]]> {
  const { client, eoaSend, txId, chainId, execution, hooks } = context;
  const executor = client.account.address;

  const execCall: Call = {
    to: execution.safeAddress,
    data: encodeExecTransaction(txFromRecord(record), record.confirmations),
  };

  hooks.persistProposal({ ...record, status: "executing", executor });
  hooks.onProgress?.({
    phase: "executing",
    confirmed: record.confirmations.length,
    threshold: record.threshold,
    safeTxHash: record.safeTxHash,
    chainId,
  });

  try {
    const [hash, logs] = await eoaSend(txId, chainId, executor, [execCall], "atomic-steps", context.retryHints);
    hooks.persistProposal({ ...record, status: "executed", executor, executedTxHash: hash as Hex });
    return [hash, logs];
  } catch (error) {
    // A revert here means the exact proposal can no longer execute. Probe the
    // nonce first: an advanced nonce means a competing/rejection tx won the
    // slot. Otherwise, for quote-bearing steps, the usual culprit is a stale
    // `minOutputAmount` floor after a long co-signer wait — refresh the
    // proposal with fresh quotes at the same nonce.
    try {
      const onChainNonce = await readSafeNonce(chainId, execution.safeAddress);
      if (onChainNonce > record.safeNonce) {
        hooks.persistProposal({ ...record, status: "superseded" });
        throw new SafeTxSupersededError(record.safeTxHash, "its Safe nonce advanced before our execution landed");
      }
    } catch (probeError) {
      if (probeError instanceof SafeTxSupersededError) throw probeError;
    }

    const isEstimateRevert = error instanceof SendCallsError && /would revert/i.test(error.message);
    if (isEstimateRevert && hooks.rebuildCalls && !context.isRefreshAttempt) {
      return refreshProposal(context, record);
    }
    throw error;
  }
}

/**
 * Supersedes a proposal whose execTransaction would revert (stale quote
 * floor, invalidated signatures) with a freshly-built replacement at the same
 * Safe nonce — proposing at the same nonce IS the cancellation mechanism.
 * 1/1 Safes execute the replacement immediately (the step's pre-execution
 * quote refresh already got user consent for the new baseline); multisigs
 * persist the replacement and pause so co-signers re-confirm.
 */
async function refreshProposal(
  context: SafeSendContext,
  staleRecord: SafeProposalRecord,
): Promise<[string, { address: Address; data: Hex; topics: Hex[] }[][]]> {
  const { client, chainId, execution, hooks } = context;
  const safe = execution.safeAddress;
  const executor = client.account.address;
  // biome-ignore lint/style/noNonNullAssertion: caller gates on hooks.rebuildCalls
  const calls = await hooks.rebuildCalls!();

  const info = await readSafeInfo(chainId, safe);
  const safeTx = buildSafeTx(calls, info.nonce, info.version);
  const safeTxHash = hashSafeTx(chainId, safe, safeTx);
  const record: SafeProposalRecord = {
    ...staleRecord,
    safeTxHash,
    safeNonce: info.nonce,
    tx: { to: safeTx.to, value: safeTx.value.toString(), data: safeTx.data, operation: safeTx.operation },
    threshold: info.threshold,
    executor,
    proposedAt: Date.now(),
    quotedAt: Date.now(),
    status: "proposed",
  };

  if (info.threshold === 1) {
    record.confirmations = [{ owner: executor, signature: approvedHashSignature(executor) }];
    return executeSafeTx({ ...context, isRefreshAttempt: true }, record);
  }

  const signature = await signSafeTx(client, chainId, safe, safeTx);
  record.confirmations = [{ owner: executor, signature }];
  await proposeSafeTx(chainId, safe, {
    to: safeTx.to,
    value: safeTx.value.toString(),
    data: safeTx.data,
    operation: safeTx.operation,
    safeTxGas: "0",
    baseGas: "0",
    gasPrice: "0",
    gasToken: "0x0000000000000000000000000000000000000000",
    refundReceiver: "0x0000000000000000000000000000000000000000",
    nonce: info.nonce,
    contractTransactionHash: safeTxHash,
    sender: executor,
    signature,
    origin: JSON.stringify({ name: "octo.cash", url: "https://octo.cash" }),
  });
  hooks.persistProposal(record);
  throw new SafeTxSupersededError(
    staleRecord.safeTxHash,
    "it went stale while waiting for co-signers and was replaced with freshly-quoted calldata at the same nonce — co-signers must confirm the replacement; retry to continue waiting",
  );
}

/** True when `wallet` is a Safe in the plan's account snapshot. */
export function isSafeWallet(state: ConsolidationState, wallet: Address): boolean {
  const account = toAccountsMap(state.accounts).get(wallet.toLowerCase());
  return account?.kind === "safe";
}
