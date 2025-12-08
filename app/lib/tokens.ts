import {
  type Address,
  type Call,
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  getAddress,
  isAddressEqual,
  zeroAddress,
} from "viem";
import { supportedChains } from "~/data/supported-chains";
import { getPublicClient } from "~/lib/public-client";
import type { TokenAmount } from "~/lib/types";
import { tryCatch } from "./utils";

// ============================================================================
// Token Utility Functions
// ============================================================================

/**
 * Generate a unique ID for a token from its properties
 */
export function getTokenId(token: TokenAmount): string {
  return `${token.walletAddress}-${token.token}-${token.chainId}`;
}

/**
 * Get the icon URL for a token based on chain ID and token address
 */
export function getTokenIconUrl(chainId: number, tokenAddress: Address): string {
  return `https://assets.octo.cash/token/${chainId}/${tokenAddress}`;
}

/**
 * Checks if two tokens are the same (ignoring wallet address if specified)
 */
export function isSameToken(
  token1: { token: Address; chainId: number; walletAddress?: Address },
  token2: { token: Address; chainId: number; walletAddress?: Address },
  ignoreWallet = false,
): boolean {
  return (
    isAddressEqual(token1.token, token2.token) &&
    token1.chainId === token2.chainId &&
    (ignoreWallet || isAddressEqual(token1.walletAddress ?? zeroAddress, token2.walletAddress ?? zeroAddress))
  );
}

/**
 * Get the chain name from a chain ID
 */
export function getChainName(chainId: number): string {
  const chain = supportedChains.find((c) => c.id === chainId);
  return chain?.name ?? `Chain-${chainId}`;
}

/**
 * Calculate the USD value of a token amount
 */
export function getTokenAmountInUsd(token: TokenAmount): number {
  if (token.unitaryPrice === undefined) {
    return 0;
  }
  const formattedAmount = Number(formatUnits(token.amount, token.decimals));
  return formattedAmount * token.unitaryPrice;
}

/**
 * Format a token amount for display
 */
export function formatTokenAmount(token: TokenAmount): string {
  return formatUnits(token.amount, token.decimals);
}

/**
 * Format a number as USD currency
 * @param amount - The amount to format
 * @param decimals - Number of decimal places (default: 2)
 */
export function formatUsd(amount: number, decimals = 2): string {
  return amount.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

// ============================================================================
// Token Grouping and Consolidation
// ============================================================================

/**
 * Groups tokens by chain ID for efficient batch processing per chain
 *
 * @param tokens - Array of objects with chainId property
 * @returns Map of chainId to array of tokens on that chain
 */
export function groupTokensByChain<T extends { chainId: number }>(tokens: T[]): Map<number, T[]> {
  const grouped = new Map<number, T[]>();

  for (const token of tokens) {
    const existing = grouped.get(token.chainId) ?? [];
    existing.push(token);
    grouped.set(token.chainId, existing);
  }

  return grouped;
}

/**
 * Groups source tokens by chain and wallet address for efficient processing
 *
 * @param sourceTokens - Array of tokens to group
 * @returns Array of token groups, where each group represents tokens from the same chain and wallet
 *
 * @example
 * // Returns:
 * [[token1, token2], [token3]]
 */
export function groupTokensByChainAndWallet(sourceTokens: TokenAmount[]): TokenAmount[][] {
  const grouped = new Map<string, TokenAmount[]>();

  for (const token of sourceTokens) {
    const key = `${token.chainId}-${token.walletAddress}`;
    if (!grouped.has(key)) {
      grouped.set(key, []);
    }
    grouped.get(key)?.push(token);
  }

  return Array.from(grouped.values());
}

/**
 * Consolidates tokens by summing amounts for duplicate token addresses
 *
 * @param tokens - Array of tokens to consolidate
 * @returns Array of consolidated tokens with summed amounts
 *
 * @example
 * // Consolidate tokens across same chain/wallet/token
 * const consolidated = consolidateTokenAmounts(tokens);
 */
export function consolidateTokenAmounts(tokens: TokenAmount[]): TokenAmount[] {
  const consolidatedMap = new Map<string, TokenAmount>();

  for (const token of tokens) {
    const tokenAddress = getAddress(token.token);
    const keyParts = [token.chainId.toString(), tokenAddress, getAddress(token.walletAddress)];
    const key = keyParts.join("-");

    const existing = consolidatedMap.get(key);
    if (existing) {
      consolidatedMap.set(key, {
        ...existing,
        amount: existing.amount + token.amount,
      });
    } else {
      consolidatedMap.set(key, {
        ...token,
        token: tokenAddress,
      });
    }
  }

  return Array.from(consolidatedMap.values());
}

/**
 * Builds ERC20 approval calls for the given tokens if needed.
 * Automatically deduplicates identical tokens (same chain, wallet, and token address) and sums their amounts.
 * Checks current allowance and only creates approval call if insufficient.
 * @param tokens - Single token or array of tokens to approve.
 * @param spender - The spender address (router, contract, etc).
 * @returns Array of approval calls needed.
 */
export async function buildERC20ApprovalCalls(tokens: TokenAmount | TokenAmount[], spender: Address): Promise<Call[]> {
  const tokenArray = Array.isArray(tokens) ? tokens : [tokens];
  const calls: Call[] = [];

  if (tokenArray.length === 0) {
    return calls;
  }

  const chainId = tokenArray[0]?.chainId;
  if (!chainId) {
    return calls;
  }

  const publicClient = getPublicClient(chainId);

  // Consolidate duplicate tokens by summing amounts for approval
  const uniqueTokens = consolidateTokenAmounts(tokenArray);

  // Process each unique token with summed amounts
  for (const t of uniqueTokens) {
    // Skip native coin (it doesn't need to be approved)
    if (t.token === zeroAddress) continue;

    // Skip tokens that don't need to be approved
    if (t.amount === 0n) continue;

    // Check current allowance
    const [currentAllowance] = await tryCatch(
      publicClient.readContract({
        address: t.token,
        abi: erc20Abi,
        functionName: "allowance",
        args: [t.walletAddress, spender],
      }),
    );

    // Only approve if current allowance is insufficient
    if ((currentAllowance ?? 0n) < t.amount) {
      calls.push({
        to: t.token,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: "approve",
          args: [spender, t.amount],
        }),
      });
    }
  }

  return calls;
}
