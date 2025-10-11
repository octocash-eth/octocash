import { Loader2 } from "lucide-react";

export function PlanningLoader() {
  return (
    <output className="flex items-center justify-center py-8" aria-label="Loading transaction plan">
      <Loader2 className="h-5 w-5 animate-spin" />
    </output>
  );
}
