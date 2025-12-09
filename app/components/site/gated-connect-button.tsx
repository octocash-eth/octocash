import { useConnectModal } from "@rainbow-me/rainbowkit";
import { LogOutIcon, WalletIcon } from "lucide-react";
import { useId, useState } from "react";
import useLocalStorageState from "use-local-storage-state";
import { useDisconnect } from "wagmi";
import {
  AddressAvatar,
  AddressDisplayAvatar,
  AddressDisplayCopy,
  AddressDisplayRoot,
  AddressDisplayText,
} from "~/components/address";
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
import { ScrollArea } from "~/components/ui/scroll-area";
import { useConnectedAddresses } from "~/hooks/use-connected-addresses";
import { cn } from "~/lib/utils";

const CONFIRMATION_TEXT = "I understand the risks";
const BETA_TERMS_ACCEPTED_KEY = "octocash:beta-terms-accepted";

export function GatedConnectButton() {
  const { openConnectModal } = useConnectModal();
  const connectedAddresses = useConnectedAddresses();
  const [warningDialogOpen, setWarningDialogOpen] = useState(false);
  const [connectedDialogOpen, setConnectedDialogOpen] = useState(false);
  const [confirmationText, setConfirmationText] = useState("");
  const [error, setError] = useState("");
  const [termsAccepted, setTermsAccepted] = useLocalStorageState(BETA_TERMS_ACCEPTED_KEY, {
    defaultValue: false,
  });
  const confirmationId = useId();
  const { disconnect } = useDisconnect();

  const onRequestConnect = () => {
    // If terms already accepted, skip warning and open connect modal directly
    if (termsAccepted) {
      openConnectModal?.();
      return;
    }

    // Otherwise show the warning dialog
    setConfirmationText("");
    setError("");
    setWarningDialogOpen(true);
  };

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (confirmationText !== CONFIRMATION_TEXT) {
      setError(`Please type exactly: ${CONFIRMATION_TEXT}`);
      return;
    }

    // Save acceptance (automatically persisted to localStorage by the hook)
    setTermsAccepted(true);

    setWarningDialogOpen(false);
    setTimeout(() => {
      openConnectModal?.();
    }, 0);
  };

  const hasConnectedWallets = connectedAddresses.length > 0;

  const handleClick = () => {
    if (hasConnectedWallets) {
      setConnectedDialogOpen(true);
    } else {
      onRequestConnect();
    }
  };

  const handleChangeAddresses = async () => {
    try {
      // Request accounts via EIP-2255
      await window.ethereum.request({
        method: "wallet_requestPermissions",
        params: [{ eth_accounts: {} }],
      });
    } catch (error) {
      console.error("Error requesting accounts:", error);
    }
  };

  const handleDisconnect = () => {
    disconnect();
    setConnectedDialogOpen(false);
  };

  return (
    <>
      <Button onClick={handleClick} variant={hasConnectedWallets ? "outline" : "default"}>
        {hasConnectedWallets ? (
          <>
            <div className={cn("flex -space-x-2", connectedAddresses.length > 4 && "-space-x-3")}>
              {connectedAddresses.slice(0, 8).map((address) => (
                <AddressAvatar key={address} addressOrEns={address} className="size-5 ring-2 ring-background" />
              ))}
            </div>
            Connected
          </>
        ) : (
          <>
            <WalletIcon />
            Connect Wallet
          </>
        )}
      </Button>
      {/* Beta Warning Dialog */}
      <Dialog open={warningDialogOpen} onOpenChange={setWarningDialogOpen}>
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

      {/* Connected Addresses Dialog */}
      <Dialog open={connectedDialogOpen} onOpenChange={setConnectedDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Connected Wallets</DialogTitle>
            <DialogDescription>Manage your connected wallet addresses</DialogDescription>
          </DialogHeader>
          <ScrollArea className="max-h-[400px]">
            <div className="space-y-3 py-4">
              {connectedAddresses.map((address) => (
                <AddressDisplayRoot key={address} address={address} className="rounded-lg border p-3">
                  <AddressDisplayAvatar className="size-8" />
                  <AddressDisplayText className="font-mono text-sm flex-1" />
                  <AddressDisplayCopy />
                </AddressDisplayRoot>
              ))}
            </div>
          </ScrollArea>
          <DialogFooter className="sm:justify-between">
            <div className="flex gap-2 items-center">
              <Button onClick={handleChangeAddresses} variant="ghost" size="sm">
                <WalletIcon className="size-4" />
                Change Wallets
              </Button>
              <Button onClick={handleDisconnect} variant="ghost" size="sm" className="text-destructive">
                <LogOutIcon className="size-4" />
                Disconnect
              </Button>
            </div>
            <Button size="lg" onClick={() => setConnectedDialogOpen(false)}>
              Ok
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
