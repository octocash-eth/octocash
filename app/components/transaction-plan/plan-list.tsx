import type { ConsolidationState } from "~/lib/types";
import { PlanCard } from "./plan-card";

interface PlanListProps {
  state: ConsolidationState;
  maxHeight?: string;
}

export function PlanList({ state, maxHeight = "400px" }: PlanListProps) {
  return (
    <div className="overflow-y-auto space-y-3 pr-2" style={{ maxHeight }}>
      {state.plan.map((step, index) => {
        const result = state.results[step.id];
        return <PlanCard key={step.id} step={step} result={result} stepNumber={index + 1} />;
      })}
    </div>
  );
}
