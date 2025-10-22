import { type Address, type Chain, createPublicClient, formatUnits, parseUnits, type Transport } from "viem";
import { getGasThresholdForChain } from "~/data/gas-thresholds";
import { chains, transports } from "~/data/supported-chains";
import type { TokenAmount } from "./types";

export async function getNativeBalance(chain: Chain, address: Address, transport?: Transport): Promise<bigint> {
  const effectiveTransport = transport ?? transports?.[chain.id as keyof typeof transports];
  if (!effectiveTransport) {
    throw new Error(`No transport configured for chain ${chain.id}`);
  }
  const client = createPublicClient({ chain, transport: effectiveTransport });

  // Retry logic with exponential backoff for rate limiting
  const maxRetries = 3;
  const baseDelay = 1000; // 1 second

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await client.getBalance({ address });
    } catch (error) {
      // Check if it's a rate limiting error (429)
      const is429 =
        error instanceof Error &&
        (error.message.includes("429") ||
          error.message.includes("Too many request") ||
          error.message.includes("rate limit"));

      // If it's not a rate limit error or we've exhausted retries, throw
      if (!is429 || attempt === maxRetries) {
        throw error;
      }

      // Wait with exponential backoff before retrying
      const delay = baseDelay * 2 ** attempt;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  // This should never be reached, but TypeScript needs it
  throw new Error("Failed to get balance after retries");
}

export async function ensureSufficientGas(
  tokensIn: TokenAmount[],
  tokenOut: Omit<TokenAmount, "amount">,
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
