import type { Account, Address, Call, Chain, Hex, HttpTransport, WalletClient } from "viem";
import { chains } from "~/data/supported-chains";

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

export type SendCallsFn = (
  txId: string,
  chainId: number,
  from: Address,
  calls: Call[],
  mode?: "atomic" | "non-atomic",
) => Promise<[string, { address: Address; data: Hex; topics: Hex[] }[][]]>;

/**
 * Prepares a function that sends a batch of calls on a chain using the given wallet client.
 * Switches the wallet to the requested chain if needed.
 *
 * @param client - Wallet client used to send and wait for calls.
 * @returns A function:
 * (txId, chainId, from, calls, mode?) =>
 *   Promise<[txHash: string, results: { address: Address; data: Hex; topics: Hex[] }[][]>
 *
 */
export const prepareSendCalls = (client: WalletClient<HttpTransport, Chain, Account>): SendCallsFn => {
  return async (txId, chainId, from, calls, mode = "atomic") => {
    await switchChain(client, chainId);
    const _calls = await client.sendCalls({
      account: from,
      chain: chains[chainId as keyof typeof chains] as Chain,
      forceAtomic: mode === "atomic",
      calls,
    });
    const status = await client.waitForCallsStatus({ id: _calls.id });
    const tx = status.receipts?.[0]?.transactionHash;
    if (status.status !== "success" || !status.receipts || !tx) {
      throw new Error(`${txId} transaction reverted`);
    }
    const logs = status.receipts.map((r) => r.logs ?? []);
    return [tx, logs];
  };
};
