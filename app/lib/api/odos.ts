import { type Address, erc20Abi } from "viem";
import { STAKED_TOKENS } from "~/data/staked-tokens";
import { getPublicClient } from "../public-client";
import { getTokenAmountInUsd, groupTokensByChain } from "../tokens";
import type { TokenAmount } from "../types";

function isEffectivelyZero(balance: number): boolean {
  return balance < 0.01; // Consider anything less than $0.01 as effectively zero
}

export const EXTRA_TOKENS = STAKED_TOKENS.map((token) => {
  const [chainId, address] = token.split(":") as [string, Address];
  return { chainId: Number(chainId), address: address as Address };
});

// Odos pricing API response type
interface OdosPricingResponse {
  currencyId: string;
  tokenPrices: Record<string, number | null>;
}

/** Fetch extra token balances via RPC (slower, for tokens not indexed by Zerion) */
export async function fetchExtraTokenBalances(walletAddresses: string[]): Promise<TokenAmount[]> {
  try {
    if (walletAddresses.length === 0) return [];

    // Step 1: Group tokens by chainId for efficient multicall
    const tokensByChain = groupTokensByChain(EXTRA_TOKENS);
    const nonEmptyBalances: {
      chainId: number;
      tokenAddress: Address;
      walletAddress: Address;
      amount: bigint;
    }[] = [];

    // Step 2: Check balances for ALL wallets and ALL tokens using multicall
    await Promise.all(
      Array.from(tokensByChain.entries()).map(async ([chainId, tokens]) => {
        try {
          const publicClient = getPublicClient(chainId);

          // For each token, check balance for each wallet
          // We flatten this into a single list of calls
          const contracts = tokens.flatMap((token) =>
            walletAddresses.map((walletAddress) => ({
              address: token.address,
              abi: erc20Abi,
              functionName: "balanceOf" as const,
              args: [walletAddress as Address],
            })),
          );

          // Execute multicall
          const results = await publicClient.multicall({
            contracts,
            allowFailure: true,
          });

          // Process results
          // The order matches: tokens[0] -> (wallets[0], wallets[1]...), tokens[1] -> ...
          let resultIndex = 0;
          for (const token of tokens) {
            for (const walletAddress of walletAddresses) {
              const result = results[resultIndex++];

              if (result.status === "success" && (result.result as bigint) > 0n) {
                nonEmptyBalances.push({
                  chainId,
                  tokenAddress: token.address,
                  walletAddress: walletAddress as Address,
                  amount: result.result as bigint,
                });
              }
            }
          }
        } catch (error) {
          console.error(`[ExtraTokens] Balance multicall failed for chain ${chainId}:`, error);
        }
      }),
    );

    // If no non-zero balances, return early
    if (nonEmptyBalances.length === 0) {
      return [];
    }

    // Step 3: Fetch metadata ONLY for tokens with non-zero balances
    // We need unique tokens per chain to avoid fetching metadata twice for the same token
    const uniqueTokensWithBalance = nonEmptyBalances.reduce((acc, item) => {
      const key = `${item.chainId}:${item.tokenAddress}`;
      if (!acc.has(key)) {
        acc.set(key, { chainId: item.chainId, address: item.tokenAddress });
      }
      return acc;
    }, new Map<string, { chainId: number; address: Address }>());

    const tokensToFetchMetadata = groupTokensByChain(Array.from(uniqueTokensWithBalance.values()));
    const tokenMetadata = new Map<string, { name: string; symbol: string; decimals: number }>();

    await Promise.all(
      Array.from(tokensToFetchMetadata.entries()).map(async ([chainId, tokens]) => {
        try {
          const publicClient = getPublicClient(chainId);
          const contracts = tokens.flatMap((token) => [
            {
              address: token.address,
              abi: erc20Abi,
              functionName: "name" as const,
            },
            {
              address: token.address,
              abi: erc20Abi,
              functionName: "symbol" as const,
            },
            {
              address: token.address,
              abi: erc20Abi,
              functionName: "decimals" as const,
            },
          ]);

          const results = await publicClient.multicall({
            contracts,
            allowFailure: true,
          });

          for (let i = 0; i < tokens.length; i++) {
            const token = tokens[i];
            const baseIndex = i * 3;
            const nameResult = results[baseIndex];
            const symbolResult = results[baseIndex + 1];
            const decimalsResult = results[baseIndex + 2];

            if (
              nameResult.status === "success" &&
              symbolResult.status === "success" &&
              decimalsResult.status === "success"
            ) {
              const key = `${chainId}:${token.address}`;
              tokenMetadata.set(key, {
                name: nameResult.result as string,
                symbol: symbolResult.result as string,
                decimals: decimalsResult.result as number,
              });
            }
          }
        } catch (error) {
          console.error(`[ExtraTokens] Metadata multicall failed for chain ${chainId}:`, error);
        }
      }),
    );

    // Step 4: Construct initial TokenAmount objects
    const tokenAmounts: TokenAmount[] = [];
    for (const item of nonEmptyBalances) {
      const metadata = tokenMetadata.get(`${item.chainId}:${item.tokenAddress}`);
      if (metadata) {
        tokenAmounts.push({
          token: item.tokenAddress,
          amount: item.amount,
          chainId: item.chainId,
          walletAddress: item.walletAddress,
          name: metadata.name,
          symbol: metadata.symbol,
          decimals: metadata.decimals,
        });
      }
    }

    if (tokenAmounts.length === 0) return [];

    // Step 5: Group tokens by chainId for Odos pricing API calls
    const tokensByChainForPricing = groupTokensByChain(tokenAmounts);

    // Step 6: Fetch prices from Odos API (one call per chain)
    await Promise.all(
      Array.from(tokensByChainForPricing.entries()).map(async ([chainId, tokens]) => {
        try {
          // Identify unique token addresses to avoid duplicate params in URL
          const uniqueAddresses = new Set(tokens.map((t) => t.token));

          const url = new URL(`https://api.odos.xyz/pricing/token/${chainId}`);
          for (const address of uniqueAddresses) {
            url.searchParams.append("token_addresses", address);
          }

          const response = await fetch(url.toString(), {
            headers: {
              accept: "application/json",
            },
          });

          if (!response.ok) {
            console.warn(`[ExtraTokens] Failed to fetch Odos prices for chain ${chainId}: ${response.status}`);
            return;
          }

          const data: OdosPricingResponse = await response.json();

          // Update prices directly on token objects
          for (const token of tokens) {
            const price = data.tokenPrices[token.token] ?? data.tokenPrices[token.token.toLowerCase()];
            if (price !== null && price !== undefined) {
              token.unitaryPrice = price;
            }
          }
        } catch (error) {
          console.error(`[ExtraTokens] Odos pricing API failed for chain ${chainId}:`, error);
        }
      }),
    );

    // Step 7: Filter out tokens with effectively zero USD value
    return tokenAmounts.filter((token) => {
      return !isEffectivelyZero(getTokenAmountInUsd(token));
    });
  } catch (error) {
    console.error("[ExtraTokens] Error fetching extra token balances:", error);
    return [];
  }
}
