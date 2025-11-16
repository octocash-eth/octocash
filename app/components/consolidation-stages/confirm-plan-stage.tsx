import type { ConsolidationState, DestinationToken, SourceToken } from "~/lib/types";
import { TransactionPlanExecutor } from "../transaction-plan";

interface ConfirmPlanStageProps {
  planId: string;
  sourceTokens: SourceToken[];
  destinationToken: DestinationToken;
  onComplete: (state: ConsolidationState) => void;
  onBack: () => void;
  onExecutionStateChange?: (isExecuting: boolean) => void;
}

export function ConfirmPlanStage({
  planId,
  sourceTokens,
  destinationToken,
  onComplete,
  onBack,
  onExecutionStateChange,
}: ConfirmPlanStageProps) {
  return (
    <div className="space-y-4">
      <div className="text-sm text-muted-foreground mb-4">
        Review the transaction steps below and execute the consolidation plan.
      </div>

      <TransactionPlanExecutor
        key={planId}
        planId={planId}
        sourceTokens={sourceTokens}
        destinationToken={destinationToken}
        onComplete={onComplete}
        onBack={onBack}
        showActions={true}
        onExecutionStateChange={onExecutionStateChange}
      />
    </div>
  );
}
