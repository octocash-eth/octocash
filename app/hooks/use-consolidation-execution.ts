import { useCallback, useEffect, useState } from "react";
import type { Account, Address, Chain, HttpTransport, WalletClient } from "viem";
import { useWalletClient } from "wagmi";
import { chains } from "~/data/supported-chains";
import { executeConsolidationPlan, type LiFiProgressEvent } from "~/lib/execution";
import { getNativeBalance } from "~/lib/gas";
import type { LiFiStatusResponse } from "~/lib/lifi";
import type { ConsolidationState } from "~/lib/types";
import { useConsolidationRecords } from "./use-consolidation-records";

/** Per-transfer LI.FI status, keyed by source-chain tx hash. Display-only. */
export interface StepLiveProgress {
  /** When the gas-topup-wait step entered `executing` (drives the elapsed timer). */
  startedAt: number;
  transfers: Record<string, { toChainId: number; status: LiFiStatusResponse }>;
}

/** Transient, non-persisted execution feedback keyed by step id. */
export type LiveProgress = Record<string, StepLiveProgress>;

interface UseConsolidationExecutionOptions {
  state: ConsolidationState | null;
  onComplete?: (state: ConsolidationState) => void;
}

export function useConsolidationExecution({ state: initialState, onComplete }: UseConsolidationExecutionOptions) {
  const [state, setState] = useState<ConsolidationState | null>(initialState);
  const [isExecuting, setIsExecuting] = useState(false);
  // Transient bridge feedback. Deliberately NOT part of ConsolidationState:
  // it churns on every poll and must never hit saveConsolidation/localStorage.
  const [liveProgress, setLiveProgress] = useState<LiveProgress>({});
  const [gasArrivedChainIds, setGasArrivedChainIds] = useState<Set<number>>(new Set());
  const { data: walletClient } = useWalletClient();
  const { saveConsolidation } = useConsolidationRecords();

  // LI.FI per-poll status, fed from executeStep's gas-topup-wait poll via the
  // ExecuteOptions side-channel (the generator can't yield mid-step).
  const handleLiFiProgress = useCallback((e: LiFiProgressEvent) => {
    setLiveProgress((prev) => {
      const entry = prev[e.stepId] ?? { startedAt: Date.now(), transfers: {} };
      return {
        ...prev,
        [e.stepId]: {
          ...entry,
          transfers: { ...entry.transfers, [e.txHash]: { toChainId: e.toChainId, status: e.status } },
        },
      };
    });
  }, []);

  // Seed startedAt the moment a gas-topup-wait step starts executing (so the
  // timer counts the pre-first-poll seconds too); drop a step's entry once it
  // is no longer executing so the sub-line disappears on success/failure.
  const syncProgressForState = useCallback((s: ConsolidationState) => {
    setLiveProgress((prev) => {
      const active = new Set(
        s.plan.filter((st) => st.type === "gas-topup-wait" && st.status === "executing").map((st) => st.id),
      );
      let changed = false;
      const next: LiveProgress = { ...prev };
      for (const id of active) {
        if (!next[id]) {
          next[id] = { startedAt: Date.now(), transfers: {} };
          changed = true;
        }
      }
      for (const id of Object.keys(next)) {
        if (!active.has(id)) {
          delete next[id];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, []);

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
          { onLiFiProgress: handleLiFiProgress },
        );

        let finalState: ConsolidationState = nextState;

        for await (const updatedState of generator) {
          // Update UI immediately
          setState(updatedState);
          // Seed/clear the elapsed timer as gas-topup-wait steps start/finish
          syncProgressForState(updatedState);

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
    [walletClient, saveConsolidation, onComplete, handleLiFiProgress, syncProgressForState],
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

      // Preserve `retryHints` (carried on the failed step) through the spread
      // so the next execution attempt replaces the pending tx at the same
      // nonce with a doubled bid. Cleared on success in execution.ts.
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

  // Independent on-chain "gas arrived" safety net: while a gas-topup-wait step
  // is executing, poll each destination's native balance. The LI.FI poll
  // resolving stays the source of truth for step completion — this only flips
  // the displayed copy early when funds visibly land before LI.FI reports DONE.
  // destKey encodes the watched destinations so the effect is self-contained
  // (re-runs only when the active step's destinations change).
  const activeWaitStep =
    state?.status === "executing"
      ? state.plan.find((s) => s.type === "gas-topup-wait" && s.status === "executing")
      : undefined;
  const destKey = (activeWaitStep?.gasTopUpDestinations ?? [])
    .map((d) => `${d.chainId}:${d.address}`)
    .sort()
    .join("|");

  useEffect(() => {
    setGasArrivedChainIds(new Set());
    if (!destKey) return;

    const dests = destKey.split("|").map((s) => {
      const [c, a] = s.split(":");
      return { chainId: Number(c), address: a as Address };
    });

    let cancelled = false;
    const baseline = new Map<string, bigint>();

    const tick = async () => {
      await Promise.all(
        dests.map(async ({ chainId, address }) => {
          const chain = chains[chainId as keyof typeof chains];
          if (!chain) return;
          try {
            const balance = await getNativeBalance(chain as Chain, address);
            if (cancelled) return;
            const k = `${chainId}:${address}`;
            if (!baseline.has(k)) {
              baseline.set(k, balance);
              return;
            }
            if (balance > (baseline.get(k) ?? 0n)) {
              setGasArrivedChainIds((prev) => (prev.has(chainId) ? prev : new Set(prev).add(chainId)));
            }
          } catch {
            // Transient RPC error — ignore and retry on the next tick.
          }
        }),
      );
    };

    void tick();
    const id = setInterval(() => void tick(), 5_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [destKey]);

  return {
    state,
    isExecuting,
    executeOrResume,
    retryFailedStep,
    skipFailedStep,
    liveProgress,
    gasArrivedChainIds,
  };
}
