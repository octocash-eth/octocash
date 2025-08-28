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
  isAtomic?: boolean,
) => Promise<[string, { address: Address; data: Hex; topics: Hex[] }[]]>;

/**
 * Prepare a function that atomically sends a batch of calls on a given chain
 * and returns the transaction hash and flattened logs.
 */
export const prepareSendCalls = (client: WalletClient<HttpTransport, Chain, Account>) => {
  return async (
    txId: string,
    chainId: number,
    from: Address,
    calls: Call[],
    isAtomic: boolean = true,
  ): Promise<[string, { address: Address; data: Hex; topics: Hex[] }[]]> => {
    await switchChain(client, chainId);
    const _calls = await client.sendCalls({
      account: from,
      chain: chains[chainId as keyof typeof chains] as Chain,
      forceAtomic: isAtomic,
      calls,
    });
    const status = await client.waitForCallsStatus({ id: _calls.id });
    const tx = status.receipts?.[0]?.transactionHash;
    if (!tx || status.receipts?.[0]?.status === "reverted") {
      throw new Error(`${txId} transaction reverted`);
    }
    const logs = status.receipts?.flatMap((r) => r.logs ?? []) ?? [];
    return [tx, logs];
  };
};
