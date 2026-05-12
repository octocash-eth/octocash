import { type Address, erc20Abi, formatUnits, isAddressEqual, zeroAddress } from "viem";
import { STAKED_TOKENS } from "~/data/staked-tokens";
import { getPublicClient } from "../public-client";
import { groupTokensByChain } from "../tokens";
import type { TokenAmount } from "../types";

function isEffectivelyZero(balance: number): boolean {
  return balance < 0.01; // Consider anything less than $0.01 as effectively zero
}

/**
 * USD value derived from the Odos-stamped `unitaryPrice`. Used only to drop
 * dust positions before returning to the caller.
 */
function odosTokenAmountInUsd(token: TokenAmount): number {
  if (token.unitaryPrice === undefined) return 0;
  return Number(formatUnits(token.amount, token.decimals)) * token.unitaryPrice;
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

// Odos uses this sentinel for native tokens (ETH/POL/etc.) instead of zeroAddress.
const ODOS_NATIVE_SENTINEL = "0xEeeeeEeeeEeEeeEeEeEEEEeeeEeEeEEEeEEEeEEE" as Address;

export type OdosPriceKey = `${number}:${string}`;
export const odosPriceKey = (chainId: number, address: Address): OdosPriceKey => `${chainId}:${address.toLowerCase()}`;

/**
 * Fetch Odos token prices for the given (chainId, token) pairs.
 *
 * - Groups by chainId, dedupes addresses, issues one fetch per chain in parallel.
 * - For native tokens (zeroAddress), sends Odos's native sentinel address but keys
 *   the result back with zeroAddress so callers always look up with zeroAddress.
 * - Returned map keys are `${chainId}:${lowercase address}`. Use `odosPriceKey()`.
 * - Per-chain failures are swallowed and logged; missing keys mean "no price".
 */
export async function fetchOdosPrices(
  tokens: ReadonlyArray<Pick<TokenAmount, "chainId" | "token">>,
  signal?: AbortSignal,
): Promise<Map<OdosPriceKey, number>> {
  const prices = new Map<OdosPriceKey, number>();
  if (tokens.length === 0) return prices;

  const byChain = groupTokensByChain(tokens.map((t) => ({ chainId: t.chainId, token: t.token })));

  await Promise.all(
    Array.from(byChain.entries()).map(async ([chainId, chainTokens]) => {
      try {
        // Dedupe addresses (case-insensitive); remember which originals each address belongs to.
        const uniqueAddresses = new Set<string>();
        for (const t of chainTokens) {
          uniqueAddresses.add(t.token.toLowerCase());
        }

        // Substitute zeroAddress with the Odos native sentinel for the request.
        const requestAddresses: string[] = [];
        for (const addr of uniqueAddresses) {
          requestAddresses.push(
            isAddressEqual(addr as Address, zeroAddress) ? ODOS_NATIVE_SENTINEL : (addr as Address),
          );
        }

        const url = new URL(`https://api.odos.xyz/pricing/token/${chainId}`);
        for (const addr of requestAddresses) {
          url.searchParams.append("token_addresses", addr);
        }

        const response = await fetch(url.toString(), {
          headers: { accept: "application/json" },
          signal,
        });

        if (!response.ok) {
          console.warn(`[OdosPrices] Failed to fetch prices for chain ${chainId}: ${response.status}`);
          return;
        }

        const data: OdosPricingResponse = await response.json();

        // Build a lowercase-keyed view of the response for case-insensitive lookup.
        const tokenPricesLc: Record<string, number | null> = {};
        for (const [k, v] of Object.entries(data.tokenPrices)) {
          tokenPricesLc[k.toLowerCase()] = v;
        }

        for (const addr of uniqueAddresses) {
          const lookup = isAddressEqual(addr as Address, zeroAddress) ? ODOS_NATIVE_SENTINEL.toLowerCase() : addr;
          const price = tokenPricesLc[lookup];
          if (price !== null && price !== undefined) {
            prices.set(odosPriceKey(chainId, addr as Address), price);
          }
        }
      } catch (error) {
        if (signal?.aborted) return;
        console.error(`[OdosPrices] Odos pricing API failed for chain ${chainId}:`, error);
      }
    }),
  );

  return prices;
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

    // Step 5–6: Fetch Odos prices and assign to tokens
    const prices = await fetchOdosPrices(tokenAmounts);
    for (const token of tokenAmounts) {
      const price = prices.get(odosPriceKey(token.chainId, token.token));
      if (price !== undefined) {
        token.unitaryPrice = price;
      }
    }

    // Step 7: Filter out tokens with effectively zero USD value
    return tokenAmounts.filter((token) => {
      return !isEffectivelyZero(odosTokenAmountInUsd(token));
    });
  } catch (error) {
    console.error("[ExtraTokens] Error fetching extra token balances:", error);
    return [];
  }
}
