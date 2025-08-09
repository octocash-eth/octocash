import { getGasThresholdForChain } from "~/data/gas-thresholds";
import {
  formatUnits,
  parseUnits,
  createPublicClient,
  http,
  type Address,
  type Chain,
} from "viem";
import { chains } from "~/data/supported-chains";
import type { TokenAmount } from "./consolidation";
import type { usePublicClient } from "wagmi";

async function getNativeBalance(
  _publicClient: ReturnType<typeof usePublicClient>,
  chainId: number,
  address: Address
): Promise<bigint> {
  const chain = chains[chainId as keyof typeof chains] as Chain;
  const rpcUrl = chain.rpcUrls.default.http[0];
  const client = createPublicClient({ chain, transport: http(rpcUrl) });
  const balance = await client.getBalance({ address });
  return balance;
}

export async function ensureSufficientGas(
  publicClient: ReturnType<typeof usePublicClient>,
  tokensIn: TokenAmount[],
  tokenOut: TokenAmount
): Promise<void> {
  // Check per (chainId, walletAddress) pair among sources, plus destination pair
  type Pair = { chainId: number; address: Address };
  const toKey = (p: Pair) => `${p.chainId}:${p.address.toLowerCase()}`;
  const pairsMap = new Map<string, Pair>();
  for (const t of tokensIn) {
    const key = toKey({ chainId: t.chainId, address: t.walletAddress });
    if (!pairsMap.has(key))
      pairsMap.set(key, { chainId: t.chainId, address: t.walletAddress });
  }
  const destKey = toKey({
    chainId: tokenOut.chainId,
    address: tokenOut.walletAddress,
  });
  if (!pairsMap.has(destKey))
    pairsMap.set(destKey, {
      chainId: tokenOut.chainId,
      address: tokenOut.walletAddress,
    });

  const insufficients: string[] = [];
  for (const { chainId, address } of pairsMap.values()) {
    const thresholdStr = getGasThresholdForChain(chainId);
    const thresholdWei = parseUnits(thresholdStr, 18);
    const balanceWei = await getNativeBalance(publicClient, chainId, address);
    if (balanceWei < thresholdWei) {
      const chain = chains[chainId as keyof typeof chains] as Chain;
      const [chainName, symbol] = [chain.name, chain.nativeCurrency.symbol];
      const human = formatUnits(balanceWei, 18);
      insufficients.push(
        `Insufficient gas on ${chainName} for ${address}. Balance ${human} ${symbol} < required ${thresholdStr} ${symbol}. Please top up at https://gas.zip`
      );
    }
  }

  if (insufficients.length > 0) {
    const message = insufficients.join("; ");
    throw new Error(message);
  }
}
