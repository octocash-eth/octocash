import type { TokenAmount } from "~/lib/consolidation";

export type ConsolidationStatus = "completed" | "error";

export interface ConsolidationRecord {
  id: string;
  timestamp: number;
  sourceTokens: TokenAmount[];
  destinationToken: TokenAmount;
  status: ConsolidationStatus;
  errorMessage?: string;
}

const STORAGE_KEY = "octocash.consolidations";

// JSON helpers to safely (de)serialize BigInt
function stringifyWithBigInt(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (typeof v === "bigint") {
      return { __type: "bigint", value: v.toString() };
    }
    return v as unknown;
  });
}

function parseWithBigInt<T = unknown>(text: string): T {
  return JSON.parse(text, (_key, v) => {
    if (v && typeof v === "object" && "__type" in v && v.__type === "bigint") {
      return BigInt((v as { value: string }).value);
    }
    return v;
  }) as T;
}

export function addConsolidationRecord(record: ConsolidationRecord) {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const list: ConsolidationRecord[] = raw ? parseWithBigInt<ConsolidationRecord[]>(raw) : [];
    list.unshift(record);
    localStorage.setItem(STORAGE_KEY, stringifyWithBigInt(list));
  } catch (err) {
    console.error("Failed to persist consolidation record", err);
  }
}

export function getConsolidationRecords(): ConsolidationRecord[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? parseWithBigInt<ConsolidationRecord[]>(raw) : [];
  } catch (err) {
    console.error("Failed to read consolidation records", err);
    return [];
  }
}

export function clearConsolidationRecords() {
  localStorage.removeItem(STORAGE_KEY);
}
