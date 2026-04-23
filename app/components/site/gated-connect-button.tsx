import {
  ArrowUpRightIcon,
  CheckIcon,
  ChevronLeftIcon,
  CopyIcon,
  LightbulbIcon,
  LoaderCircleIcon,
  LogOutIcon,
  QrCodeIcon,
  WalletIcon,
} from "lucide-react";
import { useMemo, useState } from "react";
import QRCode from "react-qr-code";
import { Link } from "react-router";
import useLocalStorageState from "use-local-storage-state";
import { useConnect, useDisconnect } from "wagmi";
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
const SUPPORTED_CONNECTOR_IDS = new Set(["injected", "walletConnect"]);

const CONNECTOR_COPY = {
  injected: {
    title: "Browser Wallet",
    description: "Use MetaMask, Rabby, Rainbow, or another wallet installed in this browser.",
    icon: WalletIcon,
    eyebrow: "Installed locally",
  },
  walletConnect: {
    title: "WalletConnect",
    description: "Scan a QR code with your mobile wallet or continue in a WalletConnect-compatible app.",
    icon: QrCodeIcon,
    eyebrow: "Mobile and desktop",
  },
} as const;

export function GatedConnectButton() {
  const connectedAddresses = useConnectedAddresses();
  const { connectors, connectAsync, error, status } = useConnect();
  const [onboardingDialogOpen, setOnboardingDialogOpen] = useState(false);
  const [onboardingStep, setOnboardingStep] = useState<1 | 2>(1);
  const [walletDialogOpen, setWalletDialogOpen] = useState(false);
  const [connectedDialogOpen, setConnectedDialogOpen] = useState(false);
  const [walletConnectUri, setWalletConnectUri] = useState<string | null>(null);
  const [copiedWalletConnectUri, setCopiedWalletConnectUri] = useState(false);
  const [walletConnectPreparing, setWalletConnectPreparing] = useState(false);
  const [checked, setChecked] = useState(false);
  const [termsAccepted, setTermsAccepted] = useLocalStorageState(TERMS_ACCEPTED_KEY, {
    defaultValue: false,
  });
  const { disconnect } = useDisconnect();
  const supportedConnectors = useMemo(
    () => connectors.filter((connector) => SUPPORTED_CONNECTOR_IDS.has(connector.id)),
    [connectors],
  );
  const isConnecting = status === "pending";

  const onRequestConnect = () => {
    if (termsAccepted) {
      setWalletConnectUri(null);
      setCopiedWalletConnectUri(false);
      setWalletConnectPreparing(false);
      setWalletDialogOpen(true);
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
    setWalletConnectUri(null);
    setCopiedWalletConnectUri(false);
    setWalletConnectPreparing(false);
    setWalletDialogOpen(true);
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
      await window.ethereum?.request({
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

  const handleWalletConnect = async (connector: (typeof supportedConnectors)[number]) => {
    if (connector.id === "walletConnect") {
      setWalletConnectUri(null);
      setCopiedWalletConnectUri(false);
      setWalletConnectPreparing(true);

      const handleMessage = ({ type, data }: { type: string; data?: unknown }) => {
        if (type === "display_uri" && typeof data === "string") {
          setWalletConnectUri(data);
          setWalletConnectPreparing(false);
          connector.emitter.off("message", handleMessage);
        }
      };

      connector.emitter.on("message", handleMessage);

      try {
        await connectAsync({ connector });
        setWalletDialogOpen(false);
        setWalletConnectPreparing(false);
        connector.emitter.off("message", handleMessage);
      } catch {
        setWalletConnectPreparing(false);
        connector.emitter.off("message", handleMessage);
        // keep the dialog open so the user can try another connector
      }

      return;
    }

    try {
      await connectAsync({ connector });
      setWalletDialogOpen(false);
    } catch {
      // keep the dialog open so the user can try another connector
    }
  };

  const handleWalletConnectBack = () => {
    setWalletConnectUri(null);
    setCopiedWalletConnectUri(false);
    setWalletConnectPreparing(false);
  };

  const handleCopyWalletConnectUri = async () => {
    if (!walletConnectUri) return;

    try {
      await navigator.clipboard.writeText(walletConnectUri);
      setCopiedWalletConnectUri(true);
    } catch (copyError) {
      console.error("Error copying WalletConnect link:", copyError);
    }
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

      <Dialog open={walletDialogOpen} onOpenChange={setWalletDialogOpen}>
        <DialogContent className="overflow-hidden border-border/60 bg-background p-0 shadow-2xl sm:max-w-xl">
          <div className="border-b border-border/60 bg-muted/30 px-6 py-5">
            <DialogHeader className="gap-3">
              <div className="inline-flex w-fit items-center rounded-full border border-pink-500/30 bg-pink-500/10 px-3 py-1 text-xs font-medium text-pink-600 dark:text-pink-300">
                Connect to Octocash
              </div>
              <div className="space-y-1">
                <DialogTitle className="text-xl">Choose a Wallet</DialogTitle>
                <DialogDescription className="max-w-md text-sm leading-relaxed">
                  Pick the connection method that fits your setup. You can swap addresses later from the connected
                  wallets menu.
                </DialogDescription>
              </div>
            </DialogHeader>
          </div>

          <div className="space-y-3 px-6 py-5">
            {walletConnectUri || walletConnectPreparing ? (
              <div className="space-y-4">
                <button
                  type="button"
                  className="inline-flex items-center gap-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
                  onClick={handleWalletConnectBack}
                >
                  <ChevronLeftIcon className="size-4" />
                  Back
                </button>

                <div className="mx-auto flex max-w-[18rem] flex-col items-center gap-4 px-2 py-2 text-center">
                  <div className="flex size-12 items-center justify-center rounded-2xl border border-border/70 bg-pink-500/10 text-pink-600 dark:text-pink-300">
                    <QrCodeIcon className="size-6" />
                  </div>
                  <div className="space-y-1">
                    <h3 className="text-lg font-semibold text-foreground">Scan with WalletConnect</h3>
                    <p className="text-sm leading-relaxed text-muted-foreground">
                      Open your wallet app and scan this QR code, or copy the link and open it on another device.
                    </p>
                  </div>

                  <div className="flex min-h-[17rem] w-full items-center justify-center rounded-[1.75rem] bg-white p-4 shadow-[0_12px_32px_rgba(0,0,0,0.08)] ring-1 ring-border/60">
                    {walletConnectUri ? (
                      <QRCode value={walletConnectUri} size={224} className="h-auto w-full max-w-[14rem]" />
                    ) : (
                      <div className="flex flex-col items-center gap-3 text-center text-muted-foreground">
                        <LoaderCircleIcon className="size-8 animate-spin" />
                        <p className="text-sm">Preparing WalletConnect QR code...</p>
                      </div>
                    )}
                  </div>

                  <Button
                    className="w-full"
                    variant={copiedWalletConnectUri ? "secondary" : "outline"}
                    onClick={handleCopyWalletConnectUri}
                    disabled={!walletConnectUri}
                  >
                    {copiedWalletConnectUri ? (
                      <>
                        <CheckIcon className="size-4" />
                        Copied
                      </>
                    ) : (
                      <>
                        <CopyIcon className="size-4" />
                        Copy link
                      </>
                    )}
                  </Button>
                </div>
              </div>
            ) : (
              <>
                {supportedConnectors.map((connector) => {
                  const copy = CONNECTOR_COPY[connector.id as keyof typeof CONNECTOR_COPY];
                  const isInjectedUnavailable =
                    connector.id === "injected" && typeof window !== "undefined" && !window.ethereum;
                  const disabled = isConnecting || isInjectedUnavailable;
                  const Icon = copy?.icon ?? WalletIcon;

                  return (
                    <button
                      key={connector.uid}
                      type="button"
                      className={cn(
                        "group flex w-full items-start gap-4 rounded-3xl border border-border/70 bg-background px-4 py-4 text-left shadow-sm transition-all duration-200",
                        "hover:border-pink-400/50 hover:bg-pink-500/[0.04] hover:shadow-md",
                        "focus-visible:border-pink-500 focus-visible:ring-4 focus-visible:ring-pink-500/15 focus-visible:outline-none",
                        disabled && "cursor-not-allowed opacity-55 hover:bg-background hover:shadow-sm",
                      )}
                      disabled={disabled}
                      onClick={() => handleWalletConnect(connector)}
                    >
                      <div className="mt-0.5 flex size-11 shrink-0 items-center justify-center rounded-2xl border border-border/70 bg-muted/60 text-foreground transition-colors group-hover:border-pink-400/40 group-hover:bg-pink-500/10 group-hover:text-pink-600 dark:group-hover:text-pink-300">
                        <Icon className="size-5" />
                      </div>
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
                              {copy?.eyebrow ?? "Wallet option"}
                            </p>
                            <p className="text-base font-semibold text-foreground">{copy?.title ?? connector.name}</p>
                          </div>
                          <div className="rounded-full border border-border/70 bg-muted/50 p-2 text-muted-foreground transition-colors group-hover:border-pink-400/40 group-hover:bg-pink-500/10 group-hover:text-pink-600 dark:group-hover:text-pink-300">
                            <ArrowUpRightIcon className="size-4" />
                          </div>
                        </div>
                        <p className="pr-6 text-sm leading-relaxed text-muted-foreground">
                          {isInjectedUnavailable ? "No injected wallet detected in this browser." : copy?.description}
                        </p>
                      </div>
                    </button>
                  );
                })}
                {supportedConnectors.length === 0 ? (
                  <div className="rounded-2xl border border-dashed border-border/70 bg-muted/30 px-4 py-5 text-sm text-muted-foreground">
                    No wallet connectors are available right now.
                  </div>
                ) : null}
                {error ? (
                  <div className="rounded-2xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
                    {error.message}
                  </div>
                ) : null}
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Browser Wallet works best when you already have a wallet extension installed. WalletConnect is ideal
                  for mobile wallets and secondary devices.
                </p>
              </>
            )}
          </div>
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
