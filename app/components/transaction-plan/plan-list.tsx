import type { LiveProgress } from "~/hooks/use-consolidation-execution";
import type { ConsolidationState } from "~/lib/types";
import { PlanCard } from "./plan-card";

interface PlanListProps {
  state: ConsolidationState;
  maxHeight?: string;
  /** Transient, step-type-agnostic wait feedback keyed by step id (display-only). */
  liveProgress?: LiveProgress;
}

export function PlanList({ state, maxHeight = "min(25rem, calc(100dvh - 19rem))", liveProgress }: PlanListProps) {
  return (
    <div className="overflow-y-auto space-y-3 pr-2" style={{ maxHeight }}>
      {state.plan.map((step, index) => {
        const result = state.results[step.id];
        return (
          <PlanCard
            key={step.id}
            step={step}
            result={result}
            stepNumber={index + 1}
            progress={liveProgress?.[step.id]}
          />
        );
      })}
    </div>
  );
}
