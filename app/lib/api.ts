import { type Address, getAddress, parseUnits, zeroAddress } from "viem";
import { chainIdToZerionId } from "~/data/supported-chains";
import { getTokenAmountInUsd } from "./tokens";
import type { TokenAmount } from "./types";

function isEffectivelyZero(balance: number): boolean {
  return balance < 0.01; // Consider anything less than $0.01 as effectively zero
}

interface TokenBalance {
  symbol: string;
  name: string;
  address: Address;
  decimals: string;
  exchange_rate: string;
  value: string;
  icon_url: string;
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

interface TokenBalanceWithChain extends TokenBalance {
  chainId: number;
}

async function fetchTokenBalancesFromZerion(address: string): Promise<TokenBalanceWithChain[]> {
  const apiKey = import.meta.env.VITE_ZERION_API_KEY;

  if (!apiKey) {
    throw new Error("VITE_ZERION_API_KEY is not set");
  }

  // Get all Zerion chain identifiers
  const zerionChainIds = Object.values(chainIdToZerionId).join(",");

  const balances: TokenBalanceWithChain[] = [];

  // Zerion API endpoint with filters for simple positions only
  const url = new URL(`https://cors.blossom.deno.net/v0/https://api.zerion.io/v1/wallets/${address}/positions/`);
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
    const price = attributes.price || 0;

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

    balances.push({
      symbol: attributes.fungible_info.symbol,
      name: attributes.fungible_info.name,
      address: tokenAddress,
      decimals: implementation.decimals.toString(),
      exchange_rate: price.toString(),
      value: quantity,
      icon_url: attributes.fungible_info.icon?.url || "",
      chainId: Number(chainId),
    });
  }

  return balances;
}

function buildTokenAmountsFromBalances(
  tokenBalances: TokenBalance[],
  walletAddress: string,
  chainId: number,
): TokenAmount[] {
  const results: TokenAmount[] = [];

  for (const token of tokenBalances) {
    try {
      const decimals = Number(token.decimals);
      const unitaryPrice = Number(token.exchange_rate);

      // Convert the formatted decimal string to bigint
      const amount = parseUnits(token.value, decimals);

      const tokenAmount: TokenAmount = {
        token: token.address,
        amount,
        chainId,
        walletAddress: walletAddress as Address,
        symbol: token.symbol,
        decimals,
        name: token.name,
        unitaryPrice,
      };

      // Skip tokens with effectively zero USD value
      if (isEffectivelyZero(getTokenAmountInUsd(tokenAmount))) {
        continue;
      }

      results.push(tokenAmount);
    } catch (error) {
      console.error(`Error processing token ${token.address}:`, error);
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
    const results = await Promise.allSettled(
      addresses.map((address) => {
        console.log(`Fetching tokens for address ${address} across all chains...`);
        return fetchTokenBalancesFromZerion(address)
          .then((balances) => ({ address, balances }))
          .catch((error) => {
            // Preserve context for error handling after all promises settle
            throw { error, address };
          });
      }),
    );

    for (const result of results) {
      if (result.status === "fulfilled") {
        const { address, balances } = result.value;
        if (balances.length === 0) {
          console.log(`No tokens found for address ${address}`);
          continue;
        }
        console.log(`Received ${balances.length} token positions for address ${address}`);

        // Group balances by chain and process them
        for (const balance of balances) {
          tokens.push(...buildTokenAmountsFromBalances([balance], address, balance.chainId));
        }
      } else {
        const { address, error } = result.reason as { error: unknown; address?: string };
        if (address !== undefined) {
          console.error(`Error processing address ${address}:`, error);
        } else {
          console.error(`Error fetching token balances:`, result.reason);
        }
      }
    }
    console.log(tokens);
    console.log(`Processed ${tokens.length} tokens with non-zero balances`);

    // Sort by USD value (descending)
    tokens.sort((a, b) => getTokenAmountInUsd(b) - getTokenAmountInUsd(a));

    return tokens;
  } catch (error) {
    console.error("Error fetching token balances:", error);
    return []; // Return empty array on error
  }
}
