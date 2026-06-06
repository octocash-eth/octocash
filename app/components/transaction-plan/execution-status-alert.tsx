import { AlertCircle, CheckCircle2 } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { ScrollArea } from "~/components/ui/scroll-area";
import type { TransactionError } from "~/lib/types";
import type { ConsolidationStatusType } from "./types";

interface ExecutionStatusAlertProps {
  status: ConsolidationStatusType;
  error?: TransactionError;
}

export function ExecutionStatusAlert({ status, error }: ExecutionStatusAlertProps) {
  if (status === "completed") {
    return (
      <Alert>
        <CheckCircle2 className="h-4 w-4" />
        <AlertTitle>Success!</AlertTitle>
        <AlertDescription>All transactions completed successfully</AlertDescription>
      </Alert>
    );
  }

  if (status === "partial") {
    return (
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertTitle>Partially Completed</AlertTitle>
        <AlertDescription>Some transactions failed or were skipped</AlertDescription>
      </Alert>
    );
  }

  if (status === "paused") {
    return (
      <Alert>
        <AlertCircle className="h-4 w-4" />
        <AlertTitle>{error?.title || "A transaction failed."}</AlertTitle>
        <AlertDescription>
          <ScrollArea className="max-h-[300px] w-full">
            <p className="whitespace-pre-wrap wrap-break-word pr-3">
              {error?.message || "You can retry it or skip and continue with remaining steps."}
            </p>
          </ScrollArea>
        </AlertDescription>
      </Alert>
    );
  }

  return null;
}
