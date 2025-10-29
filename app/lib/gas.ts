import { type Address, type Chain, formatUnits, getAddress, parseUnits, type Transport } from "viem";
import { getGasThresholdForChain } from "~/data/gas-thresholds";
import { chains } from "~/data/supported-chains";
import { getPublicClient, retryOnRateLimit } from "./public-client";

export async function getNativeBalance(chain: Chain, address: Address, transport?: Transport): Promise<bigint> {
  const client = getPublicClient(chain.id, transport);
  return retryOnRateLimit(() => client.getBalance({ address }));
}

export async function ensureSufficientGas(
  chainAddresses: [number, Address][],
  transports?: Record<number, Transport>,
  failOnInsufficientGas: boolean = true,
): Promise<[number, Address][]> {
  const deduplicated = [...new Set(chainAddresses.map(([chainId, address]) => `${chainId}:${getAddress(address)}`))];
  const insufficients: [number, Address, string, string][] = [];
  for (const chainAddress of deduplicated) {
    const [chainId, address] = chainAddress.split(":").map((v, i) => (i === 0 ? Number(v) : getAddress(v))) as [
      number,
      Address,
    ];
    const thresholdStr = getGasThresholdForChain(chainId);
    const thresholdWei = parseUnits(thresholdStr, 18);
    const balanceWei = await getNativeBalance(
      chains[chainId as keyof typeof chains] as Chain,
      address,
      transports?.[chainId as keyof typeof transports],
    );
    if (balanceWei < thresholdWei) {
      const human = formatUnits(balanceWei, 18);
      insufficients.push([chainId, address, human, thresholdStr]);
    }
  }

  if (failOnInsufficientGas && insufficients.length > 0) {
    const message = insufficients
      .map(([chainId, address, human, thresholdStr]) => {
        const chain = chains[chainId as keyof typeof chains] as Chain;
        const [chainName, symbol] = [chain.name, chain.nativeCurrency.symbol];
        return `Insufficient gas on ${chainName} for ${address}. Balance ${human} ${symbol} < required ${thresholdStr} ${symbol}. Please top up at https://gas.zip.`;
      })
      .join("\n");
    throw new Error(message);
  }
  return insufficients.map(([chainId, address]) => [chainId, address]);
}
