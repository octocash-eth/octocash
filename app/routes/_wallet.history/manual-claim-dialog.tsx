import { useEffect, useId, useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { blockExplorers, supportedChains } from "~/data/supported-chains";
import { useCCTPClaim } from "~/hooks/use-cctp-claim";

// This maps the explorer URL (both Etherscan and Blockscout) to the chain ID.
const explorerUrls: Array<[string, number]> = [
  ...supportedChains.map((c) => [c.explorerUrl, c.id] as [string, number]),
  ...Object.entries(blockExplorers).map(([chainId, url]) => [url as string, Number(chainId)] as [string, number]),
];

const isAbortError = (e: unknown): boolean => {
  if (!e || typeof e !== "object") return false;
  const name = (e as { name?: unknown }).name;
  const code = (e as { code?: unknown }).code;
  return name === "AbortError" || code === "ABORT_ERR" || code === 20;
};

export function ManualClaimDialog({
  children,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
}: {
  children?: React.ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [internalOpen, setInternalOpen] = useState(false);
  // Support both controlled (no trigger, opened from elsewhere) and
  // uncontrolled (rendered with a `children` trigger) usage.
  const isControlled = controlledOpen !== undefined;
  const isOpen = isControlled ? controlledOpen : internalOpen;
  const setOpen = (next: boolean) => {
    if (isControlled) controlledOnOpenChange?.(next);
    else setInternalOpen(next);
  };
  const [txUrl, setTxUrl] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { claim } = useCCTPClaim();
  const txUrlId = useId();

  // Tracks the in-flight claim so Cancel / dialog dismiss / unmount can
  // abort Circle's attestation poll instead of letting it keep running in
  // the background for up to ~20 minutes after the dialog closes.
  const abortControllerRef = useRef<AbortController | null>(null);

  // Abort any pending poll if the component unmounts mid-claim.
  useEffect(() => () => abortControllerRef.current?.abort(), []);

  function abortInFlightClaim() {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
  }

  function isLikelyTxUrl(url: string) {
    try {
      const u = new URL(url);
      const hasTx = u.pathname.includes("/tx/");
      const isKnown = explorerUrls.map(([url]) => url).some((k) => u.origin === k);
      return hasTx && isKnown;
    } catch (_) {
      return false;
    }
  }

  async function handleManualClaimSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSubmitError(null);
    if (!isLikelyTxUrl(txUrl)) {
      setSubmitError("Please provide a valid Etherscan or Blockscout transaction URL.");
      return;
    }

    // Replace any prior controller before starting a new submission.
    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;

    setIsSubmitting(true);
    try {
      const chainId = explorerUrls.find(([url]) => txUrl.includes(url))?.[1];
      const tx = txUrl.split("/").pop();
      if (!tx || !chainId) {
        return;
      }
      const { mintTx } = await claim(tx, chainId, controller.signal);

      if (!mintTx) {
        setSubmitError("USDC was already claimed.");
        return;
      }

      setOpen(false);
    } catch (err) {
      // User cancellations come back as AbortError / DOMException("AbortError").
      // Stay silent — the dialog is already closing and the cancel was intentional.
      if (controller.signal.aborted || isAbortError(err)) return;
      setSubmitError((err as Error)?.message || "Failed to submit manual claim.");
    } finally {
      if (abortControllerRef.current === controller) abortControllerRef.current = null;
      setIsSubmitting(false);
    }
  }

  function handleOpenChange(next: boolean) {
    // Any close path (Cancel, X button, Escape, click-outside) must stop the
    // in-flight poll. Open transitions don't need to touch the controller.
    if (!next) abortInFlightClaim();
    setOpen(next);
  }

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      {children ? <DialogTrigger asChild>{children}</DialogTrigger> : null}
      <DialogContent className="sm:max-w-[480px]">
        <form onSubmit={handleManualClaimSubmit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Manual Claim</DialogTitle>
            <DialogDescription>
              Paste the Etherscan or Blockscout transaction URL for the burn you want to claim.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <label htmlFor={txUrlId} className="text-sm font-medium">
              Transaction URL
            </label>
            <Input
              id={txUrlId}
              placeholder="https://etherscan.io/tx/0x…"
              value={txUrl}
              onChange={(e) => setTxUrl(e.target.value)}
              required
              autoFocus
            />
            {submitError ? <p className="text-xs text-red-600">{submitError}</p> : null}
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" onClick={abortInFlightClaim}>
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? "Claiming…" : "Claim"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default ManualClaimDialog;
