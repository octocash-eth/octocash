import { getPublicClient } from "@wagmi/core";
import type { Account, Address, Call, Chain, Hex, HttpTransport, WalletClient } from "viem";
import { chains } from "~/data/supported-chains";
import { WALLETCONNECT_CONFIG } from "~/utils/wallet";

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
  mode?: "atomic" | "non-atomic" | "simulation",
) => Promise<[string, { address: Address; data: Hex; topics: Hex[] }[][], (Error | undefined)[]]>;

/**
 * Simulate the calls and return the logs or the error.
 * @param chainId - The chain id.
 * @param from - The from address.
 * @param calls - The calls to simulate.
 * @returns The logs or the error.
 */
async function simulateCalls({
  chainId,
  from,
  calls,
}: {
  chainId: number;
  from: Address;
  calls: Call[];
}): Promise<[{ address: Address; data: Hex; topics: Hex[] }[][], (Error | undefined)[]]> {
  const publicClient = getPublicClient(WALLETCONNECT_CONFIG, { chainId });
  if (!publicClient) {
    throw new Error(`Chain ${chainId} not supported`);
  }
  const simulatedCalls = await publicClient.simulateCalls({
    account: from,
    calls,
  });
  const logs = simulatedCalls.results.map((result) => result.logs ?? []);
  const errors = simulatedCalls.results.map((result) => result.error);
  return [logs, errors];
}

/**
 * Prepares a function that sends a batch of calls on a chain using the given wallet client.
 * Switches the wallet to the requested chain if needed.
 *
 * @param client - Wallet client used to send and wait for calls.
 * @returns A function:
 * (txId, chainId, from, calls, mode?) =>
 *   Promise<[txHash: string, results: { address: Address; data: Hex; topics: Hex[] }[][], errors: (Error | undefined)[]>
 *
 */
export const prepareSendCalls = (client: WalletClient<HttpTransport, Chain, Account>): SendCallsFn => {
  return async (txId, chainId, from, calls, mode = "atomic") => {
    if (mode === "simulation") {
      const [simulatedLogs, simulatedErrors] = await simulateCalls({ chainId, from, calls });
      return ["", simulatedLogs, simulatedErrors];
    }
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
    const errors = status.receipts.map((r) =>
      r.status === "reverted" ? new Error("Transaction reverted", { cause: r }) : undefined,
    );
    return [tx, logs, errors];
  };
};
