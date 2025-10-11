import { Loader2 } from "lucide-react";

export function PlanningLoader() {
  return (
    <div className="flex items-center justify-center py-8">
      <Loader2 className="h-5 w-5 animate-spin" />
    </div>
  );
}
