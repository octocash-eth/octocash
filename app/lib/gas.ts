import { type Address, type Chain, getAddress, type Transport } from "viem";
import { chains } from "~/data/supported-chains";
import { getPublicClient, retryOnRateLimit } from "./public-client";

export async function getNativeBalance(chain: Chain, address: Address, transport?: Transport): Promise<bigint> {
  const client = getPublicClient(chain.id, transport);
  return retryOnRateLimit(() => client.getBalance({ address }));
}

/**
 * Resolves deduplicated (chainId, address) pairs from a list.
 */
function deduplicateChainAddresses(chainAddresses: [number, Address][]): [number, Address][] {
  const seen = new Set<string>();
  const result: [number, Address][] = [];
  for (const [chainId, address] of chainAddresses) {
    const key = `${chainId}:${getAddress(address)}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push([chainId, getAddress(address) as Address]);
    }
  }
  return result;
}

/**
 * Finds the (address, chainId) pair with the highest native balance
 * among the given chain-address pairs.
 *
 * @param chainAddresses - Array of [chainId, address] pairs to check
 * @param transports - Optional transport overrides per chain
 * @returns The richest source: { chainId, address, balance } or null if none found
 */
export async function findRichestSource(
  chainAddresses: [number, Address][],
  transports?: Record<number, Transport>,
): Promise<{ chainId: number; address: Address; balance: bigint } | null> {
  const deduplicated = deduplicateChainAddresses(chainAddresses);

  const results = await Promise.all(
    deduplicated
      .filter(([chainId]) => chains[chainId as keyof typeof chains] != null)
      .map(async ([chainId, address]) => {
        const chain = chains[chainId as keyof typeof chains] as Chain;
        const balance = await getNativeBalance(chain, address, transports?.[chainId as keyof typeof transports]);
        return { chainId, address, balance };
      }),
  );

  return results.reduce<{ chainId: number; address: Address; balance: bigint } | null>(
    (richest, entry) => (!richest || entry.balance > richest.balance ? entry : richest),
    null,
  );
}
