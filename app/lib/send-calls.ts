import type { Account, Address, Call, Chain, Hex, HttpTransport, WalletClient } from "viem";
import { encodeFunctionData, parseAbi } from "viem";
import { waitForTransactionReceipt } from "viem/actions";
import { chains } from "~/data/supported-chains";

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
          // Send individual transaction
          const hash = await client.sendTransaction({
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

      // Send transaction to Multicall3
      const hash = await client.sendTransaction({
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
