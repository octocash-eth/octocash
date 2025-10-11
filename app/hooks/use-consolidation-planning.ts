import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useRef } from "react";
import { planConsolidation } from "~/lib/planning";
import type { ConsolidationState, DestinationToken, SourceToken } from "~/lib/types";

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
  // Create a stable query key based on the plan ID (ensures unique plan per generation)
  const queryKey = useMemo(() => {
    return ["consolidation-plan", planId] as const;
  }, [planId]);

  const {
    data: plan,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey,
    queryFn: async () => planConsolidation(sourceTokens, destinationToken),
    enabled: enabled && sourceTokens.length > 0,
    staleTime: Number.POSITIVE_INFINITY, // Cache indefinitely within a component lifecycle
  });

  // Track the plan and its stable ID - only regenerate ID when plan data changes
  const stateRef = useRef<{
    plan: typeof plan;
    state: ConsolidationState;
    sourceTokens: SourceToken[];
    destinationToken: DestinationToken;
  } | null>(null);

  // Transform plan into ConsolidationState - use the provided planId
  const state = useMemo<ConsolidationState | null>(() => {
    if (!plan) return null;

    // If we already have a state for this exact plan reference, reuse it
    if (stateRef.current?.plan === plan) {
      return stateRef.current.state;
    }

    // New plan data - create new state with the provided planId
    const now = Date.now();
    const newState: ConsolidationState = {
      id: planId,
      plan,
      currentStepIndex: 0,
      status: "ready",
      results: {},
      sourceTokens,
      destinationToken,
      createdAt: now,
      updatedAt: now,
      hasSubsequentExecution: false,
    };

    // Store everything in ref to avoid recreating state
    stateRef.current = { plan, state: newState, sourceTokens, destinationToken };
    return newState;
  }, [plan, planId, sourceTokens, destinationToken]);

  // Wrap refetch to ensure we always get a new plan with a new ID
  const generatePlan = useCallback(async () => {
    // Clear the cached state ref to force new ID generation
    stateRef.current = null;
    return refetch();
  }, [refetch]);

  return {
    state,
    isPlanning: isLoading,
    planError: error instanceof Error ? error.message : "",
    generatePlan,
  };
}
