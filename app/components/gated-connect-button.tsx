import { useConnectModal } from "@rainbow-me/rainbowkit";
import { WalletIcon } from "lucide-react";
import { useId, useState } from "react";
import { useDisconnect } from "wagmi";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { useConnectedAddresses } from "~/hooks/use-connected-addresses";

const CONFIRMATION_TEXT = "I understand the risks";

export function GatedConnectButton() {
  const { openConnectModal } = useConnectModal();
  const connectedAddresses = useConnectedAddresses();
  const [open, setOpen] = useState(false);
  const [confirmationText, setConfirmationText] = useState("");
  const [error, setError] = useState("");
  const confirmationId = useId();
  const { disconnect } = useDisconnect();

  const onRequestConnect = () => {
    setConfirmationText("");
    setError("");
    setOpen(true);
  };

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (confirmationText !== CONFIRMATION_TEXT) {
      setError(`Please type exactly: ${CONFIRMATION_TEXT}`);
      return;
    }
    setOpen(false);
    setTimeout(() => {
      openConnectModal?.();
    }, 0);
  };

  const hasConnectedWallets = connectedAddresses.length > 0;

  const handleClick = () => {
    if (hasConnectedWallets) {
      disconnect();
    } else {
      onRequestConnect();
    }
  };

  return (
    <>
      <Button onClick={handleClick} variant={hasConnectedWallets ? "outline" : "default"}>
        <WalletIcon />
        {hasConnectedWallets ? "Disconnect Wallet" : "Connect Wallet"}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Beta Warning</DialogTitle>
            <DialogDescription>
              This app is in beta and under active development. Do not use it with real funds yet, unless you know what
              you are doing.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={onSubmit} className="space-y-3">
            <div className="space-y-2">
              <label htmlFor={confirmationId} className="text-sm font-medium mb-5">
                Type{" "}
                <code className="bg-muted relative rounded px-[0.3rem] py-[0.2rem] font-mono text-sm font-semibold">
                  {CONFIRMATION_TEXT}
                </code>{" "}
                to confirm
              </label>
              <Input
                id={confirmationId}
                className="mt-2"
                type="text"
                value={confirmationText}
                onChange={(e) => setConfirmationText(e.target.value)}
                placeholder={CONFIRMATION_TEXT}
                aria-invalid={error ? true : undefined}
                autoFocus
                required
              />
              {error ? <p className="text-sm text-destructive">{error}</p> : null}
            </div>
            <DialogFooter>
              <Button type="submit" className="w-full" disabled={confirmationText !== CONFIRMATION_TEXT}>
                Continue
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
