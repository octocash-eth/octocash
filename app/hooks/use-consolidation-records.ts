import { parse, stringify } from "superjson";
import useLocalStorageState from "use-local-storage-state";
import type { TokenAmount } from "~/lib/consolidation";

type ConsolidationRecord = {
  id: string;
  timestamp: number;
  sourceTokens: TokenAmount[];
  destinationToken: TokenAmount;
  status: "completed" | "error";
};

const STORAGE_KEY = "octocash.history";

export function useConsolidationRecords() {
  const [records, setRecords] = useLocalStorageState<ConsolidationRecord[]>(STORAGE_KEY, {
    defaultValue: [],
    serializer: {
      stringify,
      parse,
    },
  });

  return [records, setRecords] as const;
}
