import { AlertCircle, CheckCircle2, ShieldCheck } from "lucide-react";
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
  const didShield = state.plan.some((step) => step.type === "shield" && step.status === "success");

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

      {/* PPOI screening notice for shielded funds */}
      {didShield && (
        <Alert>
          <ShieldCheck className="h-4 w-4" />
          <AlertTitle>Privacy screening in progress</AlertTitle>
          <AlertDescription>
            Shielded funds go through Railgun's Private Proof of Innocence screening, which takes about 1 hour. Until it
            completes, they may show as pending in your Railgun wallet and can't be spent privately.
          </AlertDescription>
        </Alert>
      )}

      {/* Close Button */}
      <div className="pt-4">
        <Button onClick={onClose} className="w-full">
          Close
        </Button>
      </div>
    </div>
  );
}
