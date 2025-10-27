import { useQuery } from "@tanstack/react-query";
import * as React from "react";
import type { Address } from "viem";
import { erc20Abi, getAddress, isAddress, isAddressEqual, zeroAddress } from "viem";
import { usePublicClient } from "wagmi";
import { ETH, USDC, WBTC } from "~/data/token-contracts";
import { Combobox, type ComboboxOption } from "./combobox";
import { TokenLabel } from "./token-label";

// Format: "chainId:address:decimals:symbol:name"
// Example usage:
//   const options = [
//     { value: formatTokenValue(1, "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", 6, "USDC", "USD Coin") },
//     { value: formatTokenValue(1, "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", 8, "WBTC", "Wrapped BTC") }
//   ];
//
// Auto-enrichment: The TokenSelector automatically fetches token metadata for plain
// addresses. Plain addresses like "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" will be enriched to
// "1:0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48:6:USDC:USD Coin" by fetching on-chain data.
export function formatTokenValue(
  chainId: number,
  address: string,
  decimals: number,
  symbol: string,
  name: string,
): string {
  // Normalize address to checksum format to ensure consistent deduplication
  const normalizedAddress = getAddress(address);
  return `${chainId}:${normalizedAddress}:${decimals}:${symbol}:${name}`;
}

export function parseTokenValue(value: string):
  | {
      chainId: number;
      address: Address;
      decimals: number;
      symbol: string;
      name: string;
    }
  | undefined {
  if (!value) return undefined;
  const parts = value.split(":");
  if (parts.length < 5) return undefined;

  const chainId = Number.parseInt(parts[0] || "", 10);
  const address = getAddress(parts[1]);
  const decimals = Number.parseInt(parts[2] || "", 10);
  const symbol = parts[3];
  // Name might contain colons, so join the rest
  const name = parts.slice(4).join(":");

  if (Number.isNaN(chainId) || !address || Number.isNaN(decimals) || !symbol || !name) {
    return undefined;
  }

  return { chainId, address, decimals, symbol, name };
}

interface TokenMetadata {
  decimals: number;
  symbol: string;
  name: string;
}

// Hook to fetch token metadata for multiple addresses
function useTokenMetadata(chainId: number, addresses: Address[]) {
  const publicClient = usePublicClient({ chainId });

  return useQuery({
    queryKey: ["token-metadata", chainId, addresses.join(",")],
    queryFn: async () => {
      if (!publicClient) {
        return new Map<string, TokenMetadata>();
      }

      const map = new Map<string, TokenMetadata>();

      await Promise.all(
        addresses.map(async (address) => {
          try {
            // Handle native token (zero address)
            if (address === zeroAddress) {
              // Special handling for Polygon which uses WETH
              if (chainId === 137) {
                map.set(address, {
                  decimals: 18,
                  symbol: "WETH",
                  name: "Wrapped Ether",
                });
              } else {
                map.set(address, {
                  decimals: 18,
                  symbol: "ETH",
                  name: "Ether",
                });
              }
              return;
            }

            // Fetch ERC20 token metadata
            const [decimals, symbol, name] = await Promise.all([
              publicClient.readContract({
                address,
                abi: erc20Abi,
                functionName: "decimals",
              }),
              publicClient.readContract({
                address,
                abi: erc20Abi,
                functionName: "symbol",
              }),
              publicClient.readContract({
                address,
                abi: erc20Abi,
                functionName: "name",
              }),
            ]);

            map.set(address, { decimals, symbol, name });
          } catch (_error) {
            // Ignore errors for invalid token addresses
          }
        }),
      );

      return map;
    },
    enabled: addresses.length > 0 && !!publicClient,
  });
}

// Get default token options for a given chain
export function getDefaultTokenOptions(chainId: number): ComboboxOption[] {
  const tokens: Array<{ address: Address; symbol: string; name: string; decimals: number }> = [];

  // Add USDC if available for this chain
  if (USDC[chainId]) {
    tokens.push({
      address: USDC[chainId],
      symbol: "USDC",
      name: "USD Coin",
      decimals: 6,
    });
  }

  // Add WBTC if available for this chain
  if (WBTC[chainId]) {
    tokens.push({
      address: WBTC[chainId],
      symbol: "WBTC",
      name: "Wrapped BTC",
      decimals: 8,
    });
  }

  // Add ETH/WETH based on chain
  if (ETH[chainId]) {
    const isPolygon = chainId === 137;
    tokens.push({
      address: ETH[chainId],
      symbol: isPolygon ? "WETH" : "ETH",
      name: isPolygon ? "Wrapped Ether" : "Ether",
      decimals: 18,
    });
  }

  return tokens.map((token) => ({
    value: formatTokenValue(chainId, token.address, token.decimals, token.symbol, token.name),
  }));
}

interface TokenSelectorProps {
  chainId: number;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  disabled?: boolean;
  options?: ComboboxOption[];
}

export function TokenSelector({
  chainId,
  value,
  onChange,
  placeholder = "Select token...",
  searchPlaceholder = "Search or paste token address",
  disabled,
  options,
}: TokenSelectorProps) {
  const publicClient = usePublicClient({ chainId });

  // Derive allOptions directly from props to avoid stale state
  const [customOptions, setCustomOptions] = React.useState<ComboboxOption[]>([]);
  const allOptions = React.useMemo(() => {
    // Merge provided options with any custom options the user added
    const provided = options ?? [];
    const custom = customOptions.filter((custom) => !provided.some((p) => p.value === custom.value));
    return [...provided, ...custom];
  }, [options, customOptions]);

  // Clear selection if the current value is for a different chain
  React.useEffect(() => {
    if (!value) return;

    const parsed = parseTokenValue(value);
    if (parsed && parsed.chainId !== chainId) {
      onChange("");
    }
  }, [chainId, value, onChange]);

  // Clear custom options when chain changes
  // biome-ignore lint/correctness/useExhaustiveDependencies: chainId is a prop and we need to react to its changes
  React.useEffect(() => {
    setCustomOptions([]);
  }, [chainId]);

  // Collect addresses that need metadata enrichment
  const addressesToEnrich = React.useMemo(() => {
    return allOptions
      .map((o) => {
        const parsed = parseTokenValue(o.value);
        // If it parses successfully, check if it matches the current chain
        if (parsed) {
          return parsed.chainId === chainId ? parsed.address : null;
        }
        // If it doesn't parse, assume it's a raw address
        return isAddress(o.value) ? o.value : null;
      })
      .filter((addr): addr is Address => addr !== null && isAddress(addr));
  }, [allOptions, chainId]);

  const { data: metadata = new Map() } = useTokenMetadata(chainId, addressesToEnrich);

  // Enrich options with fetched metadata
  const enrichedOptions = React.useMemo(() => {
    return allOptions
      .map((o) => {
        const parsed = parseTokenValue(o.value);

        // If it's already formatted
        if (parsed) {
          // Skip options from different chains
          if (parsed.chainId !== chainId) {
            return null;
          }
          return o;
        }

        // If it's a raw address, enrich it with metadata
        if (isAddress(o.value)) {
          const meta = metadata.get(o.value);
          if (meta) {
            return {
              ...o,
              value: formatTokenValue(chainId, o.value, meta.decimals, meta.symbol, meta.name),
            };
          }
          // If metadata not yet available, keep the raw address for now
          return o;
        }

        // Invalid option
        return null;
      })
      .filter((o): o is ComboboxOption => o !== null);
  }, [allOptions, metadata, chainId]);

  // Validation function
  const isValidOption = React.useCallback(
    (s: string): [boolean, string] => {
      if (!s) return [true, ""];

      // Check if already exists (by address or symbol)
      const exists = enrichedOptions.some((o) => {
        const p = parseTokenValue(o.value);
        if (!p) return false;
        return p.address.toLowerCase() === s.toLowerCase() || p.symbol.toLowerCase() === s.toLowerCase();
      });
      if (exists) return [false, "Token already in the list"];

      // Must be a valid address
      if (!isAddress(s)) {
        return [false, `"${s}" is not a valid token address`];
      }

      return [true, ""];
    },
    [enrichedOptions],
  );

  // Add custom option if it doesn't already exist
  const upsertOption = React.useCallback((value: string) => {
    setCustomOptions((prev) => (prev.some((o) => o.value === value) ? prev : [...prev, { value }]));
  }, []);

  // Resolve user input to formatted token value
  const resolveToFormattedValue = React.useCallback(
    async (input: string): Promise<string | null> => {
      if (!publicClient) return null;

      // Check if input is a symbol that matches an existing token
      const existingBySymbol = enrichedOptions.find((o) => {
        const parsed = parseTokenValue(o.value);
        return parsed?.symbol.toLowerCase() === input.toLowerCase();
      });

      if (existingBySymbol) {
        return existingBySymbol.value;
      }

      // Must be an address
      const address = isAddress(input) ? getAddress(input) : null;
      if (!address) return null;

      // Fetch metadata for this token
      try {
        // Handle native token
        if (address === zeroAddress) {
          const isPolygon = chainId === 137;
          return formatTokenValue(
            chainId,
            address,
            18,
            isPolygon ? "WETH" : "ETH",
            isPolygon ? "Wrapped Ether" : "Ether",
          );
        }

        // Fetch ERC20 metadata
        const [decimals, symbol, name] = await Promise.all([
          publicClient.readContract({
            address,
            abi: erc20Abi,
            functionName: "decimals",
          }),
          publicClient.readContract({
            address,
            abi: erc20Abi,
            functionName: "symbol",
          }),
          publicClient.readContract({
            address,
            abi: erc20Abi,
            functionName: "name",
          }),
        ]);

        return formatTokenValue(chainId, address, decimals, symbol, name);
      } catch {
        return null;
      }
    },
    [publicClient, chainId, enrichedOptions],
  );

  // Handle token change
  const handleTokenChange = React.useCallback(
    async (newValue: string) => {
      // Check if this is selecting an existing option
      const isExistingOption = enrichedOptions.some((o) => o.value === newValue);

      if (isExistingOption) {
        onChange(newValue);
        return;
      }

      // Adding a new token - resolve and check for duplicates
      const formatted = await resolveToFormattedValue(newValue);
      if (!formatted) return;

      // Check if the resolved token already exists
      const parsed = parseTokenValue(formatted);
      if (parsed) {
        const tokenExists = enrichedOptions.some((o) => {
          const existing = parseTokenValue(o.value);
          return (
            existing &&
            existing.chainId === parsed.chainId &&
            existing.address.toLowerCase() === parsed.address.toLowerCase()
          );
        });

        // If token already exists, don't add it again
        if (tokenExists) return;
      }

      upsertOption(formatted);
      onChange(formatted);
    },
    [onChange, resolveToFormattedValue, upsertOption, enrichedOptions],
  );

  // Label function to display token with icon and symbol
  const labelFunction = React.useCallback(
    (tokenValue: string) => {
      const parsed = parseTokenValue(tokenValue);
      if (parsed) {
        return <TokenLabel tokenAddress={parsed.address} chainId={parsed.chainId} symbol={parsed.symbol} />;
      }

      // If it's a raw address, TokenLabel will fetch its metadata
      if (isAddress(tokenValue)) {
        return <TokenLabel tokenAddress={tokenValue} chainId={chainId} />;
      }
      return tokenValue;
    },
    [chainId],
  );

  // Convert the value to internal format if needed
  // If parent passes a raw address, find the matching formatted option
  const internalValue = React.useMemo(() => {
    if (!value) return value;

    // If value is already formatted, use it as-is
    if (parseTokenValue(value)) return value;

    // If value is a raw address, find the matching formatted option
    if (isAddress(value)) {
      const matchingOption = enrichedOptions.find((opt) => {
        const parsed = parseTokenValue(opt.value);
        return parsed && isAddressEqual(parsed.address, value);
      });
      return matchingOption?.value || value;
    }

    return value;
  }, [value, enrichedOptions]);

  return (
    <Combobox
      disabled={disabled || !publicClient}
      options={enrichedOptions}
      value={internalValue}
      onValueChange={handleTokenChange}
      labelFunction={labelFunction}
      placeholder={placeholder}
      searchPlaceholder={searchPlaceholder}
      isValidOption={isValidOption}
    />
  );
}
