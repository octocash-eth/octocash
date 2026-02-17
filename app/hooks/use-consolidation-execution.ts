import { useCallback, useEffect, useState } from "react";
import type { Account, Chain, HttpTransport, WalletClient } from "viem";
import { useWalletClient } from "wagmi";
import { executeConsolidationPlan } from "~/lib/execution";
import type { ConsolidationState } from "~/lib/types";
import { useConsolidationRecords } from "./use-consolidation-records";

interface UseConsolidationExecutionOptions {
  state: ConsolidationState | null;
  onComplete?: (state: ConsolidationState) => void;
}

export function useConsolidationExecution({ state: initialState, onComplete }: UseConsolidationExecutionOptions) {
  const [state, setState] = useState<ConsolidationState | null>(initialState);
  const [isExecuting, setIsExecuting] = useState(false);
  const { data: walletClient } = useWalletClient();
  const { saveConsolidation } = useConsolidationRecords();

  // Sync incoming state from planning hook.
  // Guards against overwriting execution/terminal states: once execution
  // has started (status !== "ready"), only a new plan (different ID) can
  // replace the current state. This prevents a referentially-new but
  // logically-identical planning memo from resetting progress mid-execution.
  useEffect(() => {
    setState((prev) => {
      // No initial state: reset
      if (initialState === null) return null;
      // Different ID: always accept the new state
      if (prev?.id !== initialState.id) return initialState;
      // Never overwrite a non-ready state (executing, paused, completed, partial)
      if (prev.status !== "ready") return prev;
      // Same ID, both ready: only accept if the incoming state is newer
      if (prev.updatedAt >= initialState.updatedAt) return prev;
      return initialState;
    });
  }, [initialState]);

  // Core execution helper
  const runExecution = useCallback(
    async (nextState: ConsolidationState) => {
      if (!walletClient) return;

      setIsExecuting(true);
      try {
        // Consume the generator, updating UI and persisting on each yield
        const generator = executeConsolidationPlan(
          nextState,
          walletClient as WalletClient<HttpTransport, Chain, Account>,
        );

        let finalState: ConsolidationState = nextState;

        for await (const updatedState of generator) {
          // Update UI immediately
          setState(updatedState);

          // Persist to storage
          saveConsolidation(updatedState);

          finalState = updatedState;
        }

        if (finalState.status === "completed" || finalState.status === "partial" || finalState.status === "paused") {
          onComplete?.(finalState);
        }
      } catch (err) {
        console.error("Execution error:", err);
      } finally {
        setIsExecuting(false);
      }
    },
    [walletClient, saveConsolidation, onComplete],
  );

  // Public actions
  const executeOrResume = useCallback(() => {
    if (!state || isExecuting) return;
    void runExecution(state);
  }, [state, isExecuting, runExecution]);

  const retryStep = useCallback(
    async (stepId: string) => {
      if (!state) return;

      const stepIndex = state.plan.findIndex((s) => s.id === stepId);
      const { [stepId]: _, ...remainingResults } = state.results;

      const newState: ConsolidationState = {
        ...state,
        plan: state.plan.map((s) => (s.id === stepId ? { ...s, status: "pending" as const, error: undefined } : s)),
        results: remainingResults,
        status: "ready",
        currentStepIndex: stepIndex !== -1 ? stepIndex : state.currentStepIndex,
        hasSubsequentExecution: false,
        updatedAt: Date.now(),
      };

      setState(newState);
      saveConsolidation(newState);
      await runExecution(newState);
    },
    [state, runExecution, saveConsolidation],
  );

  const skipStep = useCallback(
    async (stepId: string) => {
      if (!state) return;

      const step = state.plan.find((s) => s.id === stepId);
      if (!step) return;

      const stepIndex = state.plan.findIndex((s) => s.id === stepId);
      const newState: ConsolidationState = {
        ...state,
        plan: state.plan.map((s) => (s.id === stepId ? { ...s, status: "skipped" } : s)),
        results: {
          ...state.results,
          [stepId]: {
            stepId: step.id,
            chainId: step.chainId,
            status: "skipped",
            skipReason: "Skipped by user after failure",
          },
        },
        currentStepIndex: stepIndex !== -1 ? stepIndex + 1 : state.currentStepIndex,
        hasSubsequentExecution: true,
        status: "ready",
        updatedAt: Date.now(),
      };

      setState(newState);
      saveConsolidation(newState);
      await runExecution(newState);
    },
    [state, runExecution, saveConsolidation],
  );

  const retryFailedStep = useCallback(async () => {
    if (!state) return;
    const failed = [...state.plan].reverse().find((s) => s.status === "failed");
    if (failed) await retryStep(failed.id);
  }, [state, retryStep]);

  const skipFailedStep = useCallback(async () => {
    if (!state) return;
    const failed = [...state.plan].reverse().find((s) => s.status === "failed");
    if (failed) await skipStep(failed.id);
  }, [state, skipStep]);

  return {
    state,
    isExecuting,
    executeOrResume,
    retryFailedStep,
    skipFailedStep,
  };
}
