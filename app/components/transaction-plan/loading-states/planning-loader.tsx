import { Loader2 } from "lucide-react";

export function PlanningLoader() {
  return (
    // biome-ignore lint/a11y/useSemanticElements: role=status is used intentionally for accessibility
    <div className="flex items-center justify-center py-8" role="status" aria-label="Loading transaction plan">
      <Loader2 className="h-5 w-5 animate-spin" />
    </div>
  );
}
