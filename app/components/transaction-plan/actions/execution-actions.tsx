import { Loader2 } from "lucide-react";
import { Button } from "~/components/ui/button";

interface ExecutionActionsProps {
  onBack?: () => void;
  onExecute: () => void;
  isExecuting: boolean;
  isCompleted: boolean;
}

export function ExecutionActions({ onBack, onExecute, isExecuting, isCompleted }: ExecutionActionsProps) {
  return (
    <>
      <Button type="button" variant="outline" onClick={onBack} className="flex-1" disabled={isExecuting || isCompleted}>
        Back
      </Button>
      <Button type="button" onClick={onExecute} className="flex-1 py-5 text-base" disabled={isExecuting || isCompleted}>
        {isExecuting ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Executing...
          </>
        ) : isCompleted ? (
          "Completed"
        ) : (
          "Confirm & Execute"
        )}
      </Button>
    </>
  );
}
