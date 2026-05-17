import { AlertCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { ScrollArea } from "~/components/ui/scroll-area";

const COUNTDOWN_SECONDS = 5;

interface PlanErrorProps {
  error: string;
  onRetry?: () => void;
  autoRetry?: boolean;
  attemptNumber?: number;
}

export function PlanError({ error, onRetry, autoRetry = false, attemptNumber }: PlanErrorProps) {
  const showCountdown = autoRetry && onRetry !== undefined;
  const [secondsLeft, setSecondsLeft] = useState(COUNTDOWN_SECONDS);

  // Reset the countdown whenever a new failure arrives. `attemptNumber` is a
  // monotonic counter from the planning hook; we key on it (not read it) so
  // consecutive failures restart the timer cleanly. Clicking "Retry now" also
  // routes through this path: refetch fails -> attemptNumber++ -> timer resets.
  // biome-ignore lint/correctness/useExhaustiveDependencies: attemptNumber is intentionally the trigger
  useEffect(() => {
    setSecondsLeft(COUNTDOWN_SECONDS);
  }, [attemptNumber]);

  useEffect(() => {
    if (!showCountdown) return;
    if (secondsLeft <= 0) {
      onRetry?.();
      return;
    }
    const timer = setTimeout(() => setSecondsLeft((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [showCountdown, secondsLeft, onRetry]);

  return (
    <Alert variant="destructive">
      <AlertCircle className="h-4 w-4" />
      <AlertTitle>Planning Error{attemptNumber && attemptNumber > 0 ? ` (attempt ${attemptNumber})` : ""}</AlertTitle>
      <AlertDescription>
        <ScrollArea className="max-h-[300px] w-full">
          <p className="whitespace-pre-wrap break-words pr-3">{error}</p>
        </ScrollArea>
      </AlertDescription>
      {onRetry !== undefined && (
        <div className="mt-3 flex items-center gap-2">
          {showCountdown && <span className="text-sm">Retrying in {secondsLeft}s…</span>}
          <Button size="sm" onClick={() => onRetry()}>
            Retry now
          </Button>
        </div>
      )}
    </Alert>
  );
}
