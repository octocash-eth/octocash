import { useQuery } from "@tanstack/react-query";
import * as React from "react";
import type { Address } from "viem";
import { getAddress, isAddress } from "viem";
import { normalize } from "viem/ens";
import { usePublicClient } from "wagmi";
import { Combobox, type ComboboxOption } from "./combobox";
import { AddressDisplayAvatar, AddressDisplayRoot, AddressDisplayText } from "./ui/address-display";

// Format: "address:ensName" or just "address" if no ENS name
// When options include formatted values with ENS names, users can filter by typing
// the ENS name (e.g., typing "vit" will show "vitalik.eth")
//
// Example usage:
//   const options = [
//     { value: formatAddressValue("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", "vitalik.eth") },
//     { value: "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb" }
//   ];
//
// Auto-enrichment: The AddressSelector automatically looks up ENS names for plain
// addresses using the @ensdomains/ensjs library for reverse resolution.
// Plain addresses like "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb" will be enriched to
// "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb:name.eth" if an ENS reverse record exists.
//
// Manual ENS resolution: When users type an ENS name directly (e.g., "vitalik.eth"),
// the component automatically resolves it to an address and formats the value as
// "address:ensName". This enables filtering by ENS name in future searches.
export function formatAddressValue(address: string, ensName?: string): string {
  return ensName ? `${address}:${ensName}` : address;
}

export function parseAddressValue(value: string): { address: string; ensName?: string } | null {
  if (!value) return null;
  const parts = value.split(":");
  if (parts.length === 1) {
    return { address: parts[0] };
  }
  if (parts.length === 2) {
    return { address: parts[0], ensName: parts[1] };
  }
  return null;
}

function looksLikeEns(s: string) {
  return /\.[a-z]{2,}$/.test(s);
}

function normalizeSafe(s: string) {
  try {
    return normalize(s);
  } catch {
    return null;
  }
}

// Hook for reverse ENS lookup of multiple addresses
function useEnsReverse(addresses: Address[]) {
  // For ENS resolution
  const mainnetPublicClient = usePublicClient({
    chainId: 1,
  });
  return useQuery({
    queryKey: ["ens-reverse", addresses.join(",")],
    queryFn: async () => {
      if (!mainnetPublicClient) {
        return new Map<string, string>();
      }
      const map = new Map<string, string>();
      await Promise.all(
        addresses.map(async (address) => {
          try {
            const result = await mainnetPublicClient.getEnsName({
              address,
            });

            if (result) {
              map.set(address, result);
            }
          } catch (_error) {
            // Ignore errors for addresses without ENS names
          }
        }),
      );
      return map;
    },
    enabled: addresses.length > 0 && !!mainnetPublicClient,
  });
}

interface AddressSelectorProps {
  value: string;
  onChange: (value: string) => void;
  options?: ComboboxOption[];
  placeholder?: string;
  searchPlaceholder?: string;
  disabled?: boolean;
  chainId?: number;
}

export function AddressSelector({
  value,
  onChange,
  options = [],
  placeholder = "0x...",
  searchPlaceholder = "Select or paste an address",
  disabled,
  chainId,
}: AddressSelectorProps) {
  // For ENS resolution
  const mainnetPublicClient = usePublicClient({
    chainId: 1,
  });

  const [allOptions, setAllOptions] = React.useState<ComboboxOption[]>(options);

  React.useEffect(() => {
    setAllOptions(options);
  }, [options]);

  // reverse enrich para options
  const addressesToEnrich = React.useMemo(
    () =>
      allOptions
        .map((o) => parseAddressValue(o.value))
        .filter((x): x is { address: string } => !!x && "address" in x && !x.ensName)
        .map((x) => x.address),
    [allOptions],
  );

  const { data: reverse = new Map() } = useEnsReverse(addressesToEnrich as Address[]);

  const enrichedOptions = React.useMemo(() => {
    return allOptions.map((o) => {
      const p = parseAddressValue(o.value);
      if (p && "address" in p && !p.ensName) {
        const name = reverse.get(p.address);
        return name ? { ...o, value: formatAddressValue(p.address, name) } : o;
      }
      return o;
    });
  }, [allOptions, reverse]);

  // Validation using parseAddressValue instead of manual split
  const isValidOption = React.useCallback(
    (s: string): [boolean, string] => {
      if (!s) return [true, ""];

      const exists = enrichedOptions.some((o) => {
        const p = parseAddressValue(o.value);
        if (!p) return false;
        return p.address.toLowerCase() === s.toLowerCase() || p.ensName?.toLowerCase() === s.toLowerCase();
      });
      if (exists) return [false, "Already in the list"];

      if (!looksLikeEns(s) && !isAddress(s)) return [false, `"${s}" is not a valid address/ENS`];
      return [true, ""];
    },
    [enrichedOptions],
  );

  // Add option if it doesn't already exist
  const upsertOption = React.useCallback((value: string) => {
    setAllOptions((prev) => (prev.some((o) => o.value === value) ? prev : [...prev, { value }]));
  }, []);

  // Resolve any user input to a formatted 'address:ensName' or null if invalid/unresolvable
  const resolveToFormattedValue = React.useCallback(
    async (input: string): Promise<string | null> => {
      if (!mainnetPublicClient) return null;

      // ENS-like input
      if (looksLikeEns(input) && !isAddress(input)) {
        const name = normalizeSafe(input);
        if (!name) return null;
        const addr = await mainnetPublicClient.getEnsAddress({ name });
        if (!addr) return null;
        return formatAddressValue(addr, input); // keep the user's typed (possibly un-normalized) display value
      }

      // Address-like input
      const address = isAddress(input) ? getAddress(input) : null;
      if (!address) return null;

      // Best-effort reverse lookup; still return address if reverse fails
      const ens = await mainnetPublicClient.getEnsName({ address }).catch(() => null);
      return formatAddressValue(address, ens || undefined);
    },
    [mainnetPublicClient],
  );

  // Handle address label display
  const labelFunction = React.useCallback(
    (addressValue: string) => {
      // Parse the value to get the address (could be formatted as "address:ensName")
      const parsed = parseAddressValue(addressValue);
      const displayAddress = parsed?.address ?? addressValue;

      return (
        <AddressDisplayRoot address={displayAddress} chainId={chainId} className="gap-2">
          <AddressDisplayAvatar className="size-4" />
          <AddressDisplayText />
        </AddressDisplayRoot>
      );
    },
    [chainId],
  );

  // Single-path change handler that orchestrates resolution and updates
  const handleAddressChange = React.useCallback(
    async (newValue: string) => {
      // Check if this is selecting an existing option (exact match before resolution)
      const isExistingOption = enrichedOptions.some((o) => o.value === newValue);

      if (isExistingOption) {
        // Selecting an existing option - just call onChange
        onChange(newValue);
        return;
      }

      // Adding a new option - resolve and check for duplicates
      const formatted = await resolveToFormattedValue(newValue);
      if (!formatted) return;

      // Check if the resolved address already exists in the options
      const parsed = parseAddressValue(formatted);
      if (parsed) {
        const addressExists = enrichedOptions.some((o) => {
          const existing = parseAddressValue(o.value);
          return existing && existing.address.toLowerCase() === parsed.address.toLowerCase();
        });

        // If address already exists, don't add it again
        if (addressExists) return;
      }
      upsertOption(formatted);
      onChange(formatted);
    },
    [onChange, resolveToFormattedValue, upsertOption, enrichedOptions],
  );

  return (
    <Combobox
      disabled={disabled || !mainnetPublicClient}
      options={enrichedOptions}
      value={value}
      onValueChange={handleAddressChange}
      labelFunction={labelFunction}
      placeholder={placeholder}
      searchPlaceholder={searchPlaceholder}
      isValidOption={isValidOption}
    />
  );
}
