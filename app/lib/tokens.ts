import { type Address, type Call, encodeFunctionData, erc20Abi, getAddress, zeroAddress } from "viem";
import { getPublicClient } from "~/lib/public-client";
import type { TokenAmount } from "~/lib/types";
import { tryCatch } from "./utils";

/**
 * Groups source tokens by chain and wallet address for efficient processing
 *
 * @param sourceTokens - Array of tokens to group
 * @param consolidateAmounts - If true, consolidates duplicate token addresses by summing amounts
 * @returns Array of token groups, where each group represents tokens from the same chain and wallet
 *
 * @example
 * // Returns:
 * [[token1, token2], [token3]]
 */
export function groupTokensByChainAndWallet(sourceTokens: TokenAmount[], consolidateAmounts = false): TokenAmount[][] {
  const grouped = new Map<string, TokenAmount[]>();

  for (const token of sourceTokens) {
    const key = `${token.chainId}-${token.walletAddress}`;
    if (!grouped.has(key)) {
      grouped.set(key, []);
    }
    grouped.get(key)?.push(token);
  }

  // Consolidate duplicate token addresses if requested
  if (consolidateAmounts) {
    for (const [key, tokens] of grouped.entries()) {
      const consolidatedMap = new Map<Address, TokenAmount>();

      for (const token of tokens) {
        const normalizedAddress = getAddress(token.token);
        const existing = consolidatedMap.get(normalizedAddress);

        if (existing) {
          // Sum the amounts for duplicate tokens
          consolidatedMap.set(normalizedAddress, {
            ...existing,
            amount: existing.amount + token.amount,
          });
        } else {
          consolidatedMap.set(normalizedAddress, {
            ...token,
            token: normalizedAddress,
          });
        }
      }

      grouped.set(key, Array.from(consolidatedMap.values()));
    }
  }

  return Array.from(grouped.values());
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
  const uniqueTokens = groupTokensByChainAndWallet(tokenArray, true).flat();

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
