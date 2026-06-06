import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { planConsolidation } from "~/lib/planning";
import type { ConsolidationState, DestinationToken, SourceToken } from "~/lib/types";
import { useConnectedAddresses } from "./use-connected-addresses";

interface UseConsolidationPlanningOptions {
  sourceTokens: SourceToken[];
  destinationToken: DestinationToken;
  enabled?: boolean; // Allow disabling the query (e.g., during execution)
  planId: string; // Unique plan ID to use for this consolidation
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
}: UseConsolidationPlanningOptions) {
  const connectedWallets = useConnectedAddresses();
  const connectedWalletKey = useMemo(() => {
    return connectedWallets
      .map((address) => address.toLowerCase())
      .sort()
      .join(",");
  }, [connectedWallets]);

  const {
    data: plan,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: ["consolidation-plan", planId, connectedWalletKey],
    queryFn: () => planConsolidation(sourceTokens, destinationToken, connectedWallets),
    enabled: enabled && sourceTokens.length > 0,
    staleTime: Number.POSITIVE_INFINITY, // Cache indefinitely within a component lifecycle
  });

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
      createdAt: timestamp,
      updatedAt: timestamp,
    };
  }, [plan, planId, sourceTokens, destinationToken]);

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
    generatePlan,
    attemptCount,
  };
}
