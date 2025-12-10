import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { ConsolidationState, TransactionStep } from "~/lib/types";
import { useConsolidationExecution } from "./use-consolidation-execution";

// Mock wagmi
const mockWalletClient = {
  account: { address: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd" as `0x${string}` },
  chain: { id: 1 },
};
const mockUseWalletClient = vi.fn();
vi.mock("wagmi", () => ({
  useWalletClient: () => mockUseWalletClient(),
}));

// Mock useConsolidationRecords
const mockSaveConsolidation = vi.fn();
const mockUseConsolidationRecords = vi.fn();
vi.mock("./use-consolidation-records", () => ({
  useConsolidationRecords: () => mockUseConsolidationRecords(),
}));

// Mock execution module
const mockExecuteConsolidationPlan = vi.fn();
vi.mock("~/lib/execution", () => ({
  executeConsolidationPlan: (...args: unknown[]) => mockExecuteConsolidationPlan(...args),
}));

describe("useConsolidationExecution", () => {
  const createMockStep = (overrides?: Partial<TransactionStep>): TransactionStep => ({
    id: "step-1",
    type: "swap",
    status: "pending",
    chainId: 1,
    inputTokens: [
      {
        token: "0x1234567890123456789012345678901234567890" as `0x${string}`,
        amount: 1000000n,
        chainId: 1,
        walletAddress: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd" as `0x${string}`,
        symbol: "USDC",
        decimals: 6,
      },
    ],
    outputToken: {
      token: "0x1234567890123456789012345678901234567890" as `0x${string}`,
      amount: 1000000n,
      chainId: 1,
      walletAddress: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd" as `0x${string}`,
      symbol: "USDC",
      decimals: 6,
    },
    ...overrides,
  });

  const createMockState = (overrides?: Partial<ConsolidationState>): ConsolidationState => ({
    id: "test-id-1",
    plan: [createMockStep()],
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
    hasSubsequentExecution: false,
    ...overrides,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockUseWalletClient.mockReturnValue({ data: mockWalletClient });
    mockUseConsolidationRecords.mockReturnValue({
      saveConsolidation: mockSaveConsolidation,
    });
  });

  describe("initialization", () => {
    test("initializes with null state when initialState is null", () => {
      const { result } = renderHook(() =>
        useConsolidationExecution({
          state: null,
        }),
      );

      expect(result.current.state).toBeNull();
      expect(result.current.isExecuting).toBe(false);
    });

    test("initializes with provided state", () => {
      const mockState = createMockState();
      const { result } = renderHook(() =>
        useConsolidationExecution({
          state: mockState,
        }),
      );

      expect(result.current.state).toEqual(mockState);
      expect(result.current.isExecuting).toBe(false);
    });
  });

  describe("state synchronization", () => {
    test("accepts new state with different id", () => {
      const initialState = createMockState({ id: "state-1" });
      const { result, rerender } = renderHook(
        ({ state }: { state: ConsolidationState | null }) => useConsolidationExecution({ state }),
        { initialProps: { state: initialState } },
      );

      expect(result.current.state?.id).toBe("state-1");

      const newState = createMockState({ id: "state-2" });
      rerender({ state: newState });

      expect(result.current.state?.id).toBe("state-2");
    });

    test("keeps newer state when incoming state is older", () => {
      const initialState = createMockState({ id: "state-1", updatedAt: 2000 });
      const { result, rerender } = renderHook(
        ({ state }: { state: ConsolidationState | null }) => useConsolidationExecution({ state }),
        { initialProps: { state: initialState } },
      );

      const olderState = createMockState({ id: "state-1", updatedAt: 1000 });
      rerender({ state: olderState });

      expect(result.current.state?.updatedAt).toBe(2000);
    });

    test("accepts newer state with same id", () => {
      const initialState = createMockState({ id: "state-1", updatedAt: 1000 });
      const { result, rerender } = renderHook(
        ({ state }: { state: ConsolidationState | null }) => useConsolidationExecution({ state }),
        { initialProps: { state: initialState } },
      );

      const newerState = createMockState({ id: "state-1", updatedAt: 2000 });
      rerender({ state: newerState });

      expect(result.current.state?.updatedAt).toBe(2000);
    });

    test("resets to null when incoming state is null", () => {
      const initialState = createMockState();
      const { result, rerender } = renderHook(
        ({ state }: { state: ConsolidationState | null }) => useConsolidationExecution({ state }),
        { initialProps: { state: initialState as ConsolidationState | null } },
      );

      expect(result.current.state).not.toBeNull();

      rerender({ state: null });

      expect(result.current.state).toBeNull();
    });
  });

  describe("executeOrResume", () => {
    test("does nothing when state is null", () => {
      const { result } = renderHook(() =>
        useConsolidationExecution({
          state: null,
        }),
      );

      act(() => {
        result.current.executeOrResume();
      });

      expect(mockExecuteConsolidationPlan).not.toHaveBeenCalled();
    });

    test("does nothing when already executing", async () => {
      const mockState = createMockState();
      const { result } = renderHook(() =>
        useConsolidationExecution({
          state: mockState,
        }),
      );

      // Create a never-resolving generator to keep isExecuting true
      mockExecuteConsolidationPlan.mockReturnValue(
        (async function* () {
          yield mockState;
          await new Promise(() => {}); // Never resolves
        })(),
      );

      act(() => {
        result.current.executeOrResume();
      });

      await waitFor(() => {
        expect(result.current.isExecuting).toBe(true);
      });

      mockExecuteConsolidationPlan.mockClear();

      act(() => {
        result.current.executeOrResume();
      });

      expect(mockExecuteConsolidationPlan).not.toHaveBeenCalled();
    });

    test("executes consolidation plan", async () => {
      const mockState = createMockState();
      const updatedState = createMockState({ status: "completed" });

      mockExecuteConsolidationPlan.mockReturnValue(
        (async function* () {
          yield updatedState;
        })(),
      );

      const { result } = renderHook(() =>
        useConsolidationExecution({
          state: mockState,
        }),
      );

      act(() => {
        result.current.executeOrResume();
      });

      await waitFor(() => {
        expect(result.current.isExecuting).toBe(false);
      });

      expect(mockExecuteConsolidationPlan).toHaveBeenCalledWith(mockState, mockWalletClient);
    });

    test("updates state during execution", async () => {
      const mockState = createMockState();
      const intermediateState = createMockState({ status: "executing" });
      const finalState = createMockState({ status: "completed" });

      mockExecuteConsolidationPlan.mockReturnValue(
        (async function* () {
          yield intermediateState;
          yield finalState;
        })(),
      );

      const { result } = renderHook(() =>
        useConsolidationExecution({
          state: mockState,
        }),
      );

      act(() => {
        result.current.executeOrResume();
      });

      await waitFor(() => {
        expect(result.current.state?.status).toBe("completed");
      });
    });

    test("saves consolidation during execution", async () => {
      const mockState = createMockState();
      const updatedState = createMockState({ status: "completed" });

      mockExecuteConsolidationPlan.mockReturnValue(
        (async function* () {
          yield updatedState;
        })(),
      );

      const { result } = renderHook(() =>
        useConsolidationExecution({
          state: mockState,
        }),
      );

      act(() => {
        result.current.executeOrResume();
      });

      await waitFor(() => {
        expect(mockSaveConsolidation).toHaveBeenCalledWith(updatedState);
      });
    });

    test("calls onComplete when status is completed", async () => {
      const mockState = createMockState();
      const completedState = createMockState({ status: "completed" });
      const onComplete = vi.fn();

      mockExecuteConsolidationPlan.mockReturnValue(
        (async function* () {
          yield completedState;
        })(),
      );

      const { result } = renderHook(() =>
        useConsolidationExecution({
          state: mockState,
          onComplete,
        }),
      );

      act(() => {
        result.current.executeOrResume();
      });

      await waitFor(() => {
        expect(onComplete).toHaveBeenCalledWith(completedState);
      });
    });

    test("calls onComplete when status is partial", async () => {
      const mockState = createMockState();
      const partialState = createMockState({ status: "partial" });
      const onComplete = vi.fn();

      mockExecuteConsolidationPlan.mockReturnValue(
        (async function* () {
          yield partialState;
        })(),
      );

      const { result } = renderHook(() =>
        useConsolidationExecution({
          state: mockState,
          onComplete,
        }),
      );

      act(() => {
        result.current.executeOrResume();
      });

      await waitFor(() => {
        expect(onComplete).toHaveBeenCalledWith(partialState);
      });
    });

    test("calls onComplete when status is paused", async () => {
      const mockState = createMockState();
      const pausedState = createMockState({ status: "paused" });
      const onComplete = vi.fn();

      mockExecuteConsolidationPlan.mockReturnValue(
        (async function* () {
          yield pausedState;
        })(),
      );

      const { result } = renderHook(() =>
        useConsolidationExecution({
          state: mockState,
          onComplete,
        }),
      );

      act(() => {
        result.current.executeOrResume();
      });

      await waitFor(() => {
        expect(onComplete).toHaveBeenCalledWith(pausedState);
      });
    });

    test("does not call onComplete for other statuses", async () => {
      const mockState = createMockState();
      const executingState = createMockState({ status: "executing" });
      const onComplete = vi.fn();

      mockExecuteConsolidationPlan.mockReturnValue(
        (async function* () {
          yield executingState;
        })(),
      );

      const { result } = renderHook(() =>
        useConsolidationExecution({
          state: mockState,
          onComplete,
        }),
      );

      act(() => {
        result.current.executeOrResume();
      });

      await waitFor(() => {
        expect(result.current.isExecuting).toBe(false);
      });

      expect(onComplete).not.toHaveBeenCalled();
    });

    test("handles execution errors gracefully", async () => {
      const mockState = createMockState();

      // Mock an async generator that throws an error after yielding
      mockExecuteConsolidationPlan.mockReturnValue(
        (async function* () {
          // Yield once before throwing to satisfy generator requirement
          yield mockState;
          throw new Error("Execution failed");
        })(),
      );

      const { result } = renderHook(() =>
        useConsolidationExecution({
          state: mockState,
        }),
      );

      act(() => {
        result.current.executeOrResume();
      });

      await waitFor(() => {
        expect(result.current.isExecuting).toBe(false);
      });
    });

    test("does not execute when wallet client is not available", async () => {
      mockUseWalletClient.mockReturnValue({ data: undefined });
      const mockState = createMockState();

      const { result } = renderHook(() =>
        useConsolidationExecution({
          state: mockState,
        }),
      );

      act(() => {
        result.current.executeOrResume();
      });

      await waitFor(() => {
        expect(result.current.isExecuting).toBe(false);
      });

      expect(mockExecuteConsolidationPlan).not.toHaveBeenCalled();
    });
  });

  describe("retryFailedStep", () => {
    test("retries the most recent failed step", async () => {
      const step1 = createMockStep({ id: "step-1", status: "success" });
      const step2 = createMockStep({ id: "step-2", status: "failed" });
      const mockState = createMockState({
        plan: [step1, step2],
      });

      const retriedState = createMockState({ status: "completed" });
      mockExecuteConsolidationPlan.mockReturnValue(
        (async function* () {
          yield retriedState;
        })(),
      );

      const { result } = renderHook(() =>
        useConsolidationExecution({
          state: mockState,
        }),
      );

      await act(async () => {
        await result.current.retryFailedStep();
      });

      await waitFor(() => {
        expect(result.current.isExecuting).toBe(false);
      });

      expect(mockSaveConsolidation).toHaveBeenCalled();
    });

    test("does nothing when no failed steps exist", async () => {
      const mockState = createMockState({
        plan: [createMockStep({ status: "success" })],
      });

      const { result } = renderHook(() =>
        useConsolidationExecution({
          state: mockState,
        }),
      );

      await act(async () => {
        await result.current.retryFailedStep();
      });

      expect(mockExecuteConsolidationPlan).not.toHaveBeenCalled();
    });

    test("does nothing when state is null", async () => {
      const { result } = renderHook(() =>
        useConsolidationExecution({
          state: null,
        }),
      );

      await act(async () => {
        await result.current.retryFailedStep();
      });

      expect(mockExecuteConsolidationPlan).not.toHaveBeenCalled();
    });
  });

  describe("skipFailedStep", () => {
    test("skips the most recent failed step", async () => {
      const step1 = createMockStep({ id: "step-1", status: "success" });
      const step2 = createMockStep({ id: "step-2", status: "failed" });
      const mockState = createMockState({
        plan: [step1, step2],
      });

      const skippedState = createMockState({ status: "partial" });
      mockExecuteConsolidationPlan.mockReturnValue(
        (async function* () {
          yield skippedState;
        })(),
      );

      const { result } = renderHook(() =>
        useConsolidationExecution({
          state: mockState,
        }),
      );

      await act(async () => {
        await result.current.skipFailedStep();
      });

      await waitFor(() => {
        expect(result.current.isExecuting).toBe(false);
      });

      expect(mockSaveConsolidation).toHaveBeenCalled();
    });

    test("does nothing when no failed steps exist", async () => {
      const mockState = createMockState({
        plan: [createMockStep({ status: "success" })],
      });

      const { result } = renderHook(() =>
        useConsolidationExecution({
          state: mockState,
        }),
      );

      await act(async () => {
        await result.current.skipFailedStep();
      });

      expect(mockExecuteConsolidationPlan).not.toHaveBeenCalled();
    });

    test("does nothing when state is null", async () => {
      const { result } = renderHook(() =>
        useConsolidationExecution({
          state: null,
        }),
      );

      await act(async () => {
        await result.current.skipFailedStep();
      });

      expect(mockExecuteConsolidationPlan).not.toHaveBeenCalled();
    });
  });
});
