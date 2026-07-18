import { TriangleAlertIcon } from "lucide-react";
import * as React from "react";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
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
  accounts,
}: ExecutorProps) {
  // Step 1: Generate the plan
  const {
    state: plannedState,
    isPlanning,
    planningPhase,
    planError,
    planWarnings,
    generatePlan,
    attemptCount,
  } = useConsolidationPlanning({
    sourceTokens,
    destinationToken,
    planId,
    accounts,
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
    return <PlanningLoader phase={planningPhase} />;
  }

  // Show error if planning failed. Auto-retry only for transient external API
  // failures (Delora 5xx / network) — other errors render statically so we
  // never loop on unrecoverable conditions like UnsupportedRouteError or
  // Delora rate limiting (thrown as `RateLimitError:`, deliberately without
  // the `ExternalAPIError:` prefix, so retrying waits for the user).
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
    <div className="flex flex-col gap-3 sm:gap-4 min-h-0 max-h-[calc(100dvh-16rem)] sm:max-h-[calc(100dvh-21rem)]">
      {/* Non-fatal planning notes (e.g. Gnosis tokens dropped below the hop
          value floor): the plan is valid but covers less than was selected. */}
      {planWarnings.length > 0 && (
        <Alert className="shrink-0">
          <TriangleAlertIcon className="h-4 w-4" />
          <AlertTitle>Some tokens were left out</AlertTitle>
          <AlertDescription>
            {planWarnings.map((warning) => (
              <p key={warning}>{warning}</p>
            ))}
          </AlertDescription>
        </Alert>
      )}

      {/* Transaction Cards Preview — the only scrollable region; shrinks to keep
          the status alert and actions fixed and visible. */}
      <PlanList state={state} liveProgress={liveProgress} maxHeight="25rem" className="min-h-0" />

      {/* Execution Status Alerts */}
      {showStatusAlert && (
        <div className="shrink-0">
          <ExecutionStatusAlert status={state.status} error={state.plan[state.currentStepIndex]?.error} />
        </div>
      )}

      {/* Action Buttons */}
      {showActions && (
        <div className="shrink-0 pt-3 sm:pt-4 flex gap-2">
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
