import { AlertCircle, CheckCircle2 } from "lucide-react";
import { ConsolidationTokensSummary } from "~/components/consolidation-tokens-summary";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import type { ConsolidationState } from "~/lib/types";

interface CompletionStageProps {
  state: ConsolidationState;
  onClose: () => void;
}

export function CompletionStage({ state, onClose }: CompletionStageProps) {
  const isSuccess = state.status === "completed";

  return (
    <div className="space-y-6">
      {/* Source & Final Tokens */}
      <ConsolidationTokensSummary state={state} />

      {/* Status Alert */}
      <Alert variant={isSuccess ? "default" : "destructive"}>
        {isSuccess ? <CheckCircle2 className="h-4 w-4" /> : <AlertCircle className="h-4 w-4" />}
        <AlertTitle>{isSuccess ? "Consolidation Successful!" : "Consolidation Partially Completed"}</AlertTitle>
        <AlertDescription>
          {isSuccess
            ? "All transactions completed successfully. Your tokens have been consolidated."
            : "Some transactions failed or were skipped. Your tokens were partially consolidated."}
        </AlertDescription>
      </Alert>

      {/* Close Button */}
      <div className="pt-4">
        <Button onClick={onClose} className="w-full">
          Close
        </Button>
      </div>
    </div>
  );
}
