import type { Account, Address, Chain, Client, Hex, HttpTransport, PublicClient, WalletClient } from "viem";
import { BaseError } from "viem";
import {
  estimateGas,
  getTransaction,
  getTransactionCount,
  getTransactionReceipt,
  type WaitForTransactionReceiptReturnType,
  type waitForTransactionReceipt,
} from "viem/actions";
import { getPublicClient } from "./public-client";

/**
 * Thrown when the wallet returned a hash but neither the public RPC nor any
 * block produced a receipt within `receiptTimeoutMs`. This can happen when
 * the wallet holds the tx in an internal/relayer pool (e.g. MetaMask Smart
 * Transactions, Rabby's relayer broadcast, etc.) and never propagates it to
 * the public mempool; it can also happen on chains where receipts are
 * genuinely slow. Either way, the cure from the caller's side is the same:
 * either give up or rebroadcast.
 *
 * Carries the canonical hash so the caller can show explorer links and so
 * the UI's resend flow can correlate with the right step.
 */
export class StuckTransactionError extends Error {
  override name = "StuckTransactionError" as const;
  hash: Hex;
  constructor(hash: Hex) {
    super(
      `Transaction may be stuck in the wallet's internal pool (hash=${hash}); the public RPC has not produced a receipt in time.`,
    );
    this.hash = hash;
  }
}

/**
 * Thrown when the on-chain nonce we sent against has been consumed by a
 * transaction we did NOT broadcast — for example, the user signed a separate
 * transfer in MetaMask from the same EOA between the time we sent and the
 * time we waited. Surfacing this as a typed error stops the executor from
 * silently treating that foreign receipt as a successful step result via
 * viem's `(from, nonce)` replacement detection.
 *
 * `foreignHash` is best-effort: we know the slot is taken, but we may not be
 * able to cheaply look up which tx took it, so this can be `undefined`.
 */
export class NonceConsumedByForeignTxError extends Error {
  override name = "NonceConsumedByForeignTxError" as const;
  nonce: number;
  foreignHash: Hex | undefined;
  constructor(nonce: number, foreignHash?: Hex) {
    super(
      `Nonce ${nonce} was consumed by a transaction we did not broadcast${
        foreignHash ? ` (foreign hash=${foreignHash})` : ""
      }; refusing to treat it as our step's result.`,
    );
    this.nonce = nonce;
    this.foreignHash = foreignHash;
  }
}

/** Default thresholds for stall detection / receipt waits. */
export const DEFAULT_RECEIPT_TIMEOUT_MS = 45_000;
export const DEFAULT_STALL_AFTER_MS = 25_000;

/**
 * Discriminator on `StallInfo`: tells the UI which CTA to show, and which
 * code path the lib will take when the user clicks `trigger`.
 *
 * - `"resend"`: the original calldata still simulates successfully (or we
 *   couldn't decide). Clicking `trigger` re-broadcasts the SAME calldata
 *   with the same nonce + bumped fees.
 * - `"retry"`: the original calldata would now revert (e.g. an Odos quote
 *   went stale). Clicking `trigger` invokes the caller-supplied
 *   `rebuildCall(stepIndex)`, then broadcasts the freshly-built calldata
 *   with the same nonce + bumped fees so it replaces (rather than parallels)
 *   the stuck tx.
 */
export type StallKind = "resend" | "retry";

/**
 * Information passed to `onStall` when a sent transaction has not been seen
 * on the public RPC after `stallAfterMs`. The caller (typically the UI) gets
 * a unified `trigger` whose actual behavior is decided by `kind`:
 *
 * - `kind: "resend"` — the original tx still simulates successfully; clicking
 *   `trigger` re-broadcasts the same calldata (same nonce, +12.5% fees).
 * - `kind: "retry"` — the original would now revert; clicking `trigger`
 *   invokes the caller-supplied `rebuildCall` and broadcasts the freshly-
 *   built calldata (same nonce, +12.5% fees).
 *
 * The CTA is one button regardless of kind; the UI only varies the label.
 */
export interface StallInfo {
  /** The `txId` passed to the SendCallsFn invocation (typically the step id). */
  txId: string;
  /** The 0-based index of the call within the batch that is stalled. */
  stepIndex: number;
  /** The hash returned by the wallet for the stalled tx. */
  hash: Hex;
  /**
   * The explicit nonce we sent the tx with, when we successfully fetched
   * one. When `undefined`, the wallet picked the nonce internally and we
   * cannot guarantee that a replacement would replace (rather than
   * parallel-send) the original. The hook uses this to gate the CTA.
   */
  nonce: number | undefined;
  /**
   * Whether the action behind `trigger` is a same-calldata Resend or a
   * rebuild-and-replace Retry. Decided by an `eth_call` simulation of the
   * currently-pending calldata against `blockTag: "latest"`.
   */
  kind: StallKind;
  /**
   * Click handler for the CTA. Idempotent within one stall window
   * (one-shot per stall — a subsequent stall after a replacement will
   * re-fire `onStall` with a fresh trigger).
   *
   * For `kind === "resend"`: same-nonce, gas-bumped replacement of the
   * original calldata.
   *
   * For `kind === "retry"`: invokes `rebuildCall(stepIndex)` to get fresh
   * calldata, then broadcasts a same-nonce, gas-bumped replacement using
   * those new params. No-op if `rebuildCall` returns `null` or is missing.
   */
  trigger: () => void;
}

/**
 * Information passed to `onHashSent` each time the wallet returns a hash for
 * a sent transaction — once for the original send, and once again for each
 * resend (same-nonce, gas-bumped replacement). Used by the caller to persist
 * every in-flight hash for audit/recovery purposes.
 */
export interface HashSentInfo {
  /** The `txId` passed to the SendCallsFn invocation (typically the step id). */
  txId: string;
  /** The 0-based index of the call within the batch. */
  stepIndex: number;
  hash: Hex;
  nonce: number | undefined;
  account: Address;
  chainId: number;
}

export interface SendCallsOptions {
  /**
   * Hard cap for the per-tx receipt wait. After this many milliseconds
   * without a receipt (or a same-nonce replacement landing), the wait
   * rejects with a {@link StuckTransactionError}. Default: 45_000.
   */
  receiptTimeoutMs?: number;
  /**
   * After this many milliseconds without a receipt, if `getTransaction(hash)`
   * is missing on the public RPC, fire `onStall`. Default: 25_000.
   */
  stallAfterMs?: number;
  /** Called once per stalled call (per `(txId, stepIndex)`). */
  onStall?: (info: StallInfo) => void;
  /**
   * Called every time the wallet returns a hash for a sent transaction:
   * once for the original send and once for each resend/retry. Useful for
   * persisting the full attempt history to local storage so it survives
   * a tab close.
   */
  onHashSent?: (info: HashSentInfo) => void;
  /**
   * Caller-supplied callback that returns fresh `{ to, data, value }` for
   * the call at `stepIndex` (same indexing the underlying `SendCallsFn`
   * uses). Invoked by the lib when the user clicks a `kind: "retry"` CTA;
   * the lib then broadcasts the returned call with the original nonce and
   * bumped fees so it replaces the stuck tx in the mempool.
   *
   * Returning `null` means "no useful rebuild available — give up"; the
   * existing receipt-timeout path will eventually surface
   * {@link StuckTransactionError}. When this option is omitted, the lib
   * falls back to `kind: "resend"` even if the simulation reverts.
   */
  rebuildCall?: (stepIndex: number) => Promise<{ to?: Address; data?: Hex; value?: bigint } | null>;
}

export interface SentTxParams {
  account: Address;
  to?: Address;
  data?: Hex;
  value?: bigint;
  chain: Chain;
}

export interface SentTx {
  hash: Hex;
  /** The nonce we used (or undefined if we couldn't fetch it). */
  nonce: number | undefined;
  /** Gas limit we sent with (or undefined if estimation failed). */
  gas: bigint | undefined;
  /** Fees we sent with (or undefined when falling back to wallet defaults). */
  maxFeePerGas: bigint | undefined;
  maxPriorityFeePerGas: bigint | undefined;
}

/**
 * Detects "nonce too low" errors thrown by the wallet/RPC.
 * Walks viem's error cause chain so wrapped errors (TransactionExecutionError ->
 * RpcRequestError -> NonceTooLowError) are correctly recognized.
 */
const isNonceTooLowError = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  if (error instanceof BaseError) {
    const found = error.walk((e) => (e as { name?: string }).name === "NonceTooLowError");
    if (found) return true;
  }
  // Fallback to message inspection (covers RpcError shapes coming from wallet
  // providers that viem hasn't wrapped into NonceTooLowError).
  const msg = (error.message ?? "").toLowerCase();
  return /nonce too low|transaction already imported|already known/.test(msg);
};

/**
 * Fetches the next pending nonce for `account`. Tries the wallet client's
 * own transport first (matches what the wallet's signing path will see, and
 * bypasses any wallet-internal nonce cache by going straight to
 * `eth_getTransactionCount`). On failure, falls back to a public RPC via
 * {@link getPublicClient} to widen the window where we have an explicit
 * nonce; without one, a "resend" cannot guarantee replacement.
 *
 * Returns `undefined` only when both sources fail.
 */
const getNextNonce = async (
  client: Client<HttpTransport, Chain, Account>,
  account: Address,
  chain: Chain,
): Promise<number | undefined> => {
  try {
    return await getTransactionCount(client, { address: account, blockTag: "pending" });
  } catch {
    // Fall through to public RPC.
  }
  try {
    const pub = getPublicClient(chain.id);
    return await getTransactionCount(pub, { address: account, blockTag: "pending" });
  } catch {
    return undefined;
  }
};

/**
 * Estimates gas for a transaction and sends it with a 20% buffer.
 * Also sets explicit maxFeePerGas/maxPriorityFeePerGas for precise cost control.
 * If gas estimation fails, continues without explicit gas limit.
 *
 * Manages the nonce explicitly via `eth_getTransactionCount` against the
 * wallet client's own transport (bypassing any wallet-internal nonce cache),
 * and retries once on "nonce too low" errors with a freshly-fetched nonce.
 * This defends against the race where back-to-back sends (e.g. approve +
 * bridge) reuse the same nonce because the wallet hasn't yet seen the
 * previously-included transaction.
 *
 * Returns the params used so a caller can build a same-nonce replacement
 * (e.g. when resending a stuck tx).
 */
export const estimateAndSendTransaction = async (
  client: WalletClient<HttpTransport, Chain, Account>,
  params: SentTxParams,
): Promise<SentTx> => {
  let gas: bigint | undefined;
  let maxFeePerGas: bigint | undefined;
  let maxPriorityFeePerGas: bigint | undefined;

  try {
    const estimatedGas = await estimateGas(client, {
      account: params.account,
      to: params.to,
      data: params.data,
      value: params.value,
    });
    gas = (estimatedGas * 120n) / 100n;
  } catch {
    gas = undefined;
  }

  try {
    const publicClient = getPublicClient(params.chain.id);
    const fees = await publicClient.estimateFeesPerGas();
    maxFeePerGas = fees.maxFeePerGas ?? undefined;
    maxPriorityFeePerGas = fees.maxPriorityFeePerGas ?? undefined;
  } catch {
    // Fall back to wallet/RPC defaults
  }

  const send = (nonce: number | undefined) =>
    client.sendTransaction({
      account: params.account,
      to: params.to,
      data: params.data,
      value: params.value,
      gas,
      maxFeePerGas,
      maxPriorityFeePerGas,
      nonce,
      chain: params.chain,
    });

  let nonce = await getNextNonce(client, params.account, params.chain);

  try {
    const hash = await send(nonce);
    return { hash, nonce, gas, maxFeePerGas, maxPriorityFeePerGas };
  } catch (error) {
    if (!isNonceTooLowError(error)) throw error;
    // Refresh nonce and retry once. The wallet's view (or our RPC's mempool
    // view) may have been a fraction of a second behind a just-included tx.
    const refreshed = await getNextNonce(client, params.account, params.chain);
    // Only retry if we actually got a strictly newer nonce; otherwise rethrow
    // to avoid an infinite "nonce too low" loop against a stuck RPC.
    if (refreshed === undefined || (nonce !== undefined && refreshed <= nonce)) {
      throw error;
    }
    nonce = refreshed;
    const hash = await send(nonce);
    return { hash, nonce, gas, maxFeePerGas, maxPriorityFeePerGas };
  }
};

const bigIntMax = (a: bigint | undefined, b: bigint | undefined): bigint | undefined => {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return a > b ? a : b;
};

/** EIP-1559 mempool replacement rule: each fee field must increase by >=12.5%. */
const bumpFee = (v: bigint | undefined): bigint | undefined => {
  if (v === undefined) return undefined;
  // (v * 1125 + 999) / 1000 -> ceil(v * 1.125), guards against rounding losses
  // for tiny fees that would otherwise round-trip back to the original value.
  return (v * 1125n + 999n) / 1000n;
};

/**
 * Outcome the outer wait-loop receives via `ctx.signal`. Either a
 * replacement was successfully broadcast (loop restarts on the new hash),
 * or the on-chain nonce has been consumed by a foreign tx (loop must throw
 * a typed error rather than silently treating that tx as ours).
 */
type SignalOutcome = { kind: "replaced" } | { kind: "foreign-nonce"; nonce: number; foreignHash: Hex | undefined };

interface ResendContext {
  client: WalletClient<HttpTransport, Chain, Account>;
  params: SentTxParams;
  txId: string;
  stepIndex: number;
  onHashSent: SendCallsOptions["onHashSent"];
  rebuildCall: SendCallsOptions["rebuildCall"];
  /**
   * Latest nonce/fee/gas/calldata state, mutated in-place across
   * replacements. `to/data/value` start as `params.{to,data,value}` and
   * are overwritten when a `retry` rebuild produces fresh calldata.
   */
  current: {
    hash: Hex;
    nonce: number | undefined;
    gas: bigint | undefined;
    maxFeePerGas: bigint | undefined;
    maxPriorityFeePerGas: bigint | undefined;
    to: Address | undefined;
    data: Hex | undefined;
    value: bigint | undefined;
  };
  /**
   * Every hash we've ever broadcast for this `(txId, stepIndex)`. Seeded
   * with the initial broadcast and appended on every successful resend /
   * retry. Used by the post-receipt foreign-hash defense and by
   * `inspectNonceOccupancy` to distinguish "ours mined" from "foreign".
   */
  knownHashes: Set<Hex>;
  /** Resolved by performResend/performRetry to drive the outer wait loop. */
  signal: { resolve: (outcome: SignalOutcome) => void } | undefined;
  /**
   * One-shot latch: a `resend` or `retry` only fires once per stall window.
   * If the replacement also stalls, the stall timer re-arms and the next
   * `onStall` exposes a fresh CTA.
   */
  didReplace: boolean;
}

/**
 * Discriminates a viem `eth_call`/contract revert from network/RPC errors.
 * Walks the BaseError cause chain so wrapped errors are recognized.
 */
const isRevertError = (err: unknown): boolean => {
  if (!(err instanceof Error)) return false;
  if (err instanceof BaseError) {
    const found = err.walk((e) => {
      const n = (e as { name?: string }).name;
      return (
        n === "ContractFunctionRevertedError" ||
        n === "RawContractError" ||
        n === "ExecutionRevertedError" ||
        n === "CallExecutionError"
      );
    });
    if (found) return true;
  }
  const msg = (err.message ?? "").toLowerCase();
  return msg.includes("execution reverted") || msg.includes("reverted") || msg.includes("revert");
};

/**
 * Simulate the currently-pending calldata against `blockTag: "latest"` to
 * decide whether a stuck tx would still succeed if resent. Returns
 * `"passes"` when the simulation succeeds (Resend is the right CTA),
 * `"reverts"` when it would revert (Retry — caller should rebuild), and
 * `"unknown"` for RPC/network failures (default to Resend, which is
 * idempotent and cannot make things worse than today).
 */
const simulateCurrentCall = async (
  publicClient: PublicClient,
  account: Address,
  to: Address | undefined,
  data: Hex | undefined,
  value: bigint | undefined,
): Promise<"passes" | "reverts" | "unknown"> => {
  try {
    await publicClient.call({ account, to, data, value });
    return "passes";
  } catch (err) {
    return isRevertError(err) ? "reverts" : "unknown";
  }
};

/**
 * Determines what's at `nonce` for `account`, given the set of hashes we
 * know we broadcast. Three outcomes:
 * - `pending`: the nonce hasn't been consumed yet — safe to broadcast.
 * - `ours`: one of `knownHashes` already mined; the existing wait will
 *   resolve with that receipt via viem's `(from, nonce)` replacement
 *   detection. Caller should NOT broadcast a duplicate.
 * - `foreign`: the slot is taken but by a tx we don't know — surface a
 *   typed error so the executor doesn't treat the foreign receipt as our
 *   step's success.
 *
 * On RPC failure, returns `pending` (best-effort: matches the existing
 * "fall through and let the broadcast happen" philosophy; the post-receipt
 * `knownHashes` defense in the wait loop catches the missed case).
 */
const inspectNonceOccupancy = async (
  publicClient: PublicClient,
  account: Address,
  nonce: number,
  knownHashes: Set<Hex>,
): Promise<
  { kind: "pending" } | { kind: "ours"; receipt: WaitForTransactionReceiptReturnType } | { kind: "foreign" }
> => {
  let onChainCount: number;
  try {
    onChainCount = await getTransactionCount(publicClient, { address: account, blockTag: "latest" });
  } catch {
    return { kind: "pending" };
  }
  if (onChainCount <= nonce) {
    return { kind: "pending" };
  }
  for (const hash of knownHashes) {
    try {
      const receipt = await getTransactionReceipt(publicClient, { hash });
      if (receipt) return { kind: "ours", receipt };
    } catch {
      // Not found / not yet mined — try the next.
    }
  }
  return { kind: "foreign" };
};

/**
 * Computes bumped EIP-1559 fees for a replacement tx: max of (previous
 * +12.5%, live network estimate). Returns `undefined` for either field
 * when both inputs are `undefined`.
 */
const computeReplacementFees = async (
  publicClient: PublicClient | null,
  current: ResendContext["current"],
): Promise<{ maxFeePerGas: bigint | undefined; maxPriorityFeePerGas: bigint | undefined }> => {
  let liveMaxFee: bigint | undefined;
  let liveMaxPrio: bigint | undefined;
  if (publicClient) {
    try {
      const fees = await publicClient.estimateFeesPerGas();
      liveMaxFee = fees.maxFeePerGas ?? undefined;
      liveMaxPrio = fees.maxPriorityFeePerGas ?? undefined;
    } catch {
      // Use bumped previous values only.
    }
  }
  return {
    maxFeePerGas: bigIntMax(bumpFee(current.maxFeePerGas), liveMaxFee),
    maxPriorityFeePerGas: bigIntMax(bumpFee(current.maxPriorityFeePerGas), liveMaxPrio),
  };
};

/**
 * Broadcasts a same-nonce replacement using the supplied call params.
 * Shared between `performResend` (uses ctx.current.{to,data,value}) and
 * `performRetry` (uses freshly-rebuilt params).
 *
 * Returns the new hash on success. Mutates `ctx.current` and `ctx.knownHashes`
 * and fires `onHashSent` for the audit trail.
 */
const broadcastReplacement = async (
  ctx: ResendContext,
  call: { to?: Address; data?: Hex; value?: bigint },
  fees: { maxFeePerGas: bigint | undefined; maxPriorityFeePerGas: bigint | undefined },
): Promise<Hex> => {
  const { client, params, current } = ctx;
  // current.nonce is required to be defined here; callers must check.
  const newHash = await client.sendTransaction({
    account: params.account,
    to: call.to,
    data: call.data,
    value: call.value,
    nonce: current.nonce,
    gas: current.gas,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    chain: params.chain,
  });
  current.hash = newHash;
  current.to = call.to;
  current.data = call.data;
  current.value = call.value;
  current.maxFeePerGas = fees.maxFeePerGas;
  current.maxPriorityFeePerGas = fees.maxPriorityFeePerGas;
  ctx.knownHashes.add(newHash);
  ctx.onHashSent?.({
    txId: ctx.txId,
    stepIndex: ctx.stepIndex,
    hash: newHash,
    nonce: current.nonce,
    account: params.account,
    chainId: params.chain.id,
  });
  return newHash;
};

/**
 * Issues a same-nonce, gas-bumped replacement of the currently-pending tx
 * using the SAME calldata. Idempotent (gated by `ctx.didReplace`).
 *
 * Short-circuits without broadcasting when:
 *  - the nonce is unknown (we never fetched one) — a "replacement" without
 *    an explicit nonce would just be a parallel broadcast;
 *  - one of our prior broadcasts has already mined at this nonce — the
 *    existing wait will pick it up via viem's replacement detection.
 *
 * Surfaces a `foreign-nonce` outcome (which the wait loop turns into a
 * {@link NonceConsumedByForeignTxError}) when a foreign tx has filled our
 * nonce slot.
 */
const performResend = async (ctx: ResendContext): Promise<void> => {
  if (ctx.didReplace) return;
  ctx.didReplace = true;

  const { params, current } = ctx;

  // Without an explicit nonce, a resend would create a parallel tx, not a
  // replacement. Refuse and leave the existing wait running.
  if (current.nonce === undefined) {
    return;
  }
  const publicClient = (() => {
    try {
      return getPublicClient(params.chain.id);
    } catch {
      return null;
    }
  })();

  if (publicClient) {
    const occupancy = await inspectNonceOccupancy(publicClient, params.account, current.nonce, ctx.knownHashes);
    if (occupancy.kind === "ours") {
      // One of our prior broadcasts mined; the existing wait will resolve
      // via replacement detection. We deliberately do NOT resolve the
      // signal — that would restart the wait loop for no benefit.
      return;
    }
    if (occupancy.kind === "foreign") {
      ctx.signal?.resolve({
        kind: "foreign-nonce",
        nonce: current.nonce,
        foreignHash: undefined,
      });
      return;
    }
    // pending: proceed.
  }

  const fees = await computeReplacementFees(publicClient, current);
  await broadcastReplacement(ctx, { to: current.to, data: current.data, value: current.value }, fees);

  // Tell the outer loop to abandon the old wait and start a fresh one on
  // the new hash. Both txs share (from, nonce), so viem's replacement
  // detection on the new wait will still surface the original's receipt if
  // it lands first.
  ctx.signal?.resolve({ kind: "replaced" });
};

/**
 * Issues a same-nonce, gas-bumped replacement using FRESH calldata produced
 * by the caller's `rebuildCall(stepIndex)`. Idempotent (gated by
 * `ctx.didReplace`).
 *
 * Short-circuits without broadcasting when:
 *  - `rebuildCall` is missing or returns `null` (caller declined);
 *  - the nonce is unknown — same parallel-broadcast guard as resend;
 *  - one of our prior broadcasts has already mined — wait resolves naturally.
 *
 * Surfaces a `foreign-nonce` outcome when a foreign tx has filled our slot.
 */
const performRetry = async (ctx: ResendContext): Promise<void> => {
  if (ctx.didReplace) return;
  if (!ctx.rebuildCall) return;

  // Don't latch yet — we want the user to be able to see a fresh CTA on
  // the next stall if this one no-ops because rebuildCall returns null.
  let rebuilt: { to?: Address; data?: Hex; value?: bigint } | null;
  try {
    rebuilt = await ctx.rebuildCall(ctx.stepIndex);
  } catch (err) {
    // A throw from rebuildCall is treated like a null: give up this round,
    // let the receipt-timeout path surface a hard failure if needed.
    console.warn(`[wait-with-resend] rebuildCall threw for stepIndex ${ctx.stepIndex}:`, err);
    return;
  }
  if (rebuilt == null) {
    return;
  }

  ctx.didReplace = true;

  const { params, current } = ctx;
  if (current.nonce === undefined) return;

  const publicClient = (() => {
    try {
      return getPublicClient(params.chain.id);
    } catch {
      return null;
    }
  })();

  if (publicClient) {
    const occupancy = await inspectNonceOccupancy(publicClient, params.account, current.nonce, ctx.knownHashes);
    if (occupancy.kind === "ours") return;
    if (occupancy.kind === "foreign") {
      ctx.signal?.resolve({
        kind: "foreign-nonce",
        nonce: current.nonce,
        foreignHash: undefined,
      });
      return;
    }
  }

  const fees = await computeReplacementFees(publicClient, current);
  await broadcastReplacement(
    ctx,
    {
      to: rebuilt.to ?? current.to,
      data: rebuilt.data ?? current.data,
      value: rebuilt.value ?? current.value,
    },
    fees,
  );

  ctx.signal?.resolve({ kind: "replaced" });
};

export interface StallContext {
  txId: string;
  stepIndex: number;
  options: SendCallsOptions;
}

/**
 * Sends a transaction and waits for its receipt with stall detection.
 *
 * Stall detection: after `stallAfterMs` without a receipt, if the public RPC
 * has no record of the hash, `onStall` is invoked with a `resend` handle.
 * Calling `resend` re-broadcasts with the same nonce + bumped gas; this
 * either replaces the held tx or proceeds normally if the wallet already
 * canceled it.
 *
 * After `receiptTimeoutMs` total elapsed time (across the original and any
 * resends), the wait rejects with `StuckTransactionError`.
 *
 * Returns the receipt of whichever tx actually landed (original or resend);
 * use `receipt.transactionHash` as the canonical hash.
 */
export const sendAndWaitWithResend = async (
  client: WalletClient<HttpTransport, Chain, Account>,
  waitForReceipt: typeof waitForTransactionReceipt,
  params: SentTxParams,
  stallContext: StallContext,
): Promise<WaitForTransactionReceiptReturnType> => {
  const initial = await estimateAndSendTransaction(client, params);

  const receiptTimeoutMs = stallContext.options.receiptTimeoutMs ?? DEFAULT_RECEIPT_TIMEOUT_MS;
  const stallAfterMs = stallContext.options.stallAfterMs ?? DEFAULT_STALL_AFTER_MS;
  const onStall = stallContext.options.onStall;
  const onHashSent = stallContext.options.onHashSent;

  // Report the initial broadcast so the caller can persist it before the
  // user has any chance to close the tab.
  onHashSent?.({
    txId: stallContext.txId,
    stepIndex: stallContext.stepIndex,
    hash: initial.hash,
    nonce: initial.nonce,
    account: params.account,
    chainId: params.chain.id,
  });

  const ctx: ResendContext = {
    client,
    params,
    txId: stallContext.txId,
    stepIndex: stallContext.stepIndex,
    onHashSent,
    rebuildCall: stallContext.options.rebuildCall,
    current: {
      hash: initial.hash,
      nonce: initial.nonce,
      gas: initial.gas,
      maxFeePerGas: initial.maxFeePerGas,
      maxPriorityFeePerGas: initial.maxPriorityFeePerGas,
      to: params.to,
      data: params.data,
      value: params.value,
    },
    knownHashes: new Set<Hex>([initial.hash]),
    signal: undefined,
    didReplace: false,
  };

  const startTime = Date.now();
  let stalled = false;
  let stallTimer: ReturnType<typeof setTimeout> | undefined;

  const armStallTimer = (hash: Hex) => {
    if (!onStall || stalled || ctx.didReplace) return;
    if (stallTimer) clearTimeout(stallTimer);
    const elapsed = Date.now() - startTime;
    const delay = Math.max(0, stallAfterMs - elapsed);
    stallTimer = setTimeout(async () => {
      if (stalled || ctx.didReplace) return;
      // Only fire if the public RPC has no record of the hash. If it does,
      // the wallet's broadcast worked and we just need more patience.
      let visible = false;
      let publicClient: PublicClient | null = null;
      try {
        publicClient = getPublicClient(params.chain.id);
        const tx = await getTransaction(publicClient, { hash });
        visible = tx != null;
      } catch {
        // TransactionNotFoundError -> not visible -> stuck.
        // Other RPC errors -> treat as not visible too; the worst case is we
        // surface the CTA earlier than strictly necessary.
        visible = false;
      }
      if (visible) return;
      if (stalled || ctx.didReplace) return;

      // Decide CTA kind via simulation of the currently-pending calldata.
      // - "passes"  -> Resend (same calldata bumped — wallet broadcast issue)
      // - "reverts" -> Retry  (rebuild + same nonce — calldata went stale)
      // - "unknown" -> default to Resend (idempotent fallback on RPC blip)
      // If `rebuildCall` is missing, we can't usefully Retry, so fall back
      // to Resend regardless of sim result.
      let simResult: "passes" | "reverts" | "unknown" = "unknown";
      if (publicClient) {
        simResult = await simulateCurrentCall(
          publicClient,
          params.account,
          ctx.current.to,
          ctx.current.data,
          ctx.current.value,
        );
      }
      const kind: StallKind = simResult === "reverts" && ctx.rebuildCall ? "retry" : "resend";

      if (stalled || ctx.didReplace) return;
      stalled = true;
      onStall({
        txId: stallContext.txId,
        stepIndex: stallContext.stepIndex,
        hash,
        nonce: ctx.current.nonce,
        kind,
        trigger: () => {
          const action = kind === "retry" ? performRetry : performResend;
          void action(ctx).catch(() => {
            // Surface failures via the next wait's rejection; never throw
            // from inside a user-supplied callback's microtask.
          });
        },
      });
    }, delay);
  };

  try {
    while (true) {
      armStallTimer(ctx.current.hash);

      let resolveSignal: ((outcome: SignalOutcome) => void) | undefined;
      const replaceSignal = new Promise<SignalOutcome>((resolve) => {
        resolveSignal = resolve;
      });
      ctx.signal = { resolve: (outcome) => resolveSignal?.(outcome) };

      const remainingMs = Math.max(0, receiptTimeoutMs - (Date.now() - startTime));
      if (remainingMs === 0) {
        throw new StuckTransactionError(ctx.current.hash);
      }

      const waitPromise = waitForReceipt(client, {
        hash: ctx.current.hash,
        timeout: remainingMs,
      });

      const result = await Promise.race([
        waitPromise.then((r) => ({ kind: "receipt" as const, r })),
        replaceSignal.then((outcome) => ({ kind: "signal" as const, outcome })),
      ]);

      if (result.kind === "receipt") {
        if (stallTimer) clearTimeout(stallTimer);
        // Foreign-hash defense: viem's `(from, nonce)` replacement
        // detection can return a receipt for a tx WE did not broadcast
        // (e.g. user signed something else from the same EOA). Reject so
        // the executor doesn't silently accept that as our step's success.
        if (ctx.current.nonce !== undefined && !ctx.knownHashes.has(result.r.transactionHash)) {
          throw new NonceConsumedByForeignTxError(ctx.current.nonce, result.r.transactionHash);
        }
        return result.r;
      }

      // Signal fired (replaced or foreign-nonce). We intentionally don't
      // await waitPromise here; viem will continue polling in the
      // background but its result is dropped.
      waitPromise.catch(() => {
        // swallow background errors so they don't surface as unhandled rejections
      });

      if (result.outcome.kind === "foreign-nonce") {
        if (stallTimer) clearTimeout(stallTimer);
        throw new NonceConsumedByForeignTxError(result.outcome.nonce, result.outcome.foreignHash);
      }
      // result.outcome.kind === "replaced": loop with the new hash. The new
      // wait will pick up either tx (original or replacement) via
      // (from, nonce) replacement detection.
    }
  } catch (err) {
    if (stallTimer) clearTimeout(stallTimer);
    if ((err as { name?: string } | null)?.name === "WaitForTransactionReceiptTimeoutError") {
      throw new StuckTransactionError(ctx.current.hash);
    }
    throw err;
  }
};
