import { type Address, getAddress, parseUnits, zeroAddress } from "viem";
import { chainIdToZerionId, chains } from "~/data/supported-chains";
import { getPublicClient } from "../public-client";
import { getTokenAmountInUsd } from "../tokens";
import type { TokenAmount } from "../types";

function isEffectivelyZero(balance: number): boolean {
  return balance < 0.01; // Consider anything less than $0.01 as effectively zero
}

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

/** Fallback: fetch native coin balances via RPC for local testing without a Zerion API key. */
async function fetchNativeBalances(addresses: string[]): Promise<TokenAmount[]> {
  const supportedChainIds = Object.keys(chainIdToZerionId).map(Number);

  const results = await Promise.all(
    addresses.flatMap((walletAddress) =>
      supportedChainIds.map(async (chainId): Promise<TokenAmount | null> => {
        try {
          const publicClient = getPublicClient(chainId);
          const balance = await publicClient.getBalance({ address: walletAddress as Address });
          if (balance === 0n) return null;
          const chain = chains[chainId as keyof typeof chains];
          return {
            token: zeroAddress,
            amount: balance,
            chainId,
            walletAddress: walletAddress as Address,
            symbol: chain.nativeCurrency.symbol,
            decimals: chain.nativeCurrency.decimals,
            name: chain.nativeCurrency.name,
          };
        } catch (error) {
          console.error(`Failed to fetch native balance for ${walletAddress} on chain ${chainId}:`, error);
          return null;
        }
      }),
    ),
  );

  return results.filter((t): t is TokenAmount => t !== null);
}

/** Fetch token balances from Zerion (fast, indexed data) */
export async function fetchZerionTokenBalances(addresses: string[]): Promise<TokenAmount[]> {
  if (addresses.length === 0) return [];

  const apiKey = import.meta.env.VITE_ZERION_API_KEY;
  if (!apiKey) {
    console.warn("VITE_ZERION_API_KEY is not set; falling back to native coin balances via RPC");
    return fetchNativeBalances(addresses);
  }

  // Get all Zerion chain identifiers
  const zerionChainIds = Object.values(chainIdToZerionId).join(",");

  const results = await Promise.all(
    addresses.map(async (walletAddress) => {
      try {
        // Zerion API endpoint with filters for simple positions only
        const url = new URL(
          `https://cors.blossom.deno.net/v0/https://api.zerion.io/v1/wallets/${walletAddress}/positions/`,
        );
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
        const tokens: TokenAmount[] = [];

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
            const implementation = attributes.fungible_info.implementations.find(
              (impl) => impl.chain_id === positionChainId,
            );

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

            tokens.push(tokenAmount);
          } catch (error) {
            console.error(`Error processing token ${position.id}:`, error);
          }
        }

        return tokens;
      } catch (error) {
        console.error(`Error fetching Zerion tokens for ${walletAddress}:`, error);
        return [] as TokenAmount[];
      }
    }),
  );

  // Flatten results from all addresses (sorting happens in the UI)
  return results.flat();
}
