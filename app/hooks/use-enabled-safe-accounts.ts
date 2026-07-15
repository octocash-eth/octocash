import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { getAddress, isAddress } from "viem";
import type { SafeAccount } from "~/lib/accounts";
import { mapWithConcurrency } from "~/lib/concurrency";
import { useConnectedAddresses } from "./use-connected-addresses";
import { probeSafeAccount } from "./use-owned-safes";

/**
 * Hydrates the user's enabled Safes (persisted as bare addresses in
 * localStorage) back into full `SafeAccount`s by probing each address on
 * every supported chain. This is what lets the dashboard spend from a Safe
 * enabled in a previous session without re-running owner discovery — the
 * Connect Safes dialog discovers, this hook only verifies what was already
 * opted in.
 */
export function useEnabledSafeAccounts(enabledAddresses: readonly string[]): {
  safes: SafeAccount[];
  isLoading: boolean;
  error: Error | null;
} {
  const connectedAddresses = useConnectedAddresses();

  // Stored lowercase; the Safe Transaction Service rejects non-checksummed
  // addresses (422), so re-checksum before probing. Garbage entries are
  // dropped rather than failing the whole hydration.
  const safeAddresses = useMemo(
    () => enabledAddresses.filter((address) => isAddress(address)).map((address) => getAddress(address)),
    [enabledAddresses],
  );

  const queryKey = useMemo(() => {
    const enabledKey = Array.from(safeAddresses)
      .map((address) => address.toLowerCase())
      .sort()
      .join(",");
    const connectedKey = Array.from(connectedAddresses)
      .map((address) => address.toLowerCase())
      .sort()
      .join(",");
    return ["enabled-safe-accounts", enabledKey, connectedKey];
  }, [safeAddresses, connectedAddresses]);

  const query = useQuery({
    queryKey,
    queryFn: () => mapWithConcurrency(safeAddresses, 3, (address) => probeSafeAccount(address, connectedAddresses)),
    enabled: safeAddresses.length > 0 && connectedAddresses.length > 0,
    staleTime: 60_000,
  });

  return { safes: query.data ?? [], isLoading: query.isLoading, error: query.error };
}
