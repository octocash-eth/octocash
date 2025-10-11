import type { Address } from "viem";
import type { TokenAmount, TransactionStep } from "../app/lib/types";

export const USDC_ETHEREUM = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address;
export const USDC_POLYGON = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359" as Address;
export const USDC_OPTIMISM = "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85" as Address;
export const WBTC_ADDRESS = "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599" as Address;
export const DAI_ADDRESS = "0x6B175474E89094C44Da98b954EedeAC495271d0F" as Address;
export const USDT_ADDRESS = "0xdAC17F958D2ee523a2206206994597C13D831ec7" as Address;
export const ETH_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;
export const WALLET = "0x1234567890123456789012345678901234567890" as Address;

/**
 * Helper to create test TokenAmount
 */
export const makeToken = (
  token: Address,
  amount: bigint,
  chainId: number,
  walletAddress: Address = WALLET,
  symbol = "USDC",
  decimals = 6,
): TokenAmount => ({
  token,
  amount,
  chainId,
  walletAddress,
  symbol,
  decimals,
});

/**
 * Helper to create test TransactionStep
 */
export const makeStep = (
  id: string,
  dependsOn: string[] = [],
  partialDependency = false,
): TransactionStep => ({
  id,
  type: "swap",
  status: "pending",
  chainId: 1,
  inputTokens: [],
  outputToken: makeToken("0x456" as Address, 1000n, 1, WALLET, "USDC", 6),
  dependsOn,
  partialDependency,
});

/**
 * Helper to consume generator and collect all yielded values
 * @param generator - The generator instance to consume
 * @param maxValues - Optional limit on how many values to consume before stopping
 */
export async function consumeGenerator<TYield>(
  generator: AsyncGenerator<TYield>,
  maxValues?: number,
): Promise<{ finalValue: TYield; values: TYield[] }> {
  const values: TYield[] = [];

  let finalValue: TYield | undefined;
  for await (const value of generator) {
    values.push(value);
    finalValue = value;
    
    if (maxValues !== undefined && values.length >= maxValues) {
      break;
    }
  }

  if (finalValue === undefined) {
    throw new Error("Generator did not yield any values");
  }

  return { finalValue, values };
}

