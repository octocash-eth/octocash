import { useConnectModal } from "@rainbow-me/rainbowkit";
import { LightbulbIcon, LogOutIcon, WalletIcon } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
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
import { Checkbox } from "~/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { ScrollArea } from "~/components/ui/scroll-area";
import { useConnectedAddresses } from "~/hooks/use-connected-addresses";
import { cn } from "~/lib/utils";

const TERMS_ACCEPTED_KEY = "octocash:terms-accepted";

export function GatedConnectButton() {
  const { openConnectModal } = useConnectModal();
  const connectedAddresses = useConnectedAddresses();
  const [onboardingDialogOpen, setOnboardingDialogOpen] = useState(false);
  const [onboardingStep, setOnboardingStep] = useState<1 | 2>(1);
  const [connectedDialogOpen, setConnectedDialogOpen] = useState(false);
  const [checked, setChecked] = useState(false);
  const [termsAccepted, setTermsAccepted] = useLocalStorageState(TERMS_ACCEPTED_KEY, {
    defaultValue: false,
  });
  const { disconnect } = useDisconnect();

  const onRequestConnect = () => {
    if (termsAccepted) {
      openConnectModal?.();
      return;
    }

    setChecked(false);
    setOnboardingStep(1);
    setOnboardingDialogOpen(true);
  };

  const onAcceptTerms = () => {
    setTermsAccepted(true);
    setOnboardingStep(2);
  };

  const onConnect = () => {
    setOnboardingDialogOpen(false);
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

      {/* Onboarding Dialog */}
      <Dialog open={onboardingDialogOpen} onOpenChange={setOnboardingDialogOpen}>
        <DialogContent>
          {onboardingStep === 1 ? (
            <>
              <DialogHeader>
                <DialogTitle>Welcome to Octocash</DialogTitle>
                <DialogDescription>
                  Octocash is a client-side dapp, although we do talk to third-party services like RPC providers and
                  other APIs to fetch your balances and find the best routes for consolidation.
                </DialogDescription>
              </DialogHeader>
              <div className="flex items-start gap-3 py-2">
                <Checkbox
                  id="terms-checkbox"
                  checked={checked}
                  onCheckedChange={(value) => setChecked(value === true)}
                  className="mt-0.5"
                />
                <label htmlFor="terms-checkbox" className="text-sm leading-relaxed cursor-pointer">
                  I agree to the{" "}
                  <Link
                    to="/terms"
                    target="_blank"
                    className="underline font-medium"
                    onClick={(e) => e.stopPropagation()}
                  >
                    Terms of Service
                  </Link>{" "}
                  and{" "}
                  <Link
                    to="/privacy"
                    target="_blank"
                    className="underline font-medium"
                    onClick={(e) => e.stopPropagation()}
                  >
                    Privacy Policy
                  </Link>
                </label>
              </div>
              <DialogFooter>
                <Button className="w-full" disabled={!checked} onClick={onAcceptTerms}>
                  Continue
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>Connect Your Wallets</DialogTitle>
                <DialogDescription>
                  Octo will scan every supported chain and gather your tokens in one place to see what's worth
                  consolidating.
                </DialogDescription>
              </DialogHeader>
              <div className="flex items-start gap-2 rounded-lg bg-muted/50 p-3">
                <LightbulbIcon className="size-4 mt-0.5 shrink-0 text-yellow-500" />
                <p className="text-sm">
                  Got multiple addresses? In MetaMask, hit the <span className="font-medium">"Edit accounts"</span> link
                  and tick as many checkboxes as you like. Octo will happily crunch them all at once!
                </p>
              </div>
              <DialogFooter>
                <Button className="w-full" onClick={onConnect}>
                  Let's go!
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Connected Addresses Dialog */}
      <Dialog open={connectedDialogOpen} onOpenChange={setConnectedDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Connected Wallets</DialogTitle>
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
