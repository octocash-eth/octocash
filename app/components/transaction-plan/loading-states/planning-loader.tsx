import { Loader2 } from "lucide-react";
import { type PlanningPhase, planningStageMessage } from "~/lib/planning-progress";

export function PlanningLoader({ phase }: { phase?: PlanningPhase | null }) {
  return (
    <div
      className="flex items-center justify-center gap-2 py-8"
      role="status"
      aria-live="polite"
      aria-label="Loading transaction plan"
    >
      <Loader2 className="h-5 w-5 shrink-0 animate-spin" />
      <span className="text-muted-foreground text-xs sm:text-sm">{planningStageMessage(phase)}</span>
    </div>
  );
}
