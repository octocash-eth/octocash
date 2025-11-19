import { type Address, getAddress, zeroAddress } from "viem";
import type { WalletData } from "~/components/wallet-table/columns";
import { chainIdToZerionId, supportedChains } from "~/data/supported-chains";

// Mapping of chain IDs to readable names
const chainIdToName: Record<number, string> = {
  ...supportedChains.reduce(
    (acc, chain) => {
      acc[chain.id] = chain.name;
      return acc;
    },
    {} as Record<number, string>,
  ),
};

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

    balances.push({
      symbol: attributes.fungible_info.symbol,
      name: attributes.fungible_info.name,
      address: implementation.address ? getAddress(implementation.address) : zeroAddress,
      decimals: implementation.decimals.toString(),
      exchange_rate: price.toString(),
      value: quantity,
      icon_url: attributes.fungible_info.icon?.url || "",
      chainId: Number(chainId),
    });
  }

  return balances;
}

function buildWalletDataFromTokens(tokenBalances: TokenBalance[], address: string, chainId: number): WalletData[] {
  const results: WalletData[] = [];

  for (const token of tokenBalances) {
    try {
      // Zerion returns quantity.numeric as already-formatted decimal string
      // So we can use it directly without formatUnits conversion
      const balance = token.value;
      const exchangeRate = Number(token.exchange_rate);
      const amountInUsd = parseFloat(balance) * exchangeRate;

      if (isEffectivelyZero(amountInUsd)) {
        continue;
      }

      results.push({
        id: `${address}-${token.address}-${chainId}`,
        wallet: address as Address,
        token: token.symbol,
        tokenName: token.name,
        tokenAddress: token.address as Address,
        chain: chainIdToName[chainId] || `Chain-${chainId}`,
        amount: balance,
        amountInUsd: amountInUsd,
        iconUrl: `https://assets.octo.cash/token/${chainId}/${token.address}`,
        decimals: Number(token.decimals),
      });
    } catch (error) {
      console.error(`Error processing token ${token.address}:`, error);
    }
  }

  return results;
}

export async function fetchTokenBalances(addresses: string[]): Promise<WalletData[]> {
  try {
    // If no addresses provided, return empty array
    if (addresses.length === 0) {
      console.log("No addresses provided, returning empty array");
      return [];
    }

    const walletData: WalletData[] = [];

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
          walletData.push(...buildWalletDataFromTokens([balance], address, balance.chainId));
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
    console.log(walletData);
    console.log(`Processed ${walletData.length} tokens with non-zero balances`);

    // Sort wallet data by USD value (descending)
    walletData.sort((a, b) => b.amountInUsd - a.amountInUsd);

    return walletData;
  } catch (error) {
    console.error("Error fetching token balances:", error);
    return []; // Return empty array on error
  }
}
