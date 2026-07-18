import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { type AccountsMap, toAccountsRecord } from "~/lib/accounts";
import { planConsolidation } from "~/lib/planning";
import type { ConsolidationState, DestinationToken, SourceToken } from "~/lib/types";
import { useConnectedAddresses } from "./use-connected-addresses";

/** Stable empty array so consumers' deps don't churn between renders. */
const EMPTY_WARNINGS: string[] = [];

interface UseConsolidationPlanningOptions {
  sourceTokens: SourceToken[];
  destinationToken: DestinationToken;
  enabled?: boolean; // Allow disabling the query (e.g., during execution)
  planId: string; // Unique plan ID to use for this consolidation
  /** Account-kind lookup (enabled Safes + deployments); absent => all-EOA. */
  accounts?: AccountsMap;
}

/**
 * Hook for generating a consolidation plan from source and destination tokens.
 * Automatically generates the plan when tokens are provided.
 */
export function useConsolidationPlanning({
  sourceTokens,
  destinationToken,
  enabled = true,
  planId,
  accounts,
}: UseConsolidationPlanningOptions) {
  const connectedWallets = useConnectedAddresses();

  // Enabled Safe addresses count as plannable wallets alongside connected EOAs.
  const allWallets = useMemo(() => {
    const safeAddresses = Array.from(accounts?.values() ?? []).flatMap((account) =>
      account.kind === "safe" ? [account.address] : [],
    );
    return [...connectedWallets, ...safeAddresses];
  }, [connectedWallets, accounts]);

  // Key includes each Safe's / smart wallet's per-chain deployments so a
  // re-discovery that changes owners/threshold/deployed-chains/capabilities
  // invalidates the cached plan.
  const walletKey = useMemo(() => {
    const eoaKey = connectedWallets
      .map((address) => address.toLowerCase())
      .sort()
      .join(",");
    const accountKey = Array.from(accounts?.values() ?? [])
      .flatMap((account) => {
        if (account.kind === "safe") {
          return [
            `safe:${account.address.toLowerCase()}:${Object.values(account.deployments)
              .map((d) => `${d.chainId}/${d.threshold}/${d.controlled ? 1 : 0}`)
              .sort()
              .join("+")}`,
          ];
        }
        if (account.kind === "smart") {
          return [
            `smart:${account.address.toLowerCase()}:${Object.values(account.deployments)
              .map((d) => `${d.chainId}/${d.atomic}`)
              .sort()
              .join("+")}`,
          ];
        }
        return [];
      })
      .sort()
      .join(",");
    return `${eoaKey}|${accountKey}`;
  }, [connectedWallets, accounts]);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["consolidation-plan", planId, walletKey],
    queryFn: async () => {
      const warnings: string[] = [];
      const steps = await planConsolidation(sourceTokens, destinationToken, allWallets, undefined, accounts, warnings);
      return { steps, warnings };
    },
    enabled: enabled && sourceTokens.length > 0,
    staleTime: Number.POSITIVE_INFINITY, // Cache indefinitely within a component lifecycle
    // Planning failures are deterministic (validation, value floors, unusable
    // accounts) — TanStack's default 3 background retries would silently
    // re-run the whole RPC-heavy pipeline against an unchanged outcome. The
    // PlanError UI owns retrying (countdown for transient API errors).
    retry: false,
  });
  const plan = data?.steps;
  const planWarnings = data?.warnings ?? EMPTY_WARNINGS;

  // Transform plan into ConsolidationState - use the provided planId
  const state = useMemo<ConsolidationState | null>(() => {
    if (!plan) return null;

    const timestamp = Date.now();
    return {
      id: planId,
      plan,
      currentStepIndex: 0,
      status: "ready",
      results: {},
      sourceTokens,
      destinationToken,
      // Snapshot account kinds so a resumed execution (possibly days later)
      // doesn't depend on live Safe discovery.
      ...(accounts && accounts.size > 0 ? { accounts: toAccountsRecord(accounts) } : {}),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
  }, [plan, planId, sourceTokens, destinationToken, accounts]);

  const generatePlan = useCallback(() => refetch(), [refetch]);

  // Track how many times planning has failed in a row. Resets to 0 on success.
  // The countdown UI keys off this so a fresh failure restarts the timer even
  // when TanStack reuses the same Error instance across renders.
  const [attemptCount, setAttemptCount] = useState(0);
  useEffect(() => {
    if (error) setAttemptCount((n) => n + 1);
    else if (plan) setAttemptCount(0);
  }, [error, plan]);

  return {
    state,
    isPlanning: isLoading,
    planError: error instanceof Error ? error.message : "",
    /** Non-fatal planning notes, e.g. Gnosis tokens dropped below the hop value floor. */
    planWarnings,
    generatePlan,
    attemptCount,
  };
}
