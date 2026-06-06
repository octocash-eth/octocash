import { useCallback, useEffect, useRef, useState } from "react";
import type { Account, Address, Chain, HttpTransport, WalletClient } from "viem";
import { useWalletClient } from "wagmi";
import { chains } from "~/data/supported-chains";
import { executeConsolidationPlan, type StepProgressEvent } from "~/lib/execution";
import { getNativeBalance } from "~/lib/gas";
import type { LiFiStatusResponse } from "~/lib/lifi";
import { attestationStageMessage, chainNameOf, lifiStageMessage } from "~/lib/step-progress";
import type { ConsolidationState } from "~/lib/types";
import { useConsolidationRecords } from "./use-consolidation-records";

/**
 * Generic, step-type-agnostic feedback for an executing wait step. `PlanCard`
 * renders this as `{stage} · <timer> · {note}` without knowing the step type.
 */
export interface StepLiveProgress {
  /** When the wait step entered `executing` (drives the elapsed timer). */
  startedAt: number;
  /** Primary line, e.g. "Bridging to Base…" / "Attestations received 2/3". */
  stage: string;
  /** Optional secondary note, e.g. "Gas received on Base ✓". */
  note?: string;
}

/** Transient, non-persisted execution feedback keyed by step id. */
export type LiveProgress = Record<string, StepLiveProgress>;

/** Step types that have an observable wait we surface progress for. */
const WAIT_STEP_TYPES = new Set(["gas-topup-wait", "attestation"]);
const defaultStageFor = (type: string): string =>
  type === "attestation" ? "Waiting for Circle attestation…" : "Bridging…";

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
  const { data: walletClient } = useWalletClient();
  const { saveConsolidation } = useConsolidationRecords();

  // Raw LI.FI per-transfer status kept outside React state so successive polls
  // can recompute the aggregated stage without the structured data leaking into
  // the generic StepLiveProgress the UI consumes. Keyed stepId → txHash.
  const lifiTransfersRef = useRef<
    Record<string, Record<string, { fromChainId: number; toChainId: number; status: LiFiStatusResponse }>>
  >({});

  // Step progress fed from executeStep's awaited waits via the ExecuteOptions
  // side-channel (the generator can't yield mid-step). Maps each raw event to a
  // human-readable `stage` string; `startedAt`/`note` are preserved.
  const handleStepProgress = useCallback((e: StepProgressEvent) => {
    setLiveProgress((prev) => {
      const entry = prev[e.stepId] ?? { startedAt: Date.now(), stage: "" };
      let stage: string;
      if (e.kind === "lifi") {
        const byTx = { ...(lifiTransfersRef.current[e.stepId] ?? {}) };
        byTx[e.txHash] = { fromChainId: e.fromChainId, toChainId: e.toChainId, status: e.status };
        lifiTransfersRef.current[e.stepId] = byTx;
        stage = lifiStageMessage(Object.values(byTx));
      } else {
        stage = attestationStageMessage(e.received, e.total);
      }
      return { ...prev, [e.stepId]: { ...entry, stage } };
    });
  }, []);

  // Seed startedAt + a default stage the moment a wait step starts executing
  // (so the timer counts the pre-first-poll seconds too); drop a step's entry
  // once it is no longer executing so the sub-line disappears on
  // success/failure. Step-type-agnostic: covers gas-topup-wait, attestation,
  // and any future WAIT_STEP_TYPES member.
  const syncProgressForState = useCallback((s: ConsolidationState) => {
    setLiveProgress((prev) => {
      const activeType = new Map(
        s.plan
          .filter((st) => WAIT_STEP_TYPES.has(st.type) && st.status === "executing")
          .map((st) => [st.id, st.type] as const),
      );
      let changed = false;
      const next: LiveProgress = { ...prev };
      for (const [id, type] of activeType) {
        if (!next[id]) {
          next[id] = { startedAt: Date.now(), stage: defaultStageFor(type) };
          changed = true;
        }
      }
      for (const id of Object.keys(next)) {
        if (!activeType.has(id)) {
          delete next[id];
          delete lifiTransfersRef.current[id];
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
          { onStepProgress: handleStepProgress },
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
    [walletClient, saveConsolidation, onComplete, handleStepProgress, syncProgressForState],
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
        // Skip exactly one failed step: resume just after it. The executor
        // always pauses on the next failure, so we never run the remainder of
        // the plan unattended.
        currentStepIndex: stepIndex !== -1 ? stepIndex + 1 : state.currentStepIndex,
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
  // is executing, poll each destination's native balance and surface it as the
  // step's generic `note`. The LI.FI poll resolving stays the source of truth
  // for step completion — this only enriches the displayed copy early when
  // funds visibly land before LI.FI reports DONE. destKey + stepId key the
  // effect so it re-runs only when the active step / destinations change.
  const activeWaitStep =
    state?.status === "executing"
      ? state.plan.find((s) => s.type === "gas-topup-wait" && s.status === "executing")
      : undefined;
  const waitStepId = activeWaitStep?.id;
  const destKey = (activeWaitStep?.gasTopUpDestinations ?? [])
    .map((d) => `${d.chainId}:${d.address}`)
    .sort()
    .join("|");

  useEffect(() => {
    if (!destKey || !waitStepId) return;

    const dests = destKey.split("|").map((s) => {
      const [c, a] = s.split(":");
      return { chainId: Number(c), address: a as Address };
    });

    let cancelled = false;
    const baseline = new Map<string, bigint>();
    const arrived = new Set<number>();

    const tick = async () => {
      await Promise.all(
        dests.map(async ({ chainId, address }) => {
          const chain = chains[chainId as keyof typeof chains];
          if (!chain) return;
          try {
            const balance = await getNativeBalance(chain as Chain, address);
            if (cancelled || arrived.has(chainId)) return;
            const k = `${chainId}:${address}`;
            if (!baseline.has(k)) {
              baseline.set(k, balance);
              return;
            }
            if (balance > (baseline.get(k) ?? 0n)) {
              arrived.add(chainId);
              const note = `Gas received on ${[...arrived].map(chainNameOf).join(" + ")} ✓`;
              setLiveProgress((prev) =>
                prev[waitStepId] ? { ...prev, [waitStepId]: { ...prev[waitStepId], note } } : prev,
              );
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
  }, [destKey, waitStepId]);

  return {
    state,
    isExecuting,
    executeOrResume,
    retryFailedStep,
    skipFailedStep,
    liveProgress,
  };
}
