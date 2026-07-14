import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import type { Address } from "viem";
import { chains } from "~/data/supported-chains";
import type { SafeAccount, SafeChainDeployment } from "~/lib/accounts";
import { getSafeInfo, getSafesByOwner, hasSafeTransactionService } from "~/lib/api/safe-transaction-service";
import { useConnectedAddresses } from "./use-connected-addresses";

const SUPPORTED_CHAIN_IDS = Object.keys(chains)
  .map(Number)
  .filter((chainId) => hasSafeTransactionService(chainId));

/**
 * Discovers the connected owners' Gnosis Safes across every supported chain
 * via the per-network Safe Transaction Services.
 *
 * Discovery is two-phase: (1) `getSafesByOwner` on each chain finds Safes the
 * owner controls somewhere; (2) each discovered address is then probed on ALL
 * supported chains — a same-address redeployment whose owner set diverged
 * would never show up in phase 1 on that chain, but must still be surfaced
 * (with `controlled: false`) so the user sees where their Safe's address
 * exists without being theirs. Chains whose service errors are excluded from
 * `deployments` entirely: routing fails closed on unverified chains.
 */
export async function discoverOwnedSafes(owners: readonly Address[], now = Date.now()): Promise<SafeAccount[]> {
  if (owners.length === 0) return [];

  const byOwnerResults = await Promise.allSettled(
    SUPPORTED_CHAIN_IDS.flatMap((chainId) =>
      owners.map(async (owner) => ({ owner, safes: await getSafesByOwner(chainId, owner) })),
    ),
  );

  // Safe address (lowercase) -> connected owner that discovered it first.
  const discovered = new Map<string, { address: Address; discoveredBy: Address }>();
  for (const result of byOwnerResults) {
    if (result.status !== "fulfilled") continue;
    for (const safe of result.value.safes) {
      const key = safe.toLowerCase();
      if (!discovered.has(key)) discovered.set(key, { address: safe, discoveredBy: result.value.owner });
    }
  }
  if (discovered.size === 0) return [];

  const connectedLower = new Set(owners.map((owner) => owner.toLowerCase()));

  return Promise.all(
    Array.from(discovered.values()).map(async ({ address, discoveredBy }) => {
      const probes = await Promise.allSettled(
        SUPPORTED_CHAIN_IDS.map(async (chainId) => ({ chainId, info: await getSafeInfo(chainId, address) })),
      );

      const deployments: Record<number, SafeChainDeployment> = {};
      for (const probe of probes) {
        if (probe.status !== "fulfilled" || probe.value.info === null) continue;
        const { chainId, info } = probe.value;
        deployments[chainId] = {
          chainId,
          owners: info.owners,
          threshold: info.threshold,
          nonce: info.nonce,
          version: info.version,
          controlled: info.owners.some((owner) => connectedLower.has(owner.toLowerCase())),
        };
      }

      // Prefer an owner that actually controls a deployment; the discovering
      // owner is only a fallback (it controls the Safe *somewhere*, or the
      // by-owner query wouldn't have returned it).
      const controlledOwners = new Set(
        Object.values(deployments)
          .filter((deployment) => deployment.controlled)
          .flatMap((deployment) => deployment.owners.map((owner) => owner.toLowerCase())),
      );
      const ownerAddress = owners.find((owner) => controlledOwners.has(owner.toLowerCase())) ?? discoveredBy;

      return { kind: "safe" as const, address, ownerAddress, deployments, fetchedAt: now };
    }),
  );
}

export function useOwnedSafes(): { safes: SafeAccount[]; isLoading: boolean; error: Error | null } {
  const owners = useConnectedAddresses();
  const ownersKey = useMemo(
    () =>
      Array.from(owners)
        .map((owner) => owner.toLowerCase())
        .sort()
        .join(","),
    [owners],
  );

  const query = useQuery({
    queryKey: ["owned-safes", ownersKey],
    queryFn: () => discoverOwnedSafes(owners),
    enabled: owners.length > 0,
    staleTime: 60_000,
  });

  return { safes: query.data ?? [], isLoading: query.isLoading, error: query.error };
}
