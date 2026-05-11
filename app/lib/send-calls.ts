import type { Account, Address, Call, Chain, Hex, HttpTransport, WalletClient } from "viem";
import { encodeFunctionData, parseAbi } from "viem";
import { waitForTransactionReceipt } from "viem/actions";
import { chains } from "~/data/supported-chains";
import {
  DEFAULT_RECEIPT_TIMEOUT_MS,
  type HashSentInfo,
  type SendCallsOptions,
  StuckTransactionError,
  sendAndWaitWithResend,
} from "./wait-with-resend";

// Re-export the resend/wait surface so callers can keep importing it from
// "send-calls" if they prefer. The implementation lives in
// `./wait-with-resend` to keep this file focused on the SendCalls dispatch.
export {
  DEFAULT_RECEIPT_TIMEOUT_MS,
  DEFAULT_STALL_AFTER_MS,
  type HashSentInfo,
  NonceConsumedByForeignTxError,
  type SendCallsOptions,
  type StallInfo,
  type StallKind,
  StuckTransactionError,
} from "./wait-with-resend";

/**
 * Multicall3 contract address (same across all chains)
 * See: https://github.com/mds1/multicall3
 */
export const MULTICALL3_ADDRESS: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";

/**
 * Encodes a list of calls as a Multicall3 `aggregate3` calldata blob — the
 * same encoding used by `prepareSendCalls`'s `*-multicall` modes.
 * Exported so the executor's `rebuildCall` closures (e.g. CCTP claim) can
 * re-encode a freshly-built call list when the user clicks Retry.
 */
export const encodeMulticall3Aggregate3 = (calls: Call[], allowFailure: boolean): Hex => {
  const call3Array = calls.map((call) => ({
    target: call.to ?? "0x0000000000000000000000000000000000000000",
    allowFailure,
    callData: call.data ?? "0x",
  }));
  return encodeFunctionData({
    abi: parseAbi([
      "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[])",
    ]),
    functionName: "aggregate3",
    args: [call3Array],
  });
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
 * @param options - Stall/timeout/resend/persistence behavior. See {@link SendCallsOptions}.
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
  options: SendCallsOptions = {},
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
          const receipt = await sendAndWaitWithResend(
            client,
            waitForReceipt,
            {
              account: from,
              to: calls[i].to,
              data: calls[i].data,
              value: calls[i].value,
              chain,
            },
            { txId, stepIndex: i, options },
          );

          // Use the receipt's hash so we record whichever tx actually landed
          // (original or resend) in the success record, not the locally-tracked
          // hash that may have been replaced.
          lastTx = receipt.transactionHash;

          if (receipt.status === "success") {
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
      const callData = encodeMulticall3Aggregate3(calls, allowFailure);

      const receipt = await sendAndWaitWithResend(
        client,
        waitForReceipt,
        {
          account: from,
          to: MULTICALL3_ADDRESS,
          data: callData,
          chain,
        },
        { txId, stepIndex: 0, options },
      );

      if (receipt.status !== "success") {
        throw new Error(`${txId} transaction reverted`);
      }

      // Transaction succeeded (even if some/all calls failed internally)
      const logs = (receipt.logs ?? []) as { address: Address; data: Hex; topics: Hex[] }[];
      return [receipt.transactionHash, [logs]];
    }

    // Batch modes (using sendCalls).
    // EIP-5792 surfaces a numeric statusCode; 4xx means "wallet will not retry"
    // (e.g. a cancelled batch). We don't have a same-nonce replacement path
    // here - surface a fail-fast StuckTransactionError so the caller's
    // retry/resume flow can re-issue the whole batch.
    const _calls = await client.sendCalls({
      account: from,
      chain,
      forceAtomic: mode === "atomic-batch",
      calls,
    });
    let status: Awaited<ReturnType<typeof client.waitForCallsStatus>>;
    try {
      status = await client.waitForCallsStatus({
        id: _calls.id,
        timeout: options.receiptTimeoutMs ?? DEFAULT_RECEIPT_TIMEOUT_MS,
      });
    } catch (err) {
      if ((err as { name?: string } | null)?.name === "WaitForCallsStatusTimeoutError") {
        throw new StuckTransactionError(`0x${_calls.id.replace(/^0x/, "")}` as Hex);
      }
      throw err;
    }
    const tx = status.receipts?.[0]?.transactionHash;
    const statusCode = (status as { statusCode?: number }).statusCode;
    if (statusCode !== undefined && statusCode >= 400 && statusCode < 500) {
      throw new StuckTransactionError(((tx as Hex | undefined) ?? ("0x" as Hex)) as Hex);
    }

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

    // EIP-5792 batches don't expose the wallet-side tx hash until
    // waitForCallsStatus resolves, so we can only fire onHashSent now (with
    // the receipts in hand). This still gives the caller the hashes needed
    // for the audit trail, just slightly later than the per-tx paths above.
    if (options.onHashSent && status.receipts && status.receipts.length > 0) {
      const hashSent: HashSentInfo[] = status.receipts.map((r, idx) => ({
        txId,
        stepIndex: idx,
        hash: r.transactionHash as Hex,
        nonce: undefined,
        account: from,
        chainId: chain.id,
      }));
      for (const info of hashSent) {
        options.onHashSent(info);
      }
    }

    const logs = status.receipts.map((r) => r.logs ?? []);
    return [tx, logs];
  };
};
