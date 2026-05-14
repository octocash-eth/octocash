import type { Account, Address, Call, Chain, Client, Hex, HttpTransport, WalletClient } from "viem";
import { BaseError, encodeFunctionData, parseAbi } from "viem";
import { estimateGas, getTransactionCount, waitForTransactionReceipt } from "viem/actions";
import { chains } from "~/data/supported-chains";
import { fetchFastFees } from "./gas-estimation";
import { getPublicClient } from "./public-client";

/**
 * Thrown when a `sendCalls` invocation fails after a transaction has been
 * broadcast. Carries the last attempted on-chain tx hash so callers can
 * reconcile against the chain (verify-before-retry) instead of blindly
 * re-broadcasting and risking a double-spend.
 *
 * `cause` preserves the original error so message-based detection in
 * `createTransactionError` keeps working.
 */
export class SendCallsError extends Error {
  override name: string = "SendCallsError";
  transactionHash?: string;
  constructor(message: string, opts: { transactionHash?: string; cause?: unknown } = {}) {
    super(message, { cause: opts.cause });
    this.transactionHash = opts.transactionHash;
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
  constructor(transactionHash: string) {
    super(`Transaction ${transactionHash} not seen on any public mempool after watchdog window`, {
      transactionHash,
    });
  }
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
        if (!stopped) reject(new TransactionNotBroadcastError(hash));
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
        reject(err);
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
): Promise<Hex> => {
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
    const fees = await fetchFastFees(params.chain.id);
    maxFeePerGas = fees.maxFeePerGas;
    maxPriorityFeePerGas = fees.maxPriorityFeePerGas;
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

  let nonce = await getNextNonce(client, params.account);

  try {
    return await send(nonce);
  } catch (error) {
    if (!isNonceTooLowError(error)) throw error;
    // Refresh nonce and retry once. The wallet's view (or our RPC's mempool
    // view) may have been a fraction of a second behind a just-included tx.
    const refreshed = await getNextNonce(client, params.account);
    // Only retry if we actually got a strictly newer nonce; otherwise rethrow
    // to avoid an infinite "nonce too low" loop against a stuck RPC.
    if (refreshed === undefined || (nonce !== undefined && refreshed <= nonce)) {
      throw error;
    }
    nonce = refreshed;
    return await send(nonce);
  }
};

export type SendCallsMode =
  | "atomic-batch" // All calls in one batch, atomic (all-or-nothing)
  | "non-atomic-batch" // All calls in one batch, non-atomic (partial success allowed)
  | "atomic-steps" // One call at a time, stop on first failure
  | "non-atomic-steps" // One call at a time, continue on failures
  | "atomic-multicall" // All calls via Multicall3, must all succeed
  | "non-atomic-multicall"; // All calls via Multicall3, partial success OK

export type SendCallsFn = (
  txId: string,
  chainId: number,
  from: Address,
  calls: Call[],
  mode?: SendCallsMode,
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
 * - non-atomic-batch: All calls in one batch via sendCalls, allows partial success
 * - atomic-steps: Execute calls one by one via sendTransaction, stop on first failure
 * - non-atomic-steps: Execute calls one by one via sendTransaction, continue on failures
 * - atomic-multicall: All calls via Multicall3, must all succeed
 * - non-atomic-multicall: All calls via Multicall3, partial success OK
 */
export const prepareSendCalls = (
  client: WalletClient<HttpTransport, Chain, Account>,
  waitForReceipt: typeof waitForTransactionReceipt = waitForTransactionReceipt,
  switchChainFn: typeof switchChain = switchChain,
): SendCallsFn => {
  return async (txId, chainId, from, calls, mode = "atomic-steps") => {
    if (!calls?.length) {
      return ["", []];
    }
    await switchChainFn(client, chainId);

    const chain = chains[chainId as keyof typeof chains] as Chain;

    // Step-by-step execution modes (using sendTransaction)
    if (mode === "atomic-steps" || mode === "non-atomic-steps") {
      const continueOnFailure = mode === "non-atomic-steps";
      let lastTx: string | undefined;
      const allLogs: { address: Address; data: Hex; topics: Hex[] }[][] = [];

      for (let i = 0; i < calls.length; i++) {
        try {
          // Estimate gas and send individual transaction
          const hash = await estimateAndSendTransaction(client, {
            account: from,
            to: calls[i].to,
            data: calls[i].data,
            value: calls[i].value,
            chain,
          });

          lastTx = hash; // Always track last attempted transaction

          // Wait for transaction receipt with mempool watchdog (catches MetaMask
          // Smart Transactions silent cancellations — see TransactionNotBroadcastError).
          const receipt = await waitForReceiptWithMempoolCheck(client, waitForReceipt, hash, chainId);

          if (receipt.status === "success") {
            // Collect logs from this transaction
            allLogs.push((receipt.logs ?? []) as { address: Address; data: Hex; topics: Hex[] }[]);
          } else {
            // Transaction reverted
            if (!continueOnFailure) {
              throw new SendCallsError(`${txId} step ${i} reverted`, { transactionHash: lastTx });
            }
            allLogs.push([]);
          }
        } catch (error) {
          // Transaction failed
          if (!continueOnFailure) {
            if (error instanceof SendCallsError) throw error;
            throw new SendCallsError(error instanceof Error ? error.message : String(error), {
              transactionHash: lastTx,
              cause: error,
            });
          }
          allLogs.push([]);
        }
      }

      return [lastTx ?? "", allLogs];
    }

    // Multicall3 modes
    if (mode === "atomic-multicall" || mode === "non-atomic-multicall") {
      if (calls.some((call) => (call.value ?? 0n) > 0n)) {
        throw new Error("Sending value is not supported currently in multicall mode");
      }

      const allowFailure = mode === "non-atomic-multicall";

      // Build Call3[] array for Multicall3
      const call3Array = calls.map((call) => ({
        target: call.to ?? "0x0000000000000000000000000000000000000000",
        allowFailure,
        callData: call.data ?? "0x",
      }));

      // Encode aggregate3 call
      const callData = encodeFunctionData({
        abi: parseAbi([
          "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[])",
        ]),
        functionName: "aggregate3",
        args: [call3Array],
      });

      // Estimate gas and send transaction to Multicall3
      let multicallHash: Hex | undefined;
      try {
        multicallHash = await estimateAndSendTransaction(client, {
          account: from,
          to: MULTICALL3_ADDRESS,
          data: callData,
          chain,
        });

        // Wait for transaction receipt with mempool watchdog (catches MetaMask
        // Smart Transactions silent cancellations — see TransactionNotBroadcastError).
        const receipt = await waitForReceiptWithMempoolCheck(client, waitForReceipt, multicallHash, chainId);

        if (receipt.status !== "success") {
          throw new SendCallsError(`${txId} transaction reverted`, { transactionHash: multicallHash });
        }

        // Transaction succeeded (even if some/all calls failed internally)
        const logs = (receipt.logs ?? []) as { address: Address; data: Hex; topics: Hex[] }[];
        return [multicallHash, [logs]];
      } catch (error) {
        if (error instanceof SendCallsError) throw error;
        throw new SendCallsError(error instanceof Error ? error.message : String(error), {
          transactionHash: multicallHash,
          cause: error,
        });
      }
    }

    // Batch modes (using sendCalls)
    const _calls = await client.sendCalls({
      account: from,
      chain,
      forceAtomic: mode === "atomic-batch",
      calls,
    });
    const status = await client.waitForCallsStatus({ id: _calls.id });
    const tx = status.receipts?.[0]?.transactionHash;

    // In atomic-batch mode, throw on any failure
    if (mode === "atomic-batch") {
      if (status.status !== "success" || !status.receipts || !tx) {
        throw new SendCallsError(`${txId} transaction reverted`, { transactionHash: tx });
      }
    } else {
      // In non-atomic-batch mode, only throw if we have no receipts at all
      // Allow partial success - some calls may have succeeded
      if (!status.receipts || status.receipts.length === 0 || !tx) {
        throw new SendCallsError(`${txId} transaction failed with no receipts`, { transactionHash: tx });
      }
    }

    const logs = status.receipts.map((r) => r.logs ?? []);
    return [tx, logs];
  };
};
