import type { Account, Address, Call, Chain, Client, Hex, HttpTransport, WalletClient } from "viem";
import { BaseError, ExecutionRevertedError, encodeFunctionData, parseAbi } from "viem";
import { estimateGas, getTransactionCount, waitForTransactionReceipt } from "viem/actions";
import { chains } from "~/data/supported-chains";
import { fetchFastFees } from "./gas-estimation";
import { getPublicClient } from "./public-client";

/**
 * Context describing how a transaction was submitted, attached to errors so a
 * retry can replace the pending tx instead of letting the wallet pick a fresh
 * nonce. Populated when the watchdog or receipt-wait surfaces a failure after
 * the wallet has already broadcast.
 */
export interface SendContext {
  nonce?: number;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
}

/**
 * Thrown when a `sendCalls` invocation fails after a transaction has been
 * broadcast. Carries the last attempted on-chain tx hash so callers can
 * reconcile against the chain (verify-before-retry) instead of blindly
 * re-broadcasting and risking a double-spend.
 *
 * Also carries the nonce + fees used for that broadcast so the retry path can
 * replace the same pending tx with a doubled-fee bid (mempool replacement
 * rules require ~10% bump on both `maxFeePerGas` and `maxPriorityFeePerGas`).
 *
 * `cause` preserves the original error so message-based detection in
 * `createTransactionError` keeps working.
 */
export class SendCallsError extends Error {
  override name: string = "SendCallsError";
  transactionHash?: string;
  nonce?: number;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  /** EIP-5792 bundle id, when the failure happened after wallet_sendCalls returned. */
  bundleId?: string;
  constructor(
    message: string,
    opts: {
      transactionHash?: string;
      nonce?: number;
      maxFeePerGas?: bigint;
      maxPriorityFeePerGas?: bigint;
      bundleId?: string;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: opts.cause });
    this.transactionHash = opts.transactionHash;
    this.nonce = opts.nonce;
    this.maxFeePerGas = opts.maxFeePerGas;
    this.maxPriorityFeePerGas = opts.maxPriorityFeePerGas;
    this.bundleId = opts.bundleId;
  }
}

/**
 * Thrown when the wallet returned a tx hash but no public RPC sees the tx
 * within the watchdog window. Most commonly produced by MetaMask's "Smart
 * Transactions" feature: the wallet submits to a private relay; if the relay
 * can't include the tx within ~1 minute it cancels the bundle and the tx never
 * hits any mempool. Without this watchdog, we'd sit on `waitForTransactionReceipt`
 * until viem's internal timeout (minutes), surfacing a generic timeout error.
 *
 * Extends {@link SendCallsError} so the existing catch-and-rethrow path in
 * step modes preserves the class (and `error.name`), letting `createTransactionError`
 * map this to a specific error code instead of falling back to generic timeout.
 */
export class TransactionNotBroadcastError extends SendCallsError {
  override name = "TransactionNotBroadcastError";
  constructor(transactionHash: string, context: SendContext = {}) {
    super(`Transaction ${transactionHash} not seen on any public mempool after watchdog window`, {
      transactionHash,
      ...context,
    });
  }
}

/**
 * EIP-5792 analog of {@link TransactionNotBroadcastError}: the wallet accepted
 * a `wallet_sendCalls` bundle but no terminal status arrived within the wait
 * budget. Recoverable — the persisted bundle id lets a resume re-enter
 * `waitForCallsStatus` instead of re-sending (there is no pre-receipt tx hash
 * to watchdog against; the id IS the anchor).
 */
export class BundleNotConfirmedError extends SendCallsError {
  override name = "BundleNotConfirmedError";
  constructor(bundleId: string, transactionHash?: string) {
    super(
      `BundleNotConfirmedError: call bundle ${bundleId} has no confirmed result yet — it may still be pending in your wallet`,
      { bundleId, transactionHash },
    );
  }
}

/**
 * Hints passed by the caller to replace a pending tx that previously failed
 * with `TX_NOT_BROADCAST` or `TIMEOUT`. Reusing the nonce lets the new tx
 * supersede the prior one; doubled fees satisfy mempool replacement rules.
 */
export interface RetryHints {
  nonce: number;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas?: bigint;
}

/** Window over which the mempool watchdog gives up; matches MetaMask STX's cancellation window. */
const MEMPOOL_WATCHDOG_TIMEOUT_MS = 60_000;
/** Interval between `eth_getTransactionByHash` polls — 15 polls over the 60s window. */
const MEMPOOL_WATCHDOG_POLL_INTERVAL_MS = 4_000;

/**
 * Wraps {@link waitForTransactionReceipt} with a mempool-visibility watchdog.
 *
 * After the wallet returns a hash, races two promises:
 *  - the normal receipt wait
 *  - a poll loop that asks a *public* RPC (not the wallet's) whether the tx
 *    is visible anywhere. If we never see it for 60s, we reject with
 *    {@link TransactionNotBroadcastError}.
 *
 * Using a public RPC (via {@link getPublicClient}) is deliberate: the wallet's
 * own RPC may misreport STX-submitted txs as pending even after MetaMask has
 * cancelled them. The public RPC reflects whether the tx ever hit a mempool
 * or a block, which is what we actually care about.
 *
 * Failure modes treated as "not seen yet" (keep polling, don't fail fast):
 *  - public RPC throws (rate limit, network) — we'd rather wait than
 *    false-positive on a flaky RPC.
 */
const waitForReceiptWithMempoolCheck = (
  client: Client<HttpTransport, Chain, Account>,
  waitForReceipt: typeof waitForTransactionReceipt,
  hash: Hex,
  chainId: number,
  context: SendContext = {},
) => {
  return new Promise<Awaited<ReturnType<typeof waitForTransactionReceipt>>>((resolve, reject) => {
    let stopped = false;
    let resolveWatchdog: () => void;
    const watchdogStop = new Promise<void>((r) => {
      resolveWatchdog = r;
    });

    // Mempool watchdog. The async IIFE catches its own thrown error and
    // routes it to `reject()` so the underlying promise never rejects —
    // sidesteps Node's "PromiseRejectionHandledWarning" caused by handler
    // attachment racing with fake timers / microtask ordering in tests.
    (async () => {
      try {
        const pub = getPublicClient(chainId);
        const deadline = Date.now() + MEMPOOL_WATCHDOG_TIMEOUT_MS;
        while (Date.now() < deadline && !stopped) {
          try {
            const tx = await pub.getTransaction({ hash });
            if (tx) return; // visible — defer to the receipt wait below
          } catch {
            // RPC error: treat as "not seen yet" rather than false-positive.
          }
          if (stopped) return;
          const settled = await Promise.race([
            watchdogStop.then(() => "stop" as const),
            new Promise<"continue">((r) => setTimeout(() => r("continue"), MEMPOOL_WATCHDOG_POLL_INTERVAL_MS)),
          ]);
          if (settled === "stop") return;
        }
        if (!stopped) reject(new TransactionNotBroadcastError(hash, context));
      } catch (err) {
        // Defensive: shouldn't happen since RPC errors are swallowed above,
        // but if anything else escapes, surface it instead of silently dropping.
        if (!stopped) reject(err);
      }
    })();

    waitForReceipt(client, { hash }).then(
      (receipt) => {
        stopped = true;
        resolveWatchdog();
        resolve(receipt);
      },
      (err) => {
        stopped = true;
        resolveWatchdog();
        // Wrap receipt-wait failures (e.g. viem's internal timeout) into
        // SendCallsError so the retry path has the same nonce/fee context as
        // the TransactionNotBroadcastError path. Preserves the original
        // message — `createTransactionError`'s "timed out" matcher still maps
        // to TIMEOUT.
        if (err instanceof SendCallsError) {
          reject(err);
        } else {
          reject(
            new SendCallsError(err instanceof Error ? err.message : String(err), {
              transactionHash: hash,
              ...context,
              cause: err,
            }),
          );
        }
      },
    );
  });
};

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
 * Fetches the next pending nonce for `account` via the wallet client's own
 * transport. Using the wallet client (rather than a separately-configured
 * public RPC) guarantees we query the same RPC that will process the send,
 * which avoids divergence in test environments (e.g. local Anvil) and still
 * bypasses the wallet's internal nonce cache in production by going straight
 * to `eth_getTransactionCount`.
 */
const getNextNonce = async (
  client: Client<HttpTransport, Chain, Account>,
  account: Address,
): Promise<number | undefined> => {
  try {
    return await getTransactionCount(client, { address: account, blockTag: "pending" });
  } catch {
    // If we can't fetch the nonce, fall back to letting the wallet pick it.
    return undefined;
  }
};

/**
 * Multicall3 contract address (same across all chains)
 * See: https://github.com/mds1/multicall3
 */
const MULTICALL3_ADDRESS: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";

/**
 * Wraps calls into one Multicall3 `aggregate3` call (allowFailure: false —
 * the whole aggregate reverts if any inner call fails). Shared by the
 * `atomic-multicall` mode and the smart-account path, which must preserve
 * this wrapper for CCTP mints whose `destinationCaller` was pinned to
 * Multicall3 at burn time.
 */
export const encodeMulticall3Call = (calls: Call[]): Call => {
  if (calls.some((call) => (call.value ?? 0n) > 0n)) {
    throw new Error("Sending value is not supported currently in multicall mode");
  }
  return {
    to: MULTICALL3_ADDRESS,
    data: encodeFunctionData({
      abi: parseAbi([
        "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[])",
      ]),
      functionName: "aggregate3",
      args: [
        calls.map((call) => ({
          target: call.to ?? ("0x0000000000000000000000000000000000000000" as Address),
          allowFailure: false,
          callData: call.data ?? "0x",
        })),
      ],
    }),
  };
};

/**
 * Switch to a chain in the connected wallet, adding it if missing.
 */
export const switchChain = async (client: WalletClient<HttpTransport, Chain, Account>, chainId: number) => {
  try {
    await client.switchChain({ id: chainId });
  } catch (_err) {
    await client.addChain({
      chain: chains[chainId as keyof typeof chains] as Chain,
    });
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
 * When `retryHints` is set, this is a retry of a prior submission that failed
 * with `TX_NOT_BROADCAST` or `TIMEOUT`. We reuse the prior nonce to replace
 * the pending tx and apply `max(hint × 2, currentFast × 2)` so the new bid
 * outbids both the original tx and the current network floor. The
 * "nonce too low" auto-refresh is also suppressed in this mode — if the
 * wallet says the nonce is consumed, the original tx mined and the caller's
 * verify-before-retry path should reconcile it on the next attempt.
 *
 * The returned context (nonce, fees) is attached to errors thrown later so
 * the caller can persist it on the failed step.
 */
const estimateAndSendTransaction = async (
  client: WalletClient<HttpTransport, Chain, Account>,
  params: {
    account: Address;
    to?: Address;
    data?: Hex;
    value?: bigint;
    chain: Chain;
  },
  retryHints?: RetryHints,
): Promise<{ hash: Hex; nonce?: number; maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint }> => {
  let gas: bigint | undefined;
  let maxFeePerGas: bigint | undefined;
  let maxPriorityFeePerGas: bigint | undefined;

  try {
    // Estimate against our own public RPC, not the wallet's provider. Wallet
    // providers (MetaMask) wrap estimation reverts in opaque "Internal
    // JSON-RPC error" responses, hiding the revert reason we need below.
    const estimatedGas = await estimateGas(getPublicClient(params.chain.id), {
      account: params.account,
      to: params.to,
      data: params.data,
      value: params.value,
    });
    gas = (estimatedGas * 120n) / 100n;
    console.log(
      `🔍 [GAS] chain=${params.chain.id} estimateGas=${estimatedGas} gas units, buffered(×1.2)=${gas} gas units`,
    );
  } catch (err) {
    // If the node says the tx would revert, sending it is guaranteed to burn
    // gas for nothing — worse, sending without a `gas` field makes MetaMask
    // fall back to 35% of the block gas limit when its own estimation also
    // reverts (on Arbitrum that's 35% × 2^50 gas ⇒ a "suggested fee" of
    // thousands of ETH). Abort with the decoded revert reason instead.
    const reverted = err instanceof BaseError ? err.walk((e) => e instanceof ExecutionRevertedError) : undefined;
    if (reverted) {
      const reason = (reverted as ExecutionRevertedError).details || (reverted as ExecutionRevertedError).shortMessage;
      throw new SendCallsError(`Transaction would revert: ${reason}`, { cause: err });
    }
    // Transient RPC failure (rate limit, network) — proceed without an
    // explicit gas limit and let the wallet estimate.
    gas = undefined;
    console.warn(`🔍 [GAS] chain=${params.chain.id} estimateGas failed (non-revert) — deferring to wallet`, err);
  }

  try {
    const fees = await fetchFastFees(params.chain.id);
    maxFeePerGas = fees.maxFeePerGas;
    maxPriorityFeePerGas = fees.maxPriorityFeePerGas;
    console.log(
      `🔍 [GAS] chain=${params.chain.id} maxFeePerGas=${maxFeePerGas} wei, maxPriorityFeePerGas=${maxPriorityFeePerGas ?? "n/a"} wei`,
    );
  } catch (err) {
    // Fall back to wallet/RPC defaults
    console.warn(`🔍 [GAS] chain=${params.chain.id} fetchFastFees FAILED — falling back to wallet/RPC defaults`, err);
  }

  console.log(
    `🔍 [GAS] chain=${params.chain.id} to=${params.to} value=${params.value ?? 0n} wei | gas needed: ${
      gas !== undefined && maxFeePerGas !== undefined
        ? `${gas * maxFeePerGas} wei max (${gas} gas × ${maxFeePerGas} wei/gas)`
        : `unknown (gas=${gas ?? "undefined"}, maxFeePerGas=${maxFeePerGas ?? "undefined"})`
    }`,
  );

  // Replacement bid: take the larger of last-attempt × 2 and current-fast × 2
  // so we both outbid our pending tx (mempool replacement rule) and stay above
  // the current network floor.
  if (retryHints) {
    const hintedMax = retryHints.maxFeePerGas * 2n;
    const currentMax = maxFeePerGas !== undefined ? maxFeePerGas * 2n : 0n;
    maxFeePerGas = hintedMax > currentMax ? hintedMax : currentMax;
    if (retryHints.maxPriorityFeePerGas !== undefined || maxPriorityFeePerGas !== undefined) {
      const hintedPri = (retryHints.maxPriorityFeePerGas ?? 0n) * 2n;
      const currentPri = (maxPriorityFeePerGas ?? 0n) * 2n;
      maxPriorityFeePerGas = hintedPri > currentPri ? hintedPri : currentPri;
    }
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

  let nonce: number | undefined = retryHints?.nonce ?? (await getNextNonce(client, params.account));

  try {
    const hash = await send(nonce);
    return { hash, nonce, maxFeePerGas, maxPriorityFeePerGas };
  } catch (error) {
    if (!isNonceTooLowError(error)) throw error;
    // With explicit retry hints, do not auto-refresh: the whole point of
    // reusing this nonce is to replace the pending tx; "nonce too low" means
    // the original already mined, and the verify-before-retry path will
    // reconcile on-chain.
    if (retryHints) throw error;
    // Refresh nonce and retry once. The wallet's view (or our RPC's mempool
    // view) may have been a fraction of a second behind a just-included tx.
    const refreshed = await getNextNonce(client, params.account);
    // Only retry if we actually got a strictly newer nonce; otherwise rethrow
    // to avoid an infinite "nonce too low" loop against a stuck RPC.
    if (refreshed === undefined || (nonce !== undefined && refreshed <= nonce)) {
      throw error;
    }
    nonce = refreshed;
    const hash = await send(nonce);
    return { hash, nonce, maxFeePerGas, maxPriorityFeePerGas };
  }
};

/** Wallet-popup + bundler-inclusion budget before pausing recoverable. */
const BUNDLE_STATUS_TIMEOUT_MS = 10 * 60_000;
const BUNDLE_POLL_INTERVAL_MS = 4_000;

export interface BundleHooks {
  /** Fires with the id IMMEDIATELY after wallet_sendCalls returns — persist before any waiting. */
  onBundleSent?: (id: string) => void;
  onBundleSettled?: (id: string, status: "confirmed" | "failed", transactionHash?: Hex) => void;
}

/**
 * Hardened EIP-5792 submission: send a call bundle (atomic when `forceAtomic`)
 * and wait for its terminal status. Used by the generic `atomic-batch` mode
 * and by the smart-account router. No nonce/fee management and no mempool
 * watchdog on this path — ordering, fee bumping, and replacement are the
 * WALLET's job for 4337 accounts, and there is no pre-receipt hash to probe;
 * the bundle id (surfaced via hooks and on thrown errors) is the resume
 * anchor instead.
 *
 * `existingBundleId` skips the send entirely and re-enters the status wait —
 * the resume path after a timeout or tab close.
 */
export const sendCallsBundle = async (
  client: WalletClient<HttpTransport, Chain, Account>,
  params: {
    txId: string;
    chainId: number;
    from: Address;
    calls: Call[];
    forceAtomic: boolean;
    hooks?: BundleHooks;
    existingBundleId?: string;
  },
): Promise<[Hex, { address: Address; data: Hex; topics: Hex[] }[][]]> => {
  const chain = chains[params.chainId as keyof typeof chains] as Chain;

  let bundleId = params.existingBundleId;
  if (bundleId === undefined) {
    // Errors here carry no bundleId/hash — nothing was accepted, so the
    // caller's USER_REJECTED / revert classification works through `cause`.
    const sent = await client.sendCalls({
      account: params.from,
      chain,
      forceAtomic: params.forceAtomic,
      // For non-atomic submissions, let viem degrade to sequential
      // eth_sendTransaction for wallets without wallet_sendCalls at all.
      experimental_fallback: !params.forceAtomic,
      calls: params.calls,
    });
    bundleId = sent.id;
    params.hooks?.onBundleSent?.(bundleId);
  }

  let status: Awaited<ReturnType<typeof client.waitForCallsStatus>>;
  try {
    status = await client.waitForCallsStatus({
      id: bundleId,
      timeout: BUNDLE_STATUS_TIMEOUT_MS,
      pollingInterval: BUNDLE_POLL_INTERVAL_MS,
    });
  } catch (error) {
    if ((error as { name?: string })?.name === "WaitForCallsStatusTimeoutError") {
      throw new BundleNotConfirmedError(bundleId);
    }
    throw new SendCallsError(error instanceof Error ? error.message : String(error), {
      bundleId,
      cause: error,
    });
  }

  const receipts = status.receipts ?? [];
  const reverted = receipts.find((receipt) => receipt.status !== "success");
  const transactionHash = receipts.at(-1)?.transactionHash as Hex | undefined;
  // Terminal success requires the bundle AND every receipt to succeed —
  // non-atomic bundles can partially fail per receipt — plus a resolvable
  // transaction hash (the executor's reconcile anchor).
  if (status.status !== "success" || receipts.length === 0 || reverted || !transactionHash) {
    const failureHash = (reverted?.transactionHash ?? transactionHash) as Hex | undefined;
    const label =
      status.status !== "success" ? (status.status ?? "failed") : reverted ? "reverted" : "returned no receipt";
    params.hooks?.onBundleSettled?.(bundleId, "failed", failureHash);
    throw new SendCallsError(`${params.txId} call bundle ${label}`, {
      bundleId,
      transactionHash: failureHash,
    });
  }

  params.hooks?.onBundleSettled?.(bundleId, "confirmed", transactionHash);
  const logs = receipts.map(
    (receipt) => (receipt.logs ?? []) as unknown as { address: Address; data: Hex; topics: Hex[] }[],
  );
  return [transactionHash, logs];
};

export type SendCallsMode =
  | "atomic-batch" // All calls in one batch, atomic (all-or-nothing)
  | "atomic-steps" // One call at a time, stop on first failure
  | "atomic-multicall"; // All calls via Multicall3, must all succeed

export type SendCallsFn = (
  txId: string,
  chainId: number,
  from: Address,
  calls: Call[],
  mode?: SendCallsMode,
  retryHints?: RetryHints,
) => Promise<[string, { address: Address; data: Hex; topics: Hex[] }[][]]>;

/**
 * Prepares a function that sends a batch of calls on a chain using the given wallet client.
 * Switches the wallet to the requested chain if needed.
 *
 * @param client - Wallet client used to send and wait for calls.
 * @param waitForReceipt - Optional function to wait for transaction receipt (for testing)
 * @param switchChainFn - Optional function to switch chains (for testing)
 * @returns A function:
 * (txId, chainId, from, calls, mode?) =>
 *   Promise<[txHash: string, results: { address: Address; data: Hex; topics: Hex[] }[][]>
 *
 * Modes:
 * - atomic-batch: All calls in one batch via sendCalls, throws if any call fails
 * - atomic-steps: Execute calls one by one via sendTransaction, stop on first failure
 * - atomic-multicall: All calls via Multicall3, must all succeed
 */
export const prepareSendCalls = (
  client: WalletClient<HttpTransport, Chain, Account>,
  waitForReceipt: typeof waitForTransactionReceipt = waitForTransactionReceipt,
  switchChainFn: typeof switchChain = switchChain,
): SendCallsFn => {
  return async (txId, chainId, from, calls, mode = "atomic-steps", retryHints) => {
    if (!calls?.length) {
      return ["", []];
    }
    await switchChainFn(client, chainId);

    const chain = chains[chainId as keyof typeof chains] as Chain;

    // Step-by-step execution mode (using sendTransaction)
    if (mode === "atomic-steps") {
      // Hash of the most recently confirmed-on-chain call. Only the
      // success-path return value uses this — the failure path uses each
      // iteration's own `currentTx`, so an earlier successful call's hash
      // cannot bleed into an error wrapping a later call's failure.
      //
      // Why this matters for CCTP bridges: a bridge step is approve + burn
      // in this single mode. If iteration 0 (approve) lands on chain and
      // iteration 1 (burn) throws before producing a hash (user reject in
      // wallet, gas estimation error, RPC blip), bookkeeping that spans
      // both iterations would surface the approve's hash on the thrown
      // SendCallsError. The executor would then persist that approve hash
      // on the failed bridge step, and on retry `tryReconcileFromChain`
      // would probe the approve's (successful) receipt and falsely declare
      // the bridge done — advancing to the attestation step, which polls
      // Circle forever for a message the approve tx never produced.
      let lastSuccessfulTx: string | undefined;
      const allLogs: { address: Address; data: Hex; topics: Hex[] }[][] = [];

      for (let i = 0; i < calls.length; i++) {
        let currentTx: string | undefined;
        let currentContext: SendContext | undefined;
        try {
          // Retry hints apply only to the first call in the loop. A
          // multi-call step that failed past index 0 will surface "nonce too
          // low" here and the executor's verify-before-retry path reconciles
          // it on the next attempt.
          const sendResult = await estimateAndSendTransaction(
            client,
            {
              account: from,
              to: calls[i].to,
              data: calls[i].data,
              value: calls[i].value,
              chain,
            },
            i === 0 ? retryHints : undefined,
          );

          currentTx = sendResult.hash;
          currentContext = {
            nonce: sendResult.nonce,
            maxFeePerGas: sendResult.maxFeePerGas,
            maxPriorityFeePerGas: sendResult.maxPriorityFeePerGas,
          };

          // Wait for transaction receipt with mempool watchdog (catches MetaMask
          // Smart Transactions silent cancellations — see TransactionNotBroadcastError).
          const receipt = await waitForReceiptWithMempoolCheck(
            client,
            waitForReceipt,
            sendResult.hash,
            chainId,
            currentContext,
          );

          // viem's `waitForTransactionReceipt` follows replacements (wallet
          // speed-up / cancellation send a new tx at the same nonce, dropping
          // the original). Record the actually-mined hash so explorer links
          // resolve and the executor's reconcile path probes the right tx.
          if (receipt.transactionHash) currentTx = receipt.transactionHash;

          if (receipt.status === "success") {
            allLogs.push((receipt.logs ?? []) as { address: Address; data: Hex; topics: Hex[] }[]);
            lastSuccessfulTx = currentTx;
          } else {
            throw new SendCallsError(`${txId} step ${i} reverted`, {
              transactionHash: currentTx,
              ...currentContext,
            });
          }
        } catch (error) {
          if (error instanceof SendCallsError) throw error;
          throw new SendCallsError(error instanceof Error ? error.message : String(error), {
            // `currentTx` / `currentContext` are scoped to this iteration:
            // they're undefined unless the wallet actually returned a hash
            // for THIS call. Never carries an earlier successful call's
            // identity into the failure of a later one.
            transactionHash: currentTx,
            ...(currentContext ?? {}),
            cause: error,
          });
        }
      }

      return [lastSuccessfulTx ?? "", allLogs];
    }

    // Multicall3 mode
    if (mode === "atomic-multicall") {
      const multicall = encodeMulticall3Call(calls);

      // Estimate gas and send transaction to Multicall3
      let multicallHash: Hex | undefined;
      let multicallContext: SendContext | undefined;
      try {
        const sendResult = await estimateAndSendTransaction(
          client,
          {
            account: from,
            to: multicall.to as Address,
            data: multicall.data,
            chain,
          },
          retryHints,
        );
        multicallHash = sendResult.hash;
        multicallContext = {
          nonce: sendResult.nonce,
          maxFeePerGas: sendResult.maxFeePerGas,
          maxPriorityFeePerGas: sendResult.maxPriorityFeePerGas,
        };

        // Wait for transaction receipt with mempool watchdog (catches MetaMask
        // Smart Transactions silent cancellations — see TransactionNotBroadcastError).
        const receipt = await waitForReceiptWithMempoolCheck(
          client,
          waitForReceipt,
          multicallHash,
          chainId,
          multicallContext,
        );

        // viem follows replacements (wallet speed-up / cancellation); record
        // the actually-mined hash so explorer links and reconcile probes resolve.
        if (receipt.transactionHash) multicallHash = receipt.transactionHash;

        if (receipt.status !== "success") {
          throw new SendCallsError(`${txId} transaction reverted`, {
            transactionHash: multicallHash,
            ...multicallContext,
          });
        }

        // Transaction succeeded (even if some/all calls failed internally)
        const logs = (receipt.logs ?? []) as { address: Address; data: Hex; topics: Hex[] }[];
        return [multicallHash, [logs]];
      } catch (error) {
        if (error instanceof SendCallsError) throw error;
        throw new SendCallsError(error instanceof Error ? error.message : String(error), {
          transactionHash: multicallHash,
          ...(multicallContext ?? {}),
          cause: error,
        });
      }
    }

    // Batch mode (EIP-5792): hardened shared primitive — status timeout,
    // per-receipt success requirement, bundle-id error context.
    return sendCallsBundle(client, { txId, chainId, from, calls, forceAtomic: true });
  };
};
