import type { LiveProgress } from "~/hooks/use-consolidation-execution";
import type { ConsolidationState } from "~/lib/types";
import { cn } from "~/lib/utils";
import { PlanCard } from "./plan-card";

interface PlanListProps {
  state: ConsolidationState;
  maxHeight?: string;
  /** Transient, step-type-agnostic wait feedback keyed by step id (display-only). */
  liveProgress?: LiveProgress;
  /** Extra classes for the scroll container (e.g. flex sizing inside a constrained parent). */
  className?: string;
}

export function PlanList({
  state,
  maxHeight = "min(25rem, calc(100dvh - 19rem))",
  liveProgress,
  className,
}: PlanListProps) {
  return (
    <div className={cn("overflow-y-auto space-y-3 pr-2", className)} style={{ maxHeight }}>
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
