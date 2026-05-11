import type { StalledSteps } from "~/hooks/use-consolidation-execution";
import type { ConsolidationState } from "~/lib/types";
import { PlanCard } from "./plan-card";

interface PlanListProps {
  state: ConsolidationState;
  maxHeight?: string;
  /**
   * Steps for which a stall recovery action is currently available. Each
   * entry carries the action `kind` (`"resend"` or `"retry"`) so the
   * `PlanCard` can render the matching unified CTA.
   */
  stalledSteps?: StalledSteps;
  /** Triggered when the user clicks the unified Resend / Retry CTA. */
  onTriggerStallAction?: (stepId: string) => void;
}

export function PlanList({ state, maxHeight = "400px", stalledSteps, onTriggerStallAction }: PlanListProps) {
  return (
    <div className="overflow-y-auto space-y-3 pr-2" style={{ maxHeight }}>
      {state.plan.map((step, index) => {
        const result = state.results[step.id];
        const stalled = stalledSteps?.[step.id];
        // Only forward stallKind + onStallAction when this specific step is
        // stalled; PlanCard uses both being defined as the "show CTA" signal.
        const onStallAction = stalled && onTriggerStallAction ? () => onTriggerStallAction(step.id) : undefined;
        return (
          <PlanCard
            key={step.id}
            step={step}
            result={result}
            stepNumber={index + 1}
            stallKind={stalled?.kind}
            onStallAction={onStallAction}
          />
        );
      })}
    </div>
  );
}
