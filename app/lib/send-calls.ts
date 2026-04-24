import type { Account, Address, Call, Chain, Client, Hex, HttpTransport, WalletClient } from "viem";
import { BaseError, encodeFunctionData, parseAbi } from "viem";
import { estimateGas, getTransactionCount, waitForTransactionReceipt } from "viem/actions";
import { chains } from "~/data/supported-chains";
import { getPublicClient } from "./public-client";

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

          // Wait for transaction receipt
          const receipt = await waitForReceipt(client, { hash });

          if (receipt.status === "success") {
            // Collect logs from this transaction
            allLogs.push((receipt.logs ?? []) as { address: Address; data: Hex; topics: Hex[] }[]);
          } else {
            // Transaction reverted
            if (!continueOnFailure) {
              throw new Error(`${txId} step ${i} reverted`);
            }
            allLogs.push([]);
          }
        } catch (error) {
          // Transaction failed
          if (!continueOnFailure) {
            throw error;
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
      const hash = await estimateAndSendTransaction(client, {
        account: from,
        to: MULTICALL3_ADDRESS,
        data: callData,
        chain,
      });

      // Wait for transaction receipt
      const receipt = await waitForReceipt(client, { hash });

      if (receipt.status !== "success") {
        throw new Error(`${txId} transaction reverted`);
      }

      // Transaction succeeded (even if some/all calls failed internally)
      const logs = (receipt.logs ?? []) as { address: Address; data: Hex; topics: Hex[] }[];
      return [hash, [logs]];
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
        throw new Error(`${txId} transaction reverted`);
      }
    } else {
      // In non-atomic-batch mode, only throw if we have no receipts at all
      // Allow partial success - some calls may have succeeded
      if (!status.receipts || status.receipts.length === 0 || !tx) {
        throw new Error(`${txId} transaction failed with no receipts`);
      }
    }

    const logs = status.receipts.map((r) => r.logs ?? []);
    return [tx, logs];
  };
};
