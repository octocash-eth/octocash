/**
 * Structured progress reporting for the planning pipeline — the planning-side
 * sibling of step-progress.ts (which phrases execution-side stage lines).
 * `planConsolidation` emits a coarse phase as it enters each network-bound
 * stage; the confirm-plan loader renders it as a single live status line.
 */

export type PlanningPhase =
  | "gas-data"
  | "wallets"
  | "swap-quotes"
  | "bridge-fees"
  | "final-swaps"
  | "gas-estimation"
  | "gas-topups";

export type OnPlanningProgress = (phase: PlanningPhase) => void;

const PHASE_LABELS: Record<PlanningPhase, string> = {
  "gas-data": "Fetching gas prices",
  wallets: "Checking wallet balances",
  "swap-quotes": "Fetching swap quotes",
  "bridge-fees": "Calculating bridge fees",
  "final-swaps": "Quoting destination swaps",
  "gas-estimation": "Simulating transactions",
  "gas-topups": "Planning gas top-ups",
};

/** Single status line for the confirm-plan loader. */
export function planningStageMessage(phase?: PlanningPhase | null): string {
  if (!phase) return "Preparing your plan…";
  return `${PHASE_LABELS[phase]}…`;
}
