import { type Address, erc20Abi, getAddress, parseUnits, zeroAddress } from "viem";
import { STAKED_TOKENS } from "~/data/staked-tokens";
import { chainIdToZerionId } from "~/data/supported-chains";
import { getPublicClient } from "./public-client";
import { getTokenAmountInUsd, groupTokensByChain, isSameToken } from "./tokens";
import type { TokenAmount } from "./types";

function isEffectivelyZero(balance: number): boolean {
  return balance < 0.01; // Consider anything less than $0.01 as effectively zero
}

export const EXTRA_TOKENS = STAKED_TOKENS.map((token) => {
  const [chainId, address] = token.split(":") as [string, Address];
  return { chainId: Number(chainId), address: getAddress(address) };
});

// Zerion API Types
interface ZerionFungibleInfo {
  name: string;
  symbol: string;
  icon?: {
    url: string;
  } | null;
  implementations: Array<{
    chain_id: string;
    address: string | null;
    decimals: number;
  }>;
}

interface ZerionPositionAttributes {
  parent: string | null;
  protocol: string | null;
  name: string;
  position_type: string;
  quantity: {
    decimals: number;
    numeric: string;
  };
  value: number | null;
  price: number | null;
  fungible_info: ZerionFungibleInfo;
  flags: {
    displayable: boolean;
  };
  chain?: string; // Added: chain identifier for this position
}

interface ZerionPosition {
  type: string;
  id: string;
  attributes: ZerionPositionAttributes;
  relationships?: {
    chain?: {
      data?: {
        id: string;
        type: string;
      };
    };
  };
}

interface ZerionPositionsResponse {
  data: ZerionPosition[];
  links: {
    next?: string;
  };
}

// Odos pricing API response type
interface OdosPricingResponse {
  currencyId: string;
  tokenPrices: Record<string, number | null>;
}

async function fetchExtraTokenBalances(walletAddress: string): Promise<TokenAmount[]> {
  try {
    // Step 1: Group tokens by chainId for efficient multicall
    const tokensByChain = groupTokensByChain(EXTRA_TOKENS);

    // Step 2: Fetch all balances AND token metadata using multicall (one multicall per chain)
    const tokenAmounts: TokenAmount[] = [];

    await Promise.all(
      Array.from(tokensByChain.entries()).map(async ([chainId, tokens]) => {
        try {
          const publicClient = getPublicClient(chainId);
          // Build contracts array with balanceOf, name, symbol, decimals for each token
          const contracts = tokens.flatMap((token) => [
            {
              address: token.address,
              abi: erc20Abi,
              functionName: "balanceOf" as const,
              args: [walletAddress as Address],
            },
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

          // Process results - each token has 4 calls (balanceOf, name, symbol, decimals)
          for (let i = 0; i < tokens.length; i++) {
            const token = tokens[i];
            const baseIndex = i * 4;
            const balanceResult = results[baseIndex];
            const nameResult = results[baseIndex + 1];
            const symbolResult = results[baseIndex + 2];
            const decimalsResult = results[baseIndex + 3];

            if (
              balanceResult.status === "success" &&
              nameResult.status === "success" &&
              symbolResult.status === "success" &&
              decimalsResult.status === "success"
            ) {
              const amount = balanceResult.result as bigint;
              if (amount > 0n) {
                console.log(
                  `[ExtraTokens] Found ${token.address} on chain ${chainId} with balance ${amount.toString()}`,
                );
                tokenAmounts.push({
                  token: token.address,
                  amount,
                  chainId: token.chainId,
                  walletAddress: walletAddress as Address,
                  name: nameResult.result as string,
                  symbol: symbolResult.result as string,
                  decimals: decimalsResult.result as number,
                });
              }
            }
          }
        } catch (error) {
          console.error(`[ExtraTokens] Multicall failed for chain ${chainId}:`, error);
        }
      }),
    );

    // If no non-zero balances, return early
    if (tokenAmounts.length === 0) {
      return [];
    }

    // Step 3: Group tokens by chainId for Odos pricing API calls
    const tokensByChainForPricing = groupTokensByChain(tokenAmounts);

    // Step 4: Fetch prices from Odos API (one call per chain)
    await Promise.all(
      Array.from(tokensByChainForPricing.entries()).map(async ([chainId, tokens]) => {
        try {
          const url = new URL(`https://api.odos.xyz/pricing/token/${chainId}`);
          for (const token of tokens) {
            url.searchParams.append("token_addresses", token.token);
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

          // Update prices directly on token objects (Odos returns checksummed addresses)
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

    // Step 5: Filter out tokens with effectively zero USD value
    return tokenAmounts.filter((token) => {
      return !isEffectivelyZero(getTokenAmountInUsd(token));
    });
  } catch (error) {
    console.error("[ExtraTokens] Error fetching extra token balances:", error);
    return [];
  }
}

async function fetchTokenBalancesFromZerion(walletAddress: string): Promise<TokenAmount[]> {
  const apiKey = import.meta.env.VITE_ZERION_API_KEY;

  if (!apiKey) {
    throw new Error("VITE_ZERION_API_KEY is not set");
  }

  // Get all Zerion chain identifiers
  const zerionChainIds = Object.values(chainIdToZerionId).join(",");

  const results: TokenAmount[] = [];

  // Zerion API endpoint with filters for simple positions only
  const url = new URL(`https://cors.blossom.deno.net/v0/https://api.zerion.io/v1/wallets/${walletAddress}/positions/`);
  url.searchParams.append("filter[chain_ids]", zerionChainIds);
  url.searchParams.append("filter[positions]", "only_simple");
  url.searchParams.append("currency", "usd");

  // Encode API key for Basic authentication (API_KEY: format, then base64)
  const encodedAuth = btoa(`${apiKey}:`);

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Basic ${encodedAuth}`,
      accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Zerion API error: ${response.status} ${response.statusText}`);
  }

  const data: ZerionPositionsResponse = await response.json();

  for (const position of data.data) {
    try {
      const { attributes } = position;

      // Skip non-displayable positions
      if (!attributes.flags.displayable) {
        continue;
      }

      // Determine which chain this position belongs to
      const positionChainId =
        position.relationships?.chain?.data?.id || // From relationships (JSON:API standard)
        attributes.chain; // Or from attributes directly

      if (!positionChainId) {
        console.warn("Position missing chain identifier:", position.id);
        continue;
      }

      // Find the numeric chain ID from Zerion's chain identifier
      const chainId = Object.entries(chainIdToZerionId).find(([, zerionId]) => zerionId === positionChainId)?.[0];

      if (!chainId) {
        // This chain is not in our supported list, skip it
        continue;
      }

      // Get the implementation for THIS specific chain only
      const implementation = attributes.fungible_info.implementations.find((impl) => impl.chain_id === positionChainId);

      if (!implementation) {
        console.warn(`No implementation found for chain ${positionChainId} on position ${position.id}`);
        continue;
      }

      // Calculate exchange rate (price per token)
      const unitaryPrice = attributes.price || 0;

      // Get quantity - this is specific to THIS chain for THIS position
      const quantity = attributes.quantity.numeric;

      // Normalize token address
      // Zerion uses 0x0000000000000000000000000000000000001010 for Polygon native token (POL)
      // but we use zeroAddress (0x0000000000000000000000000000000000000000)
      const tokenAddress =
        implementation.address &&
        !(Number(chainId) === 137 && implementation.address === "0x0000000000000000000000000000000000001010")
          ? getAddress(implementation.address)
          : zeroAddress;

      const decimals = implementation.decimals;
      const amount = parseUnits(quantity, decimals);

      const tokenAmount: TokenAmount = {
        token: tokenAddress,
        amount,
        chainId: Number(chainId),
        walletAddress: walletAddress as Address,
        symbol: attributes.fungible_info.symbol,
        decimals,
        name: attributes.fungible_info.name,
        unitaryPrice,
      };

      // Skip tokens with effectively zero USD value
      if (isEffectivelyZero(getTokenAmountInUsd(tokenAmount))) {
        continue;
      }

      results.push(tokenAmount);
    } catch (error) {
      console.error(`Error processing token ${position.id}:`, error);
    }
  }

  return results;
}

export async function fetchTokenBalances(addresses: string[]): Promise<TokenAmount[]> {
  try {
    // If no addresses provided, return empty array
    if (addresses.length === 0) {
      console.log("No addresses provided, returning empty array");
      return [];
    }

    const tokens: TokenAmount[] = [];

    console.log(`Starting to fetch token balances for ${addresses.length} addresses across all networks...`);

    // Fire all requests concurrently for all addresses (fetching all chains at once per address)
    // Also fetch extra tokens that might not be indexed by Zerion's positions endpoint
    const results = await Promise.allSettled(
      addresses.flatMap((address) => {
        console.log(`Fetching tokens for address ${address} across all chains...`);
        return [
          // Regular Zerion positions
          fetchTokenBalancesFromZerion(address)
            .then((balances) => ({ address, balances, source: "zerion" as const }))
            .catch((error) => {
              throw { error, address };
            }),
          // Extra tokens via direct RPC + Odos price
          fetchExtraTokenBalances(address)
            .then((balances) => ({ address, balances, source: "extra" as const }))
            .catch((error) => {
              throw { error, address };
            }),
        ];
      }),
    );

    // Process results in order: Zerion first, then extra tokens
    // This ensures Zerion data is preferred when there are duplicates
    for (const result of results) {
      if (result.status === "fulfilled" && result.value.source === "zerion") {
        const { address, balances, source } = result.value;
        if (balances.length === 0) continue;
        console.log(`Received ${balances.length} token positions for address ${address} from ${source}`);
        tokens.push(...balances);
      }
    }

    // Process extra token results (deduplicate against Zerion using isSameToken)
    for (const result of results) {
      if (result.status === "fulfilled" && result.value.source === "extra") {
        const { address, balances, source } = result.value;
        if (balances.length === 0) continue;
        console.log(`Received ${balances.length} token positions for address ${address} from ${source}`);

        for (const tokenAmount of balances) {
          if (tokens.some((t) => isSameToken(t, tokenAmount))) {
            console.log(`[ExtraTokens] Skipping ${tokenAmount.symbol} - already in Zerion positions`);
            continue;
          }
          tokens.push(tokenAmount);
        }
      }
    }

    const failedResults = results.filter((r) => r.status === "rejected");

    // Log failed results
    for (const result of failedResults) {
      if (result.status === "rejected") {
        const { address, error } = result.reason as { error: unknown; address?: string };
        if (address !== undefined) {
          console.error(`Error processing address ${address}:`, error);
        } else {
          console.error(`Error fetching token balances:`, result.reason);
        }
      }
    }
    console.log("TOKENS", tokens);
    console.log(`Processed ${tokens.length} tokens with non-zero balances`);

    // Sort by USD value (descending)
    tokens.sort((a, b) => getTokenAmountInUsd(b) - getTokenAmountInUsd(a));

    return tokens;
  } catch (error) {
    console.error("Error fetching token balances:", error);
    return []; // Return empty array on error
  }
}
