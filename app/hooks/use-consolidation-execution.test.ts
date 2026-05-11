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
const mockRefreshPendingSteps = vi.fn();
vi.mock("~/lib/execution", () => ({
  executeConsolidationPlan: (...args: unknown[]) => mockExecuteConsolidationPlan(...args),
  refreshPendingSteps: (...args: unknown[]) => mockRefreshPendingSteps(...args),
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
    // Default: refresh tick is a no-op (returns the snapshot unchanged so
    // the hook's referential-equality check skips setState/save).
    mockRefreshPendingSteps.mockImplementation(async (snapshot: ConsolidationState) => snapshot);
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

      expect(mockExecuteConsolidationPlan).toHaveBeenCalledWith(
        mockState,
        mockWalletClient,
        expect.objectContaining({
          onStepStall: expect.any(Function),
          onStepHashSent: expect.any(Function),
        }),
      );
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

  describe("stalledSteps / triggerStallAction", () => {
    test("exposes empty stalledSteps initially", () => {
      const { result } = renderHook(() => useConsolidationExecution({ state: createMockState() }));
      expect(result.current.stalledSteps).toEqual({});
    });

    test("captures the unified {kind, trigger} handle when the executor reports a stall", async () => {
      const mockState = createMockState();
      const triggerFn = vi.fn();

      // Generator yields executing, fires onStepStall, then hangs on a
      // never-resolving promise. This keeps `isExecuting = true` so we can
      // observe the stalled state before the hook's finally-block clears it.
      mockExecuteConsolidationPlan.mockImplementation(
        (_state: unknown, _wallet: unknown, callbacks?: { onStepStall?: (info: unknown) => void }) =>
          (async function* () {
            yield createMockState({ status: "executing" });
            callbacks?.onStepStall?.({
              stepId: "step-1",
              txId: "step-1",
              stepIndex: 0,
              hash: "0xstuck",
              nonce: 5,
              kind: "resend",
              trigger: triggerFn,
            });
            await new Promise(() => {}); // never resolves; keeps the loop alive
          })(),
      );

      const { result } = renderHook(() => useConsolidationExecution({ state: mockState }));

      act(() => {
        result.current.executeOrResume();
      });

      await waitFor(() => {
        expect(result.current.stalledSteps["step-1"]).toBeDefined();
      });

      expect(result.current.stalledSteps["step-1"].kind).toBe("resend");

      // triggerStallAction should invoke the captured handle.
      act(() => {
        result.current.triggerStallAction("step-1");
      });
      expect(triggerFn).toHaveBeenCalledTimes(1);

      // After the trigger fires, the stall handle is optimistically cleared
      // so the UI hides the CTA until another stall fires.
      expect(result.current.stalledSteps["step-1"]).toBeUndefined();
    });

    test("captures kind='retry' for sim-reverts stalls", async () => {
      const mockState = createMockState();
      const triggerFn = vi.fn();

      mockExecuteConsolidationPlan.mockImplementation(
        (_state: unknown, _wallet: unknown, callbacks?: { onStepStall?: (info: unknown) => void }) =>
          (async function* () {
            yield createMockState({ status: "executing" });
            callbacks?.onStepStall?.({
              stepId: "step-1",
              txId: "step-1",
              stepIndex: 0,
              hash: "0xstuck",
              nonce: 5,
              kind: "retry",
              trigger: triggerFn,
            });
            await new Promise(() => {});
          })(),
      );

      const { result } = renderHook(() => useConsolidationExecution({ state: mockState }));

      act(() => {
        result.current.executeOrResume();
      });

      await waitFor(() => {
        expect(result.current.stalledSteps["step-1"]).toBeDefined();
      });

      // The hook surfaces the kind discriminator as-is so the UI can pick a
      // label/icon ("Retry") without re-deriving it.
      expect(result.current.stalledSteps["step-1"].kind).toBe("retry");
    });

    test("triggerStallAction is a no-op when no handle is active for stepId", () => {
      const { result } = renderHook(() => useConsolidationExecution({ state: createMockState() }));
      expect(() => result.current.triggerStallAction("nonexistent")).not.toThrow();
    });

    test("clears stalled handles after execution finishes", async () => {
      const mockState = createMockState();
      const triggerFn = vi.fn();

      mockExecuteConsolidationPlan.mockImplementation(
        (_state: unknown, _wallet: unknown, callbacks?: { onStepStall?: (info: unknown) => void }) =>
          (async function* () {
            yield createMockState({ status: "executing" });
            callbacks?.onStepStall?.({
              stepId: "step-1",
              txId: "step-1",
              stepIndex: 0,
              hash: "0xstuck",
              nonce: 5,
              kind: "resend",
              trigger: triggerFn,
            });
            yield createMockState({ status: "completed" });
          })(),
      );

      const { result } = renderHook(() => useConsolidationExecution({ state: mockState }));

      act(() => {
        result.current.executeOrResume();
      });

      await waitFor(() => {
        expect(result.current.isExecuting).toBe(false);
      });

      // After execution wraps up, handles are dropped so the UI never shows
      // a stale Resend / Retry CTA on a finished step.
      expect(result.current.stalledSteps).toEqual({});
    });

    test("does NOT capture the stall handle when nonce is undefined (parallel-send guard)", async () => {
      const mockState = createMockState();
      const triggerFn = vi.fn();

      mockExecuteConsolidationPlan.mockImplementation(
        (_state: unknown, _wallet: unknown, callbacks?: { onStepStall?: (info: unknown) => void }) =>
          (async function* () {
            yield createMockState({ status: "executing" });
            callbacks?.onStepStall?.({
              stepId: "step-1",
              txId: "step-1",
              stepIndex: 0,
              hash: "0xstuck",
              nonce: undefined,
              kind: "resend",
              trigger: triggerFn,
            });
            await new Promise(() => {});
          })(),
      );

      // Silence the warning the hook emits in this case.
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const { result } = renderHook(() => useConsolidationExecution({ state: mockState }));

      act(() => {
        result.current.executeOrResume();
      });

      await waitFor(() => {
        expect(result.current.isExecuting).toBe(true);
      });

      // Without a known nonce, the hook refuses to expose a CTA: a
      // replacement would create a parallel tx rather than replace the
      // stuck one.
      expect(result.current.stalledSteps["step-1"]).toBeUndefined();
      // triggerStallAction is a no-op (the underlying trigger never fires).
      act(() => {
        result.current.triggerStallAction("step-1");
      });
      expect(triggerFn).not.toHaveBeenCalled();

      warnSpy.mockRestore();
    });
  });

  describe("pendingTx persistence (audit trail)", () => {
    test("appends each broadcast hash to the step's pendingTx and persists immediately", async () => {
      const mockState = createMockState();

      mockExecuteConsolidationPlan.mockImplementation(
        (
          _state: unknown,
          _wallet: unknown,
          callbacks?: {
            onStepHashSent?: (info: {
              stepId: string;
              hash: `0x${string}`;
              nonce: number | undefined;
              account: `0x${string}`;
              chainId: number;
            }) => void;
          },
        ) =>
          (async function* () {
            yield createMockState({ status: "executing" });
            callbacks?.onStepHashSent?.({
              stepId: "step-1",
              hash: "0xfirst",
              nonce: 7,
              account: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
              chainId: 1,
            });
            callbacks?.onStepHashSent?.({
              stepId: "step-1",
              hash: "0xsecond",
              nonce: 7,
              account: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
              chainId: 1,
            });
            await new Promise(() => {});
          })(),
      );

      const { result } = renderHook(() => useConsolidationExecution({ state: mockState }));

      act(() => {
        result.current.executeOrResume();
      });

      await waitFor(() => {
        const step = result.current.state?.plan.find((s) => s.id === "step-1");
        expect(step?.pendingTx?.hashes).toEqual(["0xfirst", "0xsecond"]);
      });

      // The latest persisted state should include both hashes — verifying
      // synchronous save-on-broadcast (the user could close the tab right
      // after this).
      const lastSave = mockSaveConsolidation.mock.calls[mockSaveConsolidation.mock.calls.length - 1][0];
      const persistedStep = lastSave.plan.find((s: { id: string }) => s.id === "step-1");
      expect(persistedStep?.pendingTx?.hashes).toEqual(["0xfirst", "0xsecond"]);
      expect(persistedStep?.pendingTx?.nonce).toBe(7);
      expect(persistedStep?.pendingTx?.account).toBe("0xabcdefabcdefabcdefabcdefabcdefabcdefabcd");
    });

    test("preserves pendingTx on the step after the generator yields a success state", async () => {
      const mockState = createMockState();

      mockExecuteConsolidationPlan.mockImplementation(
        (
          _state: unknown,
          _wallet: unknown,
          callbacks?: {
            onStepHashSent?: (info: {
              stepId: string;
              hash: `0x${string}`;
              nonce: number | undefined;
              account: `0x${string}`;
              chainId: number;
            }) => void;
          },
        ) =>
          (async function* () {
            yield createMockState({ status: "executing" });
            callbacks?.onStepHashSent?.({
              stepId: "step-1",
              hash: "0xattempt1",
              nonce: 5,
              account: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
              chainId: 1,
            });
            callbacks?.onStepHashSent?.({
              stepId: "step-1",
              hash: "0xattempt2",
              nonce: 5,
              account: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
              chainId: 1,
            });
            // Generator yields its own state next (without pendingTx); the
            // hook MUST merge our in-flight ref so the audit trail survives.
            yield createMockState({ status: "completed" });
          })(),
      );

      const { result } = renderHook(() => useConsolidationExecution({ state: mockState }));

      act(() => {
        result.current.executeOrResume();
      });

      await waitFor(() => {
        expect(result.current.isExecuting).toBe(false);
      });

      const step = result.current.state?.plan.find((s) => s.id === "step-1");
      expect(step?.pendingTx?.hashes).toEqual(["0xattempt1", "0xattempt2"]);
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

  describe("proactive 30s refresh tick", () => {
    test("fires refreshPendingSteps roughly every 30s while the generator is mid-execution", async () => {
      const mockState = createMockState();

      // Generator parks on a never-resolving await so we can step the timer
      // forward and observe the background tick firing.
      mockExecuteConsolidationPlan.mockImplementation(() =>
        (async function* () {
          yield createMockState({ status: "executing" });
          await new Promise(() => {}); // keep isExecuting=true forever
        })(),
      );

      vi.useFakeTimers();

      const { result, unmount } = renderHook(() => useConsolidationExecution({ state: mockState }));

      await act(async () => {
        result.current.executeOrResume();
      });
      // Let the generator's first yield + the hook's setInterval setup run.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(mockRefreshPendingSteps).not.toHaveBeenCalled();

      // Cross the 30s boundary → exactly one tick.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(mockRefreshPendingSteps).toHaveBeenCalledTimes(1);

      // Cross a second boundary → tick again.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(mockRefreshPendingSteps).toHaveBeenCalledTimes(2);

      unmount();
      vi.useRealTimers();
    });

    test("clears the interval when the generator finishes (no further refresh ticks once isExecuting=false)", async () => {
      const mockState = createMockState();

      // Generator yields a single completed state and returns; the hook's
      // finally-block must clearInterval so subsequent setTimeout advances
      // do NOT fire another refreshPendingSteps.
      mockExecuteConsolidationPlan.mockImplementation(() =>
        (async function* () {
          yield createMockState({ status: "completed" });
        })(),
      );

      vi.useFakeTimers();

      const { result } = renderHook(() => useConsolidationExecution({ state: mockState }));

      await act(async () => {
        result.current.executeOrResume();
      });
      // Let the generator drain.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(result.current.isExecuting).toBe(false);
      mockRefreshPendingSteps.mockClear();

      // Even after several minutes, no more refresh ticks.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(120_000);
      });
      expect(mockRefreshPendingSteps).not.toHaveBeenCalled();

      vi.useRealTimers();
    });

    test("commits a refreshed snapshot via setState + saveConsolidation when refreshPendingSteps returns a NEW state object", async () => {
      const mockState = createMockState();
      const refreshedState = createMockState({ status: "executing", updatedAt: 99999999 });

      mockExecuteConsolidationPlan.mockImplementation(() =>
        (async function* () {
          yield createMockState({ status: "executing" });
          await new Promise(() => {});
        })(),
      );
      mockRefreshPendingSteps.mockResolvedValueOnce(refreshedState);

      vi.useFakeTimers();
      const { result, unmount } = renderHook(() => useConsolidationExecution({ state: mockState }));

      await act(async () => {
        result.current.executeOrResume();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });

      expect(result.current.state?.updatedAt).toBe(99999999);
      // Persisted at least once with the refreshed snapshot.
      const persistedUpdatedAts = mockSaveConsolidation.mock.calls.map(
        (args) => (args[0] as ConsolidationState).updatedAt,
      );
      expect(persistedUpdatedAts).toContain(99999999);

      unmount();
      vi.useRealTimers();
    });

    test("does NOT commit when refreshPendingSteps returns the SAME state object (referential noop)", async () => {
      const mockState = createMockState();

      mockExecuteConsolidationPlan.mockImplementation(() =>
        (async function* () {
          yield createMockState({ status: "executing" });
          await new Promise(() => {});
        })(),
      );
      // Default mock returns the snapshot reference unchanged: hook should
      // skip setState/saveConsolidation entirely.

      vi.useFakeTimers();
      const { result, unmount } = renderHook(() => useConsolidationExecution({ state: mockState }));

      await act(async () => {
        result.current.executeOrResume();
      });
      // Let the generator's first yield + the hook's setInterval setup run.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      const savesBefore = mockSaveConsolidation.mock.calls.length;

      // Trigger the 30s tick (refresh-tick is no-op against this default).
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });

      expect(mockRefreshPendingSteps).toHaveBeenCalled();
      expect(mockSaveConsolidation.mock.calls.length).toBe(savesBefore);

      unmount();
      vi.useRealTimers();
    });
  });
});
