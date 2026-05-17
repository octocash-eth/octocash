import * as React from "react";
import { useConsolidationExecution } from "~/hooks/use-consolidation-execution";
import { useConsolidationPlanning } from "~/hooks/use-consolidation-planning";
import { createTransactionError } from "~/lib/errors";
import { ERROR_CODES } from "~/lib/types";
import { ExecutionActions } from "./actions/execution-actions";
import { PausedActions } from "./actions/paused-actions";
import { ExecutionStatusAlert } from "./execution-status-alert";
import { PlanError } from "./loading-states/plan-error";
import { PlanningLoader } from "./loading-states/planning-loader";
import { PlanList } from "./plan-list";
import type { ExecutorProps } from "./types";

/**
 * TransactionPlanExecutor - Creates a NEW consolidation plan and executes it
 * Use this when you have sourceTokens and destinationToken and want to generate + execute a plan
 */
export function TransactionPlanExecutor({
  sourceTokens,
  destinationToken,
  onComplete,
  onBack,
  showActions = false,
  planId,
  onExecutionStateChange,
}: ExecutorProps) {
  // Step 1: Generate the plan
  const {
    state: plannedState,
    isPlanning,
    planError,
    generatePlan,
    attemptCount,
  } = useConsolidationPlanning({
    sourceTokens,
    destinationToken,
    planId,
  });

  // Step 2: Execute the plan
  const { state, isExecuting, executeOrResume, retryFailedStep, skipFailedStep, liveProgress } =
    useConsolidationExecution({
      state: plannedState,
      onComplete,
    });

  // Notify parent when execution state changes
  React.useEffect(() => {
    onExecutionStateChange?.(isExecuting);
  }, [isExecuting, onExecutionStateChange]);

  // Show loading state while planning
  if (isPlanning) {
    return <PlanningLoader />;
  }

  // Show error if planning failed. Auto-retry only for transient external API
  // failures (Odos 5xx) — other errors render statically so we never loop on
  // unrecoverable conditions like UnsupportedRouteError.
  if (planError) {
    const classified = createTransactionError(new Error(planError));
    const autoRetry = classified.code === ERROR_CODES.EXTERNAL_API_ERROR;
    return <PlanError error={planError} onRetry={generatePlan} autoRetry={autoRetry} attemptNumber={attemptCount} />;
  }

  // Wait for state to be ready
  if (!state) {
    return null;
  }

  const isPaused = state.status === "paused";
  const isCompleted = state.status === "completed";
  const showStatusAlert = isCompleted || state.status === "partial" || isPaused;

  return (
    <div className="space-y-4">
      {/* Transaction Cards Preview */}
      <PlanList state={state} liveProgress={liveProgress} />

      {/* Execution Status Alerts */}
      {showStatusAlert && (
        <ExecutionStatusAlert status={state.status} error={state.plan[state.currentStepIndex]?.error} />
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
