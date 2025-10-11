import { parse, stringify } from "superjson";
import useLocalStorageState from "use-local-storage-state";
import type { ConsolidationState } from "~/lib/types";

const STORAGE_KEY = "octocash:consolidations";

export function useConsolidationRecords() {
  const [consolidations, setConsolidations] = useLocalStorageState<Record<string, ConsolidationState>>(STORAGE_KEY, {
    defaultValue: {},
    serializer: { stringify, parse },
  });

  // Save or update a consolidation
  const saveConsolidation = (state: ConsolidationState) => {
    setConsolidations((prev) => ({
      ...prev,
      [state.id]: state,
    }));
  };

  // Get all consolidations sorted by most recent
  const getAllConsolidations = (): ConsolidationState[] => {
    return Object.values(consolidations).sort((a, b) => b.updatedAt - a.updatedAt);
  };

  // Get a single consolidation by ID
  const getConsolidation = (id: string): ConsolidationState | undefined => {
    return consolidations[id];
  };

  // Remove a consolidation
  const removeConsolidation = (id: string) => {
    setConsolidations((prev) => {
      const { [id]: _, ...rest } = prev;
      return rest;
    });
  };

  // Clear all consolidations
  const clearAll = () => {
    setConsolidations({});
  };

  // Get incomplete consolidations (for recovery)
  const getIncompleteConsolidations = (): ConsolidationState[] => {
    return Object.values(consolidations).filter(
      (state) => state.status === "executing" || state.status === "paused" || state.status === "ready",
    );
  };

  return {
    consolidations: getAllConsolidations(),
    saveConsolidation,
    getConsolidation,
    removeConsolidation,
    clearAll,
    getIncompleteConsolidations,
  };
}
