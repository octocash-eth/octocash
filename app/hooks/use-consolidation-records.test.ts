import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { ConsolidationState } from "~/lib/types";
import { useConsolidationRecords } from "./use-consolidation-records";

// Mock use-local-storage-state
let mockStorageState: Record<string, ConsolidationState> = {};
const mockSetStorageState = vi.fn((updater: unknown) => {
  if (typeof updater === "function") {
    mockStorageState = updater(mockStorageState);
  } else {
    mockStorageState = updater as Record<string, ConsolidationState>;
  }
});

vi.mock("use-local-storage-state", () => ({
  default: vi.fn(() => [mockStorageState, mockSetStorageState]),
}));

// Mock superjson
vi.mock("superjson", () => ({
  parse: vi.fn((value) => JSON.parse(value)),
  stringify: vi.fn((value) => JSON.stringify(value)),
}));

describe("useConsolidationRecords", () => {
  const createMockConsolidationState = (overrides?: Partial<ConsolidationState>): ConsolidationState => ({
    id: "test-id-1",
    plan: [],
    currentStepIndex: 0,
    status: "ready",
    results: {},
    sourceTokens: [],
    destinationToken: {
      token: "0x1234567890123456789012345678901234567890" as `0x${string}`,
      chainId: 1,
      walletAddress: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd" as `0x${string}`,
      symbol: "USDC",
      decimals: 6,
    },
    createdAt: 1000000,
    updatedAt: 1000000,
    ...overrides,
  });

  beforeEach(() => {
    mockStorageState = {};
    mockSetStorageState.mockClear();
  });

  describe("initialization", () => {
    test("returns empty consolidations array when no records exist", () => {
      const { result } = renderHook(() => useConsolidationRecords());
      expect(result.current.consolidations).toEqual([]);
    });

    test("returns consolidations from storage", () => {
      const state1 = createMockConsolidationState({ id: "test-1", updatedAt: 1000 });
      const state2 = createMockConsolidationState({ id: "test-2", updatedAt: 2000 });
      mockStorageState = {
        "test-1": state1,
        "test-2": state2,
      };

      const { result } = renderHook(() => useConsolidationRecords());
      expect(result.current.consolidations).toHaveLength(2);
      expect(result.current.consolidations).toContainEqual(state1);
      expect(result.current.consolidations).toContainEqual(state2);
    });
  });

  describe("saveConsolidation", () => {
    test("saves a new consolidation", () => {
      const { result } = renderHook(() => useConsolidationRecords());
      const state = createMockConsolidationState();

      act(() => {
        result.current.saveConsolidation(state);
      });

      expect(mockSetStorageState).toHaveBeenCalled();
      expect(mockStorageState[state.id]).toEqual(state);
    });

    test("updates an existing consolidation", () => {
      const initialState = createMockConsolidationState({ id: "test-1", updatedAt: 1000 });
      mockStorageState = { "test-1": initialState };

      const { result } = renderHook(() => useConsolidationRecords());
      const updatedState = createMockConsolidationState({ id: "test-1", updatedAt: 2000, status: "completed" });

      act(() => {
        result.current.saveConsolidation(updatedState);
      });

      expect(mockStorageState["test-1"]).toEqual(updatedState);
      expect(mockStorageState["test-1"].status).toBe("completed");
    });

    test("saves multiple consolidations", () => {
      const { result } = renderHook(() => useConsolidationRecords());
      const state1 = createMockConsolidationState({ id: "test-1" });
      const state2 = createMockConsolidationState({ id: "test-2" });

      act(() => {
        result.current.saveConsolidation(state1);
      });

      act(() => {
        result.current.saveConsolidation(state2);
      });

      expect(mockStorageState["test-1"]).toEqual(state1);
      expect(mockStorageState["test-2"]).toEqual(state2);
    });
  });

  describe("getAllConsolidations", () => {
    test("returns empty array when no consolidations exist", () => {
      const { result } = renderHook(() => useConsolidationRecords());
      expect(result.current.consolidations).toEqual([]);
    });

    test("returns consolidations sorted by most recent first", () => {
      const state1 = createMockConsolidationState({ id: "test-1", updatedAt: 1000 });
      const state2 = createMockConsolidationState({ id: "test-2", updatedAt: 3000 });
      const state3 = createMockConsolidationState({ id: "test-3", updatedAt: 2000 });
      mockStorageState = {
        "test-1": state1,
        "test-2": state2,
        "test-3": state3,
      };

      const { result } = renderHook(() => useConsolidationRecords());
      expect(result.current.consolidations).toHaveLength(3);
      expect(result.current.consolidations[0].id).toBe("test-2"); // Most recent
      expect(result.current.consolidations[1].id).toBe("test-3");
      expect(result.current.consolidations[2].id).toBe("test-1"); // Oldest
    });
  });

  describe("getConsolidation", () => {
    test("returns consolidation by id", () => {
      const state = createMockConsolidationState({ id: "test-1" });
      mockStorageState = { "test-1": state };

      const { result } = renderHook(() => useConsolidationRecords());
      const retrieved = result.current.getConsolidation("test-1");
      expect(retrieved).toEqual(state);
    });

    test("returns undefined for non-existent id", () => {
      const { result } = renderHook(() => useConsolidationRecords());
      const retrieved = result.current.getConsolidation("non-existent");
      expect(retrieved).toBeUndefined();
    });

    test("returns correct consolidation when multiple exist", () => {
      const state1 = createMockConsolidationState({ id: "test-1" });
      const state2 = createMockConsolidationState({ id: "test-2" });
      mockStorageState = {
        "test-1": state1,
        "test-2": state2,
      };

      const { result } = renderHook(() => useConsolidationRecords());
      const retrieved = result.current.getConsolidation("test-2");
      expect(retrieved).toEqual(state2);
    });
  });

  describe("removeConsolidation", () => {
    test("removes a consolidation by id", () => {
      const state = createMockConsolidationState({ id: "test-1" });
      mockStorageState = { "test-1": state };

      const { result } = renderHook(() => useConsolidationRecords());

      act(() => {
        result.current.removeConsolidation("test-1");
      });

      expect(mockStorageState["test-1"]).toBeUndefined();
    });

    test("keeps other consolidations when removing one", () => {
      const state1 = createMockConsolidationState({ id: "test-1" });
      const state2 = createMockConsolidationState({ id: "test-2" });
      mockStorageState = {
        "test-1": state1,
        "test-2": state2,
      };

      const { result } = renderHook(() => useConsolidationRecords());

      act(() => {
        result.current.removeConsolidation("test-1");
      });

      expect(mockStorageState["test-1"]).toBeUndefined();
      expect(mockStorageState["test-2"]).toEqual(state2);
    });

    test("does nothing when removing non-existent id", () => {
      const state = createMockConsolidationState({ id: "test-1" });
      mockStorageState = { "test-1": state };

      const { result } = renderHook(() => useConsolidationRecords());

      act(() => {
        result.current.removeConsolidation("non-existent");
      });

      expect(mockStorageState["test-1"]).toEqual(state);
    });
  });

  describe("clearAll", () => {
    test("removes all consolidations", () => {
      const state1 = createMockConsolidationState({ id: "test-1" });
      const state2 = createMockConsolidationState({ id: "test-2" });
      mockStorageState = {
        "test-1": state1,
        "test-2": state2,
      };

      const { result } = renderHook(() => useConsolidationRecords());

      act(() => {
        result.current.clearAll();
      });

      expect(mockStorageState).toEqual({});
    });

    test("does nothing when already empty", () => {
      const { result } = renderHook(() => useConsolidationRecords());

      act(() => {
        result.current.clearAll();
      });

      expect(mockStorageState).toEqual({});
    });
  });

  describe("getIncompleteConsolidations", () => {
    test("returns consolidations with executing status", () => {
      const state = createMockConsolidationState({ id: "test-1", status: "executing" });
      mockStorageState = { "test-1": state };

      const { result } = renderHook(() => useConsolidationRecords());
      const incomplete = result.current.getIncompleteConsolidations();
      expect(incomplete).toHaveLength(1);
      expect(incomplete[0]).toEqual(state);
    });

    test("returns consolidations with paused status", () => {
      const state = createMockConsolidationState({ id: "test-1", status: "paused" });
      mockStorageState = { "test-1": state };

      const { result } = renderHook(() => useConsolidationRecords());
      const incomplete = result.current.getIncompleteConsolidations();
      expect(incomplete).toHaveLength(1);
      expect(incomplete[0]).toEqual(state);
    });

    test("returns consolidations with ready status", () => {
      const state = createMockConsolidationState({ id: "test-1", status: "ready" });
      mockStorageState = { "test-1": state };

      const { result } = renderHook(() => useConsolidationRecords());
      const incomplete = result.current.getIncompleteConsolidations();
      expect(incomplete).toHaveLength(1);
      expect(incomplete[0]).toEqual(state);
    });

    test("does not return completed consolidations", () => {
      const state = createMockConsolidationState({ id: "test-1", status: "completed" });
      mockStorageState = { "test-1": state };

      const { result } = renderHook(() => useConsolidationRecords());
      const incomplete = result.current.getIncompleteConsolidations();
      expect(incomplete).toHaveLength(0);
    });

    test("does not return partial consolidations", () => {
      const state = createMockConsolidationState({ id: "test-1", status: "partial" });
      mockStorageState = { "test-1": state };

      const { result } = renderHook(() => useConsolidationRecords());
      const incomplete = result.current.getIncompleteConsolidations();
      expect(incomplete).toHaveLength(0);
    });

    test("does not return planning consolidations", () => {
      const state = createMockConsolidationState({ id: "test-1", status: "planning" });
      mockStorageState = { "test-1": state };

      const { result } = renderHook(() => useConsolidationRecords());
      const incomplete = result.current.getIncompleteConsolidations();
      expect(incomplete).toHaveLength(0);
    });

    test("returns multiple incomplete consolidations", () => {
      const state1 = createMockConsolidationState({ id: "test-1", status: "executing" });
      const state2 = createMockConsolidationState({ id: "test-2", status: "completed" });
      const state3 = createMockConsolidationState({ id: "test-3", status: "paused" });
      const state4 = createMockConsolidationState({ id: "test-4", status: "ready" });
      mockStorageState = {
        "test-1": state1,
        "test-2": state2,
        "test-3": state3,
        "test-4": state4,
      };

      const { result } = renderHook(() => useConsolidationRecords());
      const incomplete = result.current.getIncompleteConsolidations();
      expect(incomplete).toHaveLength(3);
      expect(incomplete).toContainEqual(state1);
      expect(incomplete).toContainEqual(state3);
      expect(incomplete).toContainEqual(state4);
      expect(incomplete).not.toContainEqual(state2);
    });

    test("returns empty array when no incomplete consolidations exist", () => {
      const state1 = createMockConsolidationState({ id: "test-1", status: "completed" });
      const state2 = createMockConsolidationState({ id: "test-2", status: "partial" });
      mockStorageState = {
        "test-1": state1,
        "test-2": state2,
      };

      const { result } = renderHook(() => useConsolidationRecords());
      const incomplete = result.current.getIncompleteConsolidations();
      expect(incomplete).toHaveLength(0);
    });
  });
});
