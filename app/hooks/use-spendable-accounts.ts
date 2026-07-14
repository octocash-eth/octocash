import { useCallback, useMemo } from "react";
import useLocalStorageState from "use-local-storage-state";
import type { Address } from "viem";
import { type AccountsMap, type SafeAccount, safeControlledOn } from "~/lib/accounts";
import { useConnectedAddresses } from "./use-connected-addresses";
import { useOwnedSafes } from "./use-owned-safes";

const STORAGE_KEY = "octocash:enabled-safes";

/**
 * The full set of addresses the app can spend from — connected EOAs plus the
 * Safes the user has explicitly enabled from the Safes panel — together with
 * the accounts map that tells planning/execution which of them are Safes.
 * Discovered Safes are opt-in (persisted across sessions) so a treasury
 * signer's dashboard isn't suddenly flooded with every DAO Safe they sit on.
 */
export function useSpendableAccounts() {
  const connectedAddresses = useConnectedAddresses();
  const { safes, isLoading } = useOwnedSafes();
  const [enabledSafes, setEnabledSafes] = useLocalStorageState<string[]>(STORAGE_KEY, { defaultValue: [] });

  const enabledSet = useMemo(() => new Set(enabledSafes.map((address) => address.toLowerCase())), [enabledSafes]);

  const activeSafes = useMemo(
    () =>
      safes.filter(
        (safe) =>
          enabledSet.has(safe.address.toLowerCase()) &&
          // A Safe with no controlled deployment can't be spent from at all.
          Object.keys(safe.deployments).some((chainId) => safeControlledOn(safe, Number(chainId))),
      ),
    [safes, enabledSet],
  );

  const accounts = useMemo<AccountsMap>(() => {
    const map = new Map<string, SafeAccount>();
    for (const safe of activeSafes) map.set(safe.address.toLowerCase(), safe);
    return map;
  }, [activeSafes]);

  const addresses = useMemo<Address[]>(
    () => [...connectedAddresses, ...activeSafes.map((safe) => safe.address)],
    [connectedAddresses, activeSafes],
  );

  const setSafeEnabled = useCallback(
    (safe: Address, enabled: boolean) => {
      setEnabledSafes((previous) => {
        const key = safe.toLowerCase();
        const without = previous.filter((address) => address !== key);
        return enabled ? [...without, key] : without;
      });
    },
    [setEnabledSafes],
  );

  const isSafeEnabled = useCallback((safe: Address) => enabledSet.has(safe.toLowerCase()), [enabledSet]);

  return {
    /** Connected EOAs + enabled Safe addresses (balance-scan / planning input). */
    addresses,
    /** Account-kind lookup for everything in `addresses`. */
    accounts,
    /** All discovered Safes (enabled or not), for the Safes panel. */
    discoveredSafes: safes,
    isDiscovering: isLoading,
    isSafeEnabled,
    setSafeEnabled,
  };
}
