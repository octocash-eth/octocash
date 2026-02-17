import { type Address, erc20Abi } from "viem";
import { useReadContracts } from "wagmi";

interface UseTokenConfig {
  address: Address;
  chainId?: number;
  query?: {
    enabled?: boolean;
  };
}

interface TokenData {
  address: Address;
  name: string;
  symbol: string;
  decimals: number;
}

/**
 * Fetches ERC-20 token metadata (name, symbol, decimals) for a given address.
 * Replacement for the removed wagmi useToken hook.
 */
export function useToken(config: UseTokenConfig) {
  const { address, chainId, query } = config;

  const contract = { address, abi: erc20Abi, chainId } as const;

  const result = useReadContracts({
    contracts: [
      { ...contract, functionName: "name" },
      { ...contract, functionName: "symbol" },
      { ...contract, functionName: "decimals" },
    ],
    query: {
      enabled: query?.enabled !== false && !!address,
    },
  });

  const [nameResult, symbolResult, decimalsResult] = result.data ?? [];

  const data: TokenData | undefined =
    nameResult?.result !== undefined && symbolResult?.result !== undefined && decimalsResult?.result !== undefined
      ? {
          address: address,
          name: nameResult.result as string,
          symbol: symbolResult.result as string,
          decimals: decimalsResult.result as number,
        }
      : undefined;

  return {
    data,
    isLoading: result.isLoading,
    isError: result.isError,
    error: result.error,
  };
}
