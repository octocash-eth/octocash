import type { LiveProgress } from "~/hooks/use-consolidation-execution";
import type { ConsolidationState } from "~/lib/types";
import { PlanCard } from "./plan-card";

interface PlanListProps {
  state: ConsolidationState;
  maxHeight?: string;
  /** Transient LI.FI bridge feedback keyed by step id (display-only). */
  liveProgress?: LiveProgress;
  /** Destination chains where native gas has been observed to land. */
  gasArrivedChainIds?: Set<number>;
}

export function PlanList({ state, maxHeight = "400px", liveProgress, gasArrivedChainIds }: PlanListProps) {
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
            gasArrivedChainIds={gasArrivedChainIds}
          />
        );
      })}
    </div>
  );
}
