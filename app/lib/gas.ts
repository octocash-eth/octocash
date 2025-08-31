import { type Address, type Chain, createPublicClient, formatUnits, http, parseUnits, type Transport } from "viem";
import { getGasThresholdForChain } from "~/data/gas-thresholds";
import { chains } from "~/data/supported-chains";
import type { TokenAmount } from "./consolidation";

export async function getNativeBalance(chain: Chain, address: Address, transport?: Transport): Promise<bigint> {
  const client = createPublicClient({ chain, transport: transport ?? http(chain.rpcUrls.default.http[0]) });
  return await client.getBalance({ address });
}

export async function ensureSufficientGas(
  tokensIn: TokenAmount[],
  tokenOut: TokenAmount,
  transports?: Record<number, Transport>,
): Promise<void> {
  // Check per (chainId, walletAddress) pair among sources, plus destination pair
  type Pair = { chainId: number; address: Address };
  const toKey = (p: Pair) => `${p.chainId}:${p.address.toLowerCase()}`;
  const pairsMap = new Map<string, Pair>();
  for (const t of tokensIn) {
    const key = toKey({ chainId: t.chainId, address: t.walletAddress });
    if (!pairsMap.has(key)) pairsMap.set(key, { chainId: t.chainId, address: t.walletAddress });
  }
  const destKey = toKey({
    chainId: tokenOut.chainId,
    address: tokenOut.walletAddress,
  });
  if (!pairsMap.has(destKey)) {
    pairsMap.set(destKey, {
      chainId: tokenOut.chainId,
      address: tokenOut.walletAddress,
    });
  }

  const insufficients: string[] = [];
  for (const { chainId, address } of pairsMap.values()) {
    const thresholdStr = getGasThresholdForChain(chainId);
    const thresholdWei = parseUnits(thresholdStr, 18);
    const balanceWei = await getNativeBalance(
      chains[chainId as keyof typeof chains] as Chain,
      address,
      transports?.[chainId as keyof typeof transports],
    );
    if (balanceWei < thresholdWei) {
      const chain = chains[chainId as keyof typeof chains] as Chain;
      const [chainName, symbol] = [chain.name, chain.nativeCurrency.symbol];
      const human = formatUnits(balanceWei, 18);
      insufficients.push(
        `Insufficient gas on ${chainName} for ${address}. Balance ${human} ${symbol} < required ${thresholdStr} ${symbol}. Please top up at https://gas.zip`,
      );
    }
  }

  if (insufficients.length > 0) {
    const message = insufficients.join("; ");
    throw new Error(message);
  }
}
