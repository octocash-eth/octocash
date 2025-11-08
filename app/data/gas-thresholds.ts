import { base, mainnet, polygon } from "viem/chains";
// Simple per-chain native gas thresholds (in native units, not wei)
// These are arbitrary minimums to ensure there is enough gas to submit transactions.
// If a chain is missing, the default threshold will be used.

export const defaultGasThreshold = "0.0005"; // 0.0005 native token

export const gasThresholds: Record<number, string> = {
  // Add chain-specific overrides here if needed.
  [mainnet.id]: "0.002", // Ethereum Mainnet
  [polygon.id]: "0.02", // Polygon
  [base.id]: "0.001", // Base
};

export function getGasThresholdForChain(chainId: number): string {
  return gasThresholds[chainId] ?? defaultGasThreshold;
}
