import { ScrollArea } from "~/components/ui/scroll-area";
import type { LiveProgress } from "~/hooks/use-consolidation-execution";
import type { ConsolidationState } from "~/lib/types";
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
    <ScrollArea className={className} style={{ maxHeight }}>
      <div className="space-y-3 pr-2">
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
    </ScrollArea>
  );
}
