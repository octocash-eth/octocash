import { type Address, erc20Abi } from "viem";
import { useReadContracts } from "wagmi";

interface UseTokenConfig {
  /**
   * Token contract address. May be undefined to render the hook in a disabled
   * state (e.g. before the address has resolved or for native-token cases).
   */
  address?: Address;
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

  // wagmi's useReadContracts requires a defined address in its types but skips
  // the call when `enabled` is false. Use the zero-address as an inert
  // placeholder; `enabled` ensures the call never actually happens.
  const contract = {
    address: (address ?? "0x0000000000000000000000000000000000000000") as Address,
    abi: erc20Abi,
    chainId,
  } as const;

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
    address !== undefined &&
    nameResult?.result !== undefined &&
    symbolResult?.result !== undefined &&
    decimalsResult?.result !== undefined
      ? {
          address,
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
