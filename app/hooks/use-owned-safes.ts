import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import type { Address } from "viem";
import { chains } from "~/data/supported-chains";
import type { SafeAccount, SafeChainDeployment } from "~/lib/accounts";
import { getSafeInfo, getSafesByOwner, hasSafeTransactionService } from "~/lib/api/safe-transaction-service";
import { mapWithConcurrency } from "~/lib/concurrency";
import { useConnectedAddresses } from "./use-connected-addresses";

/**
 * How many Safes are probed at once (each probe fans out to all supported
 * chains). An owner sitting on dozens of Safes would otherwise burst hundreds
 * of concurrent anonymous requests and get every probe 429'd.
 */
const PROBE_CONCURRENCY = 3;

const SUPPORTED_CHAIN_IDS = Object.keys(chains)
  .map(Number)
  .filter((chainId) => hasSafeTransactionService(chainId));

/**
 * Probes a Safe address on ALL supported chains and assembles its
 * `SafeAccount` — a same-address redeployment whose owner set diverged must
 * still be surfaced (with `controlled: false`) so the user sees where their
 * Safe's address exists without being theirs. Chains whose service errors are
 * excluded from `deployments` entirely: routing fails closed on unverified
 * chains.
 */
export async function probeSafeAccount(
  address: Address,
  connectedOwners: readonly Address[],
  now = Date.now(),
  fallbackOwner: Address = connectedOwners[0],
): Promise<SafeAccount> {
  const connectedLower = new Set(connectedOwners.map((owner) => owner.toLowerCase()));

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

  // Prefer a connected owner that actually controls a deployment; the caller's
  // fallback (the discovering owner, or the first connected address) only
  // applies when no controlled deployment was found.
  const controlledOwners = new Set(
    Object.values(deployments)
      .filter((deployment) => deployment.controlled)
      .flatMap((deployment) => deployment.owners.map((owner) => owner.toLowerCase())),
  );
  const ownerAddress = connectedOwners.find((owner) => controlledOwners.has(owner.toLowerCase())) ?? fallbackOwner;

  return { kind: "safe" as const, address, ownerAddress, deployments, fetchedAt: now };
}

/**
 * Discovers ONE owner's Gnosis Safes across every supported chain via the
 * per-network Safe Transaction Services, then probes each discovered address
 * on all chains (see `probeSafeAccount`).
 *
 * Discovery is per-owner and on-demand (the Connect Safes dialog runs it when
 * an address is expanded) so N connected wallets never fan out N × chains
 * requests at once — that used to trip the public API's rate limit and made
 * discovery silently collapse to "no safes". If every by-owner request fails,
 * this throws instead of returning `[]`: a throttled scan must not masquerade
 * as an owner without Safes.
 */
export async function discoverSafesForOwner(
  owner: Address,
  connectedOwners: readonly Address[],
  now = Date.now(),
): Promise<SafeAccount[]> {
  const byChain = await Promise.allSettled(SUPPORTED_CHAIN_IDS.map((chainId) => getSafesByOwner(chainId, owner)));

  // Safe address (lowercase) -> checksummed address as first reported.
  const discovered = new Map<string, Address>();
  let firstFailure: unknown;
  let failures = 0;
  for (const result of byChain) {
    if (result.status !== "fulfilled") {
      failures += 1;
      firstFailure ??= result.reason;
      continue;
    }
    for (const safe of result.value) {
      const key = safe.toLowerCase();
      if (!discovered.has(key)) discovered.set(key, safe);
    }
  }
  if (failures === byChain.length && byChain.length > 0) throw firstFailure;

  return mapWithConcurrency(Array.from(discovered.values()), PROBE_CONCURRENCY, (address) =>
    probeSafeAccount(address, connectedOwners, now, owner),
  );
}

/**
 * Lazily discovers the Safes owned by a single connected address. `enabled`
 * gates the network work — pass it from the expansion state of the owner's
 * row so chains are only scanned once the user asks to see that owner's
 * Safes. Results are cached per owner (plus the connected set, which affects
 * `controlled` flags), so re-expanding is instant.
 */
export function useOwnedSafesForOwner(
  owner: Address,
  enabled: boolean,
): { safes: SafeAccount[]; isLoading: boolean; error: Error | null; refetch: () => void } {
  const connectedAddresses = useConnectedAddresses();
  const connectedKey = useMemo(
    () =>
      Array.from(connectedAddresses)
        .map((address) => address.toLowerCase())
        .sort()
        .join(","),
    [connectedAddresses],
  );

  const query = useQuery({
    queryKey: ["owned-safes", owner.toLowerCase(), connectedKey],
    queryFn: () => discoverSafesForOwner(owner, connectedAddresses),
    enabled,
    staleTime: 60_000,
    // A failed scan usually means the public API is throttling us — auto
    // retries would make it worse; the dialog offers a manual Retry instead.
    retry: false,
  });

  return { safes: query.data ?? [], isLoading: query.isLoading, error: query.error, refetch: query.refetch };
}
