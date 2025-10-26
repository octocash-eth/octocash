import * as React from "react";
import { type Address, erc20Abi, getAddress, isAddress, isAddressEqual } from "viem";
import { useReadContracts } from "wagmi";
import { ETH, USDC, WBTC } from "~/data/token-contracts";
import { Combobox } from "./combobox";
import { TokenDisplayIcon, TokenDisplayRoot, TokenDisplaySymbol } from "./ui/token-display";

// Format: "chainId:tokenAddress:decimals:symbol"
export function formatTokenValue(chainId: number, address: string, decimals: number, symbol: string): string {
  return `${chainId}:${address}:${decimals}:${symbol}`;
}

export function parseTokenValue(
  value: string,
): { chainId: number; address: string; decimals: number; symbol: string } | null {
  if (!value) return null;
  const match = value.match(/^(\d+):([^:]+):(\d+):(.+)$/);
  if (!match) return null;
  const [chainId, address, decimals, symbol] = match.slice(1);
  return {
    chainId: Number(chainId),
    address: getAddress(address),
    decimals: Number(decimals),
    symbol,
  };
}

interface TokenSelectorProps {
  chainId: number;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}

export function TokenSelector({ chainId, value, onChange, disabled }: TokenSelectorProps) {
  // Track the address we're previewing
  const [previewAddress, setPreviewAddress] = React.useState<Address | null>(null);

  // Fetch token metadata for preview using wagmi
  const {
    data: tokenData,
    isSuccess,
    isLoading,
  } = useReadContracts({
    contracts:
      previewAddress && chainId
        ? [
            {
              address: previewAddress as `0x${string}`,
              abi: erc20Abi,
              functionName: "symbol",
              chainId,
            },
            {
              address: previewAddress as `0x${string}`,
              abi: erc20Abi,
              functionName: "decimals",
              chainId,
            },
          ]
        : undefined,
    query: {
      enabled: Boolean(previewAddress && chainId),
    },
  });

  // Extract metadata from query result
  const previewMetadata = React.useMemo(() => {
    if (!previewAddress || !isSuccess || !tokenData) return null;

    const symbol = tokenData[0]?.result;
    const decimals = tokenData[1]?.result;

    if (symbol && decimals !== undefined) {
      return { address: previewAddress, symbol, decimals };
    }
    return null;
  }, [previewAddress, isSuccess, tokenData]);

  // Promote preview metadata to full token value when it arrives
  React.useEffect(() => {
    if (previewMetadata && chainId) {
      const formattedValue = formatTokenValue(
        chainId,
        previewMetadata.address,
        previewMetadata.decimals,
        previewMetadata.symbol,
      );
      onChange(formattedValue);
      setPreviewAddress(null); // Clear preview
    }
  }, [previewMetadata, chainId, onChange]);

  // Handle token address input - transform raw address to full format
  const handleTokenChange = React.useCallback(
    async (inputValue: string) => {
      // If it's a plain address, normalize and trigger preview fetch
      if (isAddress(inputValue) && chainId) {
        const normalizedAddress = getAddress(inputValue);
        setPreviewAddress(normalizedAddress);
        onChange(normalizedAddress);
      } else {
        onChange(inputValue);
      }
    },
    [chainId, onChange],
  );

  const options = React.useMemo(() => {
    if (!chainId) return [];

    return [
      { value: formatTokenValue(chainId, USDC[chainId as keyof typeof USDC], 6, "USDC") },
      { value: formatTokenValue(chainId, WBTC[chainId as keyof typeof WBTC], 8, "WBTC") },
      { value: formatTokenValue(chainId, ETH[chainId as keyof typeof ETH], 18, chainId === 137 ? "WETH" : "ETH") },
    ];
  }, [chainId]);

  // Handle token label display
  const labelFunction = React.useCallback(
    (tokenValue: string) => {
      const parsed = parseTokenValue(tokenValue);
      if (parsed) {
        const { address, chainId, symbol } = parsed;
        return (
          <TokenDisplayRoot tokenAddress={address} chainId={chainId} symbol={symbol} className="gap-2">
            <TokenDisplayIcon className="size-4" />
            <TokenDisplaySymbol />
          </TokenDisplayRoot>
        );
      }

      // Handle raw addresses for preview (before transformation)
      if (isAddress(tokenValue) && chainId && previewMetadata && isAddressEqual(previewMetadata.address, tokenValue)) {
        // If we have loaded metadata, show it
        return (
          <TokenDisplayRoot
            tokenAddress={previewMetadata.address}
            chainId={chainId}
            symbol={previewMetadata.symbol}
            className="gap-2"
          >
            <TokenDisplayIcon className="size-4" />
            <TokenDisplaySymbol />
          </TokenDisplayRoot>
        );
      }

      return null;
    },
    [chainId, previewMetadata],
  );

  // Handle token validation
  const isValidOption = React.useCallback(
    (searchValue: string): [boolean, string] => {
      // If search value is empty or already in the correct format, it's valid
      if (!searchValue || searchValue.includes(":")) {
        return [true, ""];
      }

      // If it's a valid address, check if we're loading or have loaded metadata
      if (isAddress(searchValue)) {
        const normalizedAddress = getAddress(searchValue);

        // If we're currently loading this address
        if (isLoading) {
          return [false, "Loading token..."];
        }

        // If it's loaded but not found, it's invalid
        if (previewAddress === normalizedAddress && isSuccess && !previewMetadata) {
          return [false, "Token not found"];
        }

        // Otherwise, it's valid
        return [true, ""];
      }

      // Invalid format
      return [false, "Please enter a valid token address"];
    },
    [isLoading, isSuccess, previewAddress, previewMetadata],
  );

  return (
    <Combobox
      disabled={disabled || !chainId}
      options={options}
      value={value}
      onValueChange={handleTokenChange}
      labelFunction={labelFunction}
      placeholder={chainId ? "Select or paste a token" : "Select a destination chain first"}
      searchPlaceholder="Search for a token"
      isValidOption={isValidOption}
    />
  );
}
