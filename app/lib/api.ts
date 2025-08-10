import { type Address, formatUnits, zeroAddress } from "viem";
import type { WalletData } from "~/components/wallet-table/columns";
import { blockExplorers, supportedChains } from "~/data/supported-chains";

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

// Function to convert balance with proper decimals
function convertBalance(balance: string, decimals: number, exchangeRate: number): [string, number] {
  try {
    // Check if the balance is zero
    if (balance === "0" || balance === "") {
      return ["0", 0];
    }

    // Use viem's formatUnits to convert the balance to a decimal number
    const formattedBalance = formatUnits(BigInt(balance), decimals);

    // Convert to number
    return [formattedBalance, parseFloat(formattedBalance) * exchangeRate];
  } catch (error) {
    console.error(`Error converting balance: ${error}`);
    return ["0", 0];
  }
}

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

interface AddressBalanceResponse {
  exchange_rate: string;
  coin_balance: string;
}

interface TokenBalancesResponse {
  token: {
    address: Address;
    address_hash: string;
    circulating_market_cap: string;
    decimals: string;
    exchange_rate: string;
    holders: string;
    holders_count: string;
    icon_url: string;
    name: string;
    symbol: string;
    total_supply: string;
    type: string;
    volume_24h: string;
  };
  token_id: string | null;
  token_instance: string | null;
  value: string;
}

async function fetchTokenBalancesFromBlockscout(chainId: number, address: string): Promise<TokenBalance[]> {
  if (!blockExplorers[chainId as keyof typeof blockExplorers]) {
    throw new Error(`Block explorer not found for chain ID: ${chainId}`);
  }
  const balances: TokenBalance[] = [];
  const balanceUrl = `${blockExplorers[chainId as keyof typeof blockExplorers]}/api/v2/addresses/${address}`;
  const balanceResponse = await fetch(balanceUrl);
  const balanceData: AddressBalanceResponse = await balanceResponse.json();
  if (chainId === 137) {
    balances.push({
      symbol: "POL",
      name: "Polygon",
      address: zeroAddress,
      decimals: "18",
      exchange_rate: balanceData.exchange_rate,
      value: balanceData.coin_balance,
      icon_url: "https://assets.coingecko.com/coins/images/32440/standard/polygon.png",
    });
  } else {
    balances.push({
      symbol: "ETH",
      name: "Ether",
      address: zeroAddress,
      decimals: "18",
      exchange_rate: balanceData.exchange_rate,
      value: balanceData.coin_balance,
      icon_url: "https://assets.coingecko.com/coins/images/279/standard/ethereum.png",
    });
  }
  const url = `${blockExplorers[chainId as keyof typeof blockExplorers]}/api/v2/addresses/${address}/token-balances`;
  const response = await fetch(url);
  const data: TokenBalancesResponse[] = await response.json();
  const filteredData = data.filter((token) => token.token.type === "ERC-20");
  for (const token of filteredData) {
    balances.push({
      symbol: token.token.symbol,
      name: token.token.name,
      address: token.token.address,
      decimals: token.token.decimals,
      exchange_rate: token.token.exchange_rate,
      value: token.value,
      icon_url: token.token.icon_url,
    });
  }
  return balances;
}

function buildWalletDataFromTokens(tokenBalances: TokenBalance[], address: string, chainId: number): WalletData[] {
  const results: WalletData[] = [];

  for (const token of tokenBalances) {
    try {
      const [balance, amountInUsd] = convertBalance(token.value, Number(token.decimals), Number(token.exchange_rate));

      if (isEffectivelyZero(Number(amountInUsd))) {
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
        iconUrl: token.icon_url,
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

    console.log(
      `Starting to fetch token balances for ${addresses.length} addresses across ${supportedChains.length} networks...`,
    );

    const chainIds = supportedChains.map((chain) => chain.id);

    console.log(`Fetching for chain IDs: ${chainIds.join(", ")}`);

    // Fire all requests concurrently for all address+chain combinations
    const results = await Promise.allSettled(
      addresses.flatMap((address) =>
        chainIds.map((chainId) => {
          console.log(
            `Fetching tokens for address ${address} on chain ${chainId} (${chainIdToName[chainId] || "Unknown"})...`,
          );
          return fetchTokenBalancesFromBlockscout(chainId, address)
            .then((balances) => ({ address, chainId, balances }))
            .catch((error) => {
              // Preserve context for error handling after all promises settle
              throw { error, address, chainId };
            });
        }),
      ),
    );

    for (const result of results) {
      if (result.status === "fulfilled") {
        const { address, chainId, balances } = result.value;
        if (balances.length === 0) {
          console.log(`No tokens found for address ${address} on chain ${chainId}`);
          continue;
        }
        console.log(`Received ${balances.length} tokens for address ${address} on chain ${chainId}`);
        walletData.push(...buildWalletDataFromTokens(balances, address, chainId));
      } else {
        const { address, chainId, error } = result.reason as { error: unknown; address?: string; chainId?: number };
        if (address !== undefined && chainId !== undefined) {
          console.error(`Error processing chain ${chainId} for address ${address}:`, error);
        } else {
          console.error(`Error fetching token balances:`, result.reason);
        }
      }
    }

    console.log(`Processed ${walletData.length} tokens with non-zero balances`);

    // Sort wallet data by USD value (descending)
    walletData.sort((a, b) => b.amountInUsd - a.amountInUsd);

    return walletData;
  } catch (error) {
    console.error("Error fetching token balances:", error);
    return []; // Return empty array on error
  }
}
