import { Loader2 } from "lucide-react";
import { Button } from "~/components/ui/button";

interface PausedActionsProps {
  onSkip: () => void;
  onRetry: () => void;
  disabled: boolean;
}

export function PausedActions({ onSkip, onRetry, disabled }: PausedActionsProps) {
  return (
    <>
      <Button type="button" variant="outline" onClick={onSkip} className="flex-1 py-5 text-base" disabled={disabled}>
        Skip & Continue
      </Button>
      <Button type="button" onClick={onRetry} className="flex-1 py-5 text-base" disabled={disabled}>
        {disabled ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Retrying...
          </>
        ) : (
          "Retry"
        )}
      </Button>
    </>
  );
}
