import type { ConsolidationState, DestinationToken, SourceToken } from "~/lib/types";

export interface BaseTransactionPlanProps {
  onComplete?: (state: ConsolidationState) => void;
  onBack?: () => void;
  onExecutionStateChange?: (isExecuting: boolean) => void;
}

export interface ExecutorProps extends BaseTransactionPlanProps {
  planId: string;
  sourceTokens: SourceToken[];
  destinationToken: DestinationToken;
  showActions?: boolean;
}

export interface ViewerProps extends BaseTransactionPlanProps {
  state: ConsolidationState;
  showActions?: boolean;
}

export type ConsolidationStatusType = ConsolidationState["status"];
