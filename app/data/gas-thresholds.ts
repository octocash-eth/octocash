// Simple per-chain native gas thresholds (in native units, not wei)
// These are arbitrary minimums to ensure there is enough gas to submit transactions.
// If a chain is missing, the default threshold will be used.

export const defaultGasThreshold = "0.0001"; // 0.0001 native token

export const gasThresholds: Record<number, string> = {
  // Add chain-specific overrides here if needed.
  1: "0.002", // Ethereum Mainnet
  137: "0.02", // Polygon
};

export function getGasThresholdForChain(chainId: number): string {
  return gasThresholds[chainId] ?? defaultGasThreshold;
}
