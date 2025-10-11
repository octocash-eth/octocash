import { AlertCircle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";

interface PlanErrorProps {
  error: string;
}

export function PlanError({ error }: PlanErrorProps) {
  return (
    <Alert variant="destructive">
      <AlertCircle className="h-4 w-4" />
      <AlertTitle>Planning Error</AlertTitle>
      <AlertDescription>{error}</AlertDescription>
    </Alert>
  );
}
