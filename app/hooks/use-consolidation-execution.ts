import { useCallback, useEffect, useRef, useState } from "react";
import type { Account, Address, Chain, Hex, HttpTransport, WalletClient } from "viem";
import { useWalletClient } from "wagmi";
import {
  executeConsolidationPlan,
  refreshPendingSteps,
  type StepHashSentInfo,
  type StepStallInfo,
} from "~/lib/execution";
import type { StallKind } from "~/lib/send-calls";
import type { ConsolidationState, TransactionStep } from "~/lib/types";
import { useConsolidationRecords } from "./use-consolidation-records";

interface UseConsolidationExecutionOptions {
  state: ConsolidationState | null;
  onComplete?: (state: ConsolidationState) => void;
}

/**
 * Per-step handles exposed to the UI when a transaction has stalled and
 * a unified Resend / Retry CTA is available. The `kind` discriminator tells
 * the UI which label / icon / tooltip to render; clicking the button calls
 * `trigger`. Cleared as soon as the step completes (success/fail) or
 * another step starts executing.
 */
export type StalledSteps = Record<string, { kind: StallKind; trigger: () => void }>;

/** Interval between background re-prep ticks of pending downstream steps. */
const REFRESH_TICK_MS = 30_000;

/** Per-step in-flight tx audit info, mirrors `TransactionStep.pendingTx`. */
type PendingTxRecord = {
  account: Address;
  nonce?: number;
  hashes: Hex[];
};

/**
 * Merge a `pendingTx` audit entry into the matching step in `state.plan`.
 * Returns a shallow-cloned state with only the affected step replaced
 * (cheap to do on every callback; React diffing handles the rest).
 */
function applyPendingTx(state: ConsolidationState, stepId: string, pendingTx: PendingTxRecord): ConsolidationState {
  const idx = state.plan.findIndex((s) => s.id === stepId);
  if (idx === -1) return state;
  const updated: TransactionStep = { ...state.plan[idx], pendingTx };
  const plan = [...state.plan];
  plan[idx] = updated;
  return { ...state, plan, updatedAt: Date.now() };
}

/**
 * Merge every entry from `pendingTxs` into the corresponding plan steps.
 * Used after the generator yields a state (which doesn't know about the
 * in-flight ref) so the persisted/displayed state retains the full attempt
 * history even after the step transitions to success/failed.
 */
function mergePendingTxs(state: ConsolidationState, pendingTxs: Record<string, PendingTxRecord>): ConsolidationState {
  let next = state;
  let mutated = false;
  for (const stepId of Object.keys(pendingTxs)) {
    const record = pendingTxs[stepId];
    const idx = next.plan.findIndex((s) => s.id === stepId);
    if (idx === -1) continue;
    const existing = next.plan[idx].pendingTx;
    // Skip merge when the yielded state already has identical hashes for this
    // step (avoids redundant clones during quick generator passes).
    if (existing && existing.hashes.length === record.hashes.length) continue;
    if (!mutated) {
      next = { ...next, plan: [...next.plan] };
      mutated = true;
    }
    next.plan[idx] = { ...next.plan[idx], pendingTx: record };
  }
  return next;
}

export function useConsolidationExecution({ state: initialState, onComplete }: UseConsolidationExecutionOptions) {
  const [state, setState] = useState<ConsolidationState | null>(initialState);
  const [isExecuting, setIsExecuting] = useState(false);
  const [stalledSteps, setStalledSteps] = useState<StalledSteps>({});
  // Mirror of stalledSteps for synchronous reads inside callbacks. React's
  // setState is async, and triggerStallAction needs the latest handle
  // without going through a re-render cycle.
  const stalledRef = useRef<StalledSteps>({});
  // In-memory per-step pending-tx audit info. Populated by `handleStepHashSent`
  // on each broadcast (original + resends). Merged into yielded states so the
  // persisted plan always reflects the full attempt history.
  const pendingTxRef = useRef<Record<string, PendingTxRecord>>({});
  // Mirror of `state` for synchronous reads from the background refresh
  // tick and the generator's `getLatestStateRef` accessor. Both writers
  // (the generator's per-step yields and the refresh tick) keep this in
  // lock-step with React state via setState.
  const latestStateRef = useRef<ConsolidationState | null>(initialState);
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
      if (initialState === null) {
        latestStateRef.current = null;
        return null;
      }
      // Different ID: always accept the new state
      if (prev?.id !== initialState.id) {
        latestStateRef.current = initialState;
        return initialState;
      }
      // Never overwrite a non-ready state (executing, paused, completed, partial)
      if (prev.status !== "ready") return prev;
      // Same ID, both ready: only accept if the incoming state is newer
      if (prev.updatedAt >= initialState.updatedAt) return prev;
      latestStateRef.current = initialState;
      return initialState;
    });
  }, [initialState]);

  // Helper: clear the stalled record for a step. Called when a step finishes
  // (success or failure) and on unmount so we never leak stale resend handles.
  const clearStall = useCallback((stepId: string) => {
    if (!stalledRef.current[stepId]) return;
    const { [stepId]: _removed, ...rest } = stalledRef.current;
    stalledRef.current = rest;
    setStalledSteps(rest);
  }, []);

  // On stall, store the unified `{ kind, trigger }` handle so the UI can
  // render a single dynamic CTA whose label depends on `kind`. We replace
  // any prior handle for the same stepId — the latest one wins (subsequent
  // stalls would only happen after a replacement, but we err on the side
  // of always pointing at the freshest trigger).
  //
  // Gating: only expose the CTA when we know the explicit nonce. Without
  // one, a "resend" would create a parallel tx instead of replacing the
  // original, so we drop into the existing receipt-timeout path instead.
  const handleStepStall = useCallback((info: StepStallInfo) => {
    if (info.nonce === undefined) {
      console.warn(`[useConsolidationExecution] Stall reported for step ${info.stepId} without a nonce; skipping CTA.`);
      return;
    }
    const next = {
      ...stalledRef.current,
      [info.stepId]: { kind: info.kind, trigger: info.trigger },
    };
    stalledRef.current = next;
    setStalledSteps(next);
  }, []);

  // Append a freshly-broadcast hash to the per-step audit record and persist
  // synchronously so a tab close right after a wallet confirmation still
  // leaves us with the hash on disk.
  const handleStepHashSent = useCallback(
    (info: StepHashSentInfo) => {
      const prevRecord = pendingTxRef.current[info.stepId];
      const record: PendingTxRecord = prevRecord
        ? { ...prevRecord, hashes: [...prevRecord.hashes, info.hash] }
        : { account: info.account, nonce: info.nonce, hashes: [info.hash] };
      pendingTxRef.current = { ...pendingTxRef.current, [info.stepId]: record };

      setState((prev) => {
        if (!prev) return prev;
        const merged = applyPendingTx(prev, info.stepId, record);
        // Persist immediately; we MUST NOT wait for the next yield because
        // the user could close the tab in the gap between broadcast and
        // receipt.
        saveConsolidation(merged);
        latestStateRef.current = merged;
        return merged;
      });
    },
    [saveConsolidation],
  );

  // Core execution helper
  const runExecution = useCallback(
    async (nextState: ConsolidationState) => {
      if (!walletClient) return;

      setIsExecuting(true);
      // Reset stall + pending-tx state at the start of every execution run.
      stalledRef.current = {};
      setStalledSteps({});
      pendingTxRef.current = {};
      latestStateRef.current = nextState;

      // Background refresh tick. Re-quotes pending downstream steps every
      // REFRESH_TICK_MS so when an upstream long-running step (e.g. CCTP
      // attestation wait) finishes, the next step's calldata is already
      // fresh — the user signs against an up-to-date quote.
      //
      // Concurrency contract: this tick MUST NOT touch fields the
      // generator owns mid-step (`status`, `currentStepIndex`, `results`,
      // the executing step's `inputTokens`/`pendingTx`). `refreshPendingSteps`
      // only ever rewrites pending downstream steps' `outputToken` /
      // `quotedAt` plus its `recalculatePlan` cascade.
      let refreshing = false;
      const refreshTick = async () => {
        if (refreshing) return; // skip if a previous tick is still mid-await
        const snapshot = latestStateRef.current;
        if (!snapshot || snapshot.status !== "executing") return;
        refreshing = true;
        try {
          const refreshed = await refreshPendingSteps(snapshot);
          if (refreshed === snapshot) return;
          // Only commit if the executor hasn't started a new run since.
          if (latestStateRef.current?.id !== snapshot.id) return;
          latestStateRef.current = refreshed;
          setState(refreshed);
          saveConsolidation(refreshed);
        } catch (err) {
          console.warn("[useConsolidationExecution] proactive refresh failed", err);
        } finally {
          refreshing = false;
        }
      };
      const refreshIntervalId: ReturnType<typeof setInterval> = setInterval(refreshTick, REFRESH_TICK_MS);

      try {
        // Consume the generator, updating UI and persisting on each yield
        const generator = executeConsolidationPlan(
          nextState,
          walletClient as WalletClient<HttpTransport, Chain, Account>,
          {
            onStepStall: handleStepStall,
            onStepHashSent: handleStepHashSent,
            getLatestStateRef: () => latestStateRef.current,
          },
        );

        let finalState: ConsolidationState = nextState;
        let prevExecutingStepId: string | undefined;

        for await (const updatedState of generator) {
          // Merge in any pending-tx records the callback gathered between
          // yields so the yielded snapshot retains the full attempt history.
          const merged = mergePendingTxs(updatedState, pendingTxRef.current);

          setState(merged);
          saveConsolidation(merged);
          latestStateRef.current = merged;

          // Whenever the executor moves on (status changed away from
          // "executing", or a different step is now executing), drop the
          // previous step's stall handle. This avoids showing a Resend CTA
          // on a step that already finished.
          const currentExecuting = merged.plan.find((s) => s.status === "executing");
          if (prevExecutingStepId && currentExecuting?.id !== prevExecutingStepId) {
            clearStall(prevExecutingStepId);
          }
          prevExecutingStepId = currentExecuting?.id;

          finalState = merged;
        }

        if (finalState.status === "completed" || finalState.status === "partial" || finalState.status === "paused") {
          onComplete?.(finalState);
        }
      } catch (err) {
        console.error("Execution error:", err);
      } finally {
        clearInterval(refreshIntervalId);
        // Generator finished or threw: clear any lingering stall state.
        // Note: we intentionally keep `pendingTxRef` in lock-step with the
        // already-persisted state; clearing it here would not erase the
        // pendingTx fields baked into the saved consolidation, which is
        // exactly the audit trail we want to preserve.
        stalledRef.current = {};
        setStalledSteps({});
        pendingTxRef.current = {};
        setIsExecuting(false);
      }
    },
    [walletClient, saveConsolidation, onComplete, handleStepStall, handleStepHashSent, clearStall],
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

  /**
   * Fire the unified Resend / Retry action for a stalled step. The lib
   * decides which actually runs based on `kind`. No-op when no stall
   * handle is active for `stepId` (step already finished or a previous
   * trigger already fired).
   */
  const triggerStallAction = useCallback((stepId: string) => {
    const handle = stalledRef.current[stepId];
    if (!handle) return;
    handle.trigger();
    // Optimistically clear so the UI hides the CTA immediately; a fresh
    // stall will rearm it if the replacement itself stalls again.
    const { [stepId]: _removed, ...rest } = stalledRef.current;
    stalledRef.current = rest;
    setStalledSteps(rest);
  }, []);

  // Unmount cleanup: drop any stall handles so closures captured by setTimeout
  // callbacks in the executor don't keep updating React state on a dead hook.
  useEffect(() => {
    return () => {
      stalledRef.current = {};
      pendingTxRef.current = {};
    };
  }, []);

  return {
    state,
    isExecuting,
    executeOrResume,
    retryFailedStep,
    skipFailedStep,
    stalledSteps,
    triggerStallAction,
  };
}
