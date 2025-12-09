import { useId, useState } from "react";
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

export function ManualClaimDialog({ children }: { children: React.ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const [txUrl, setTxUrl] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { claim } = useCCTPClaim();
  const txUrlId = useId();

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
    setIsSubmitting(true);
    try {
      const chainId = explorerUrls.find(([url]) => txUrl.includes(url))?.[1];
      const tx = txUrl.split("/").pop();
      if (!tx || !chainId) {
        return;
      }
      const { mintTx } = await claim(tx, chainId);

      if (!mintTx) {
        setSubmitError("USDC was already claimed.");
        return;
      }

      setIsOpen(false);
    } catch (err) {
      setSubmitError((err as Error)?.message || "Failed to submit manual claim.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
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
              <Button type="button" variant="outline">
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
