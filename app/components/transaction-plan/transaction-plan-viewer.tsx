import { useConsolidationExecution } from "~/hooks/use-consolidation-execution";
import { ExecutionActions } from "./actions/execution-actions";
import { PausedActions } from "./actions/paused-actions";
import { ExecutionStatusAlert } from "./execution-status-alert";
import { PlanList } from "./plan-list";
import type { ViewerProps } from "./types";

/**
 * TransactionPlanViewer - Displays an EXISTING consolidation plan with optional execution controls
 * Use this when you already have a ConsolidationState (e.g., from history/recovery)
 */
export function TransactionPlanViewer({ state: initialState, onComplete, onBack, showActions = false }: ViewerProps) {
  const { state, isExecuting, executeOrResume, retryFailedStep, skipFailedStep, liveProgress, gasArrivedChainIds } =
    useConsolidationExecution({
      state: initialState,
      onComplete,
    });

  // Use the state from the hook, fallback to initial state
  const currentState = state || initialState;

  const isPaused = currentState.status === "paused";
  const isCompleted = currentState.status === "completed";
  const showStatusAlert = isCompleted || currentState.status === "partial" || isPaused;

  return (
    <div className="space-y-4">
      {/* Transaction Cards Preview */}
      <PlanList state={currentState} liveProgress={liveProgress} gasArrivedChainIds={gasArrivedChainIds} />

      {/* Execution Status Alerts */}
      {showStatusAlert && (
        <ExecutionStatusAlert
          status={currentState.status}
          error={currentState.plan[currentState.currentStepIndex]?.error}
        />
      )}

      {/* Action Buttons */}
      {showActions && (
        <div className="pt-4 flex gap-2">
          {isPaused ? (
            <PausedActions onSkip={skipFailedStep} onRetry={retryFailedStep} disabled={isExecuting} />
          ) : (
            <ExecutionActions
              onBack={onBack}
              onExecute={executeOrResume}
              isExecuting={isExecuting}
              isCompleted={isCompleted}
            />
          )}
        </div>
      )}
    </div>
  );
}
