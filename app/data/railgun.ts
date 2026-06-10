import type { Address } from "viem";
import { arbitrum, mainnet, polygon } from "viem/chains";
import { USDC, WBTC, WETH } from "./token-contracts";

/**
 * Chains where the Railgun privacy system is deployed (and that we support as
 * shield destinations). Must stay a subset of `chains` in supported-chains.ts.
 */
export const RAILGUN_SUPPORTED_CHAINS: readonly number[] = [mainnet.id, polygon.id, arbitrum.id];

/**
 * RailgunSmartWallet proxy per chain — the entry point for `shield()` calls
 * and the holder of all shielded ERC20 balances (so `balanceOf(proxy)` is the
 * pool's TVL for a token).
 *
 * Source: `NETWORK_CONFIG` in @railgun-community/shared-models.
 */
export const RAILGUN_PROXY: Record<number, Address> = {
  [mainnet.id]: "0xFA7093CDD9EE6932B4eb2c9e1cde7CE00B1FA4b9",
  [polygon.id]: "0x19B620929f97b7b990801496c3b361CA5dEf8C71",
  [arbitrum.id]: "0xFA7093CDD9EE6932B4eb2c9e1cde7CE00B1FA4b9",
};

/** Railgun protocol shield fee: 0.25% of the deposited amount. */
export const RAILGUN_SHIELD_FEE_BPS = 25n;

/** Denominator for basis-point math. */
export const BPS_DENOMINATOR = 10_000n;

/**
 * Pools holding less than this much USD of a token are flagged as
 * low-privacy: a deposit into a small pool is easier to correlate with its
 * later unshield.
 */
export const LOW_PRIVACY_TVL_USD = 1_000_000;

export interface RailgunTokenOption {
  address: Address;
  symbol: string;
  name: string;
  decimals: number;
}

/**
 * Recommended shield tokens for a Railgun-supported chain: WETH, USDC, WBTC.
 * Native coins can't be shielded (Railgun only accepts ERC20s), hence WETH
 * instead of ETH.
 */
export function getRailgunTokenOptions(chainId: number): RailgunTokenOption[] {
  if (!RAILGUN_SUPPORTED_CHAINS.includes(chainId)) return [];

  const options: RailgunTokenOption[] = [];
  if (WETH[chainId]) {
    options.push({ address: WETH[chainId], symbol: "WETH", name: "Wrapped Ether", decimals: 18 });
  }
  if (USDC[chainId]) {
    options.push({ address: USDC[chainId], symbol: "USDC", name: "USD Coin", decimals: 6 });
  }
  if (WBTC[chainId]) {
    options.push({ address: WBTC[chainId], symbol: "WBTC", name: "Wrapped BTC", decimals: 8 });
  }
  return options;
}
