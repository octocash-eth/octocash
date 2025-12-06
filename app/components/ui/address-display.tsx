import * as React from "react";
import type { Address } from "viem";
import { isAddress } from "viem";
import { normalize } from "viem/ens";
import { useEnsAddress, useEnsName } from "wagmi";
import { supportedChains } from "~/data/supported-chains";
import { cn, formatAddress } from "~/lib/utils";
import AddressAvatar from "../address-avatar";
import type { Button } from "./button";
import { IconCopyButton } from "./icon-copy-button";
import { IconLinkButton } from "./icon-link-button";

// Context
interface AddressDisplayContextValue {
  address: string;
  chainId?: number;
  ensName?: string;
  formattedAddress: string;
  handleCopy: () => void;
  copied: boolean;
  explorerUrl?: string;
}

const AddressDisplayContext = React.createContext<AddressDisplayContextValue | null>(null);

function useAddressDisplay() {
  const context = React.useContext(AddressDisplayContext);
  if (!context) {
    throw new Error("AddressDisplay components must be used within AddressDisplayRoot");
  }
  return context;
}

// Root Component
interface AddressDisplayRootProps {
  address: string;
  chainId?: number;
  children: React.ReactNode;
  className?: string;
}

function AddressDisplayRoot({ address, chainId, children, className }: AddressDisplayRootProps) {
  const [copied, setCopied] = React.useState(false);
  const isEnsName = address.endsWith(".eth");
  const isAddr = isAddress(address);

  // If address is an address, get the ENS name
  const { data: ensName } = useEnsName({
    address: isAddr ? (address as Address) : undefined,
    chainId: 1,
    query: { enabled: !isEnsName && isAddr },
  });

  let normalizedName: string | undefined;
  try {
    normalizedName = isEnsName ? normalize(address) : ensName?.toLowerCase();
  } catch (_error) {}

  // If we did not have the address and normalizedName is an ENS name, get the ENS address
  const { data: ensAddress } = useEnsAddress({
    name: normalizedName,
    chainId: 1,
    query: { enabled: !!normalizedName && !isAddr },
  });

  const resolvedAddress = ensAddress ?? address;
  const formattedAddress = formatAddress(resolvedAddress);

  // Get explorer URL if chainId is provided
  const explorerUrl = React.useMemo(() => {
    if (!chainId) return undefined;
    const chain = supportedChains.find((c) => c.id === chainId);
    if (!chain?.explorerUrl) return undefined;
    return `${chain.explorerUrl}/address/${resolvedAddress}`;
  }, [chainId, resolvedAddress]);

  const handleCopy = React.useCallback(() => {
    navigator.clipboard.writeText(resolvedAddress);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [resolvedAddress]);

  const contextValue = React.useMemo(
    () => ({
      address: resolvedAddress,
      chainId,
      ensName: normalizedName,
      formattedAddress,
      handleCopy,
      copied,
      explorerUrl,
    }),
    [resolvedAddress, chainId, normalizedName, formattedAddress, handleCopy, copied, explorerUrl],
  );

  return (
    <AddressDisplayContext.Provider value={contextValue}>
      <div className={cn("flex items-center gap-2", className)}>{children}</div>
    </AddressDisplayContext.Provider>
  );
}

// Avatar Component
interface AddressDisplayAvatarProps {
  className?: string;
  title?: string;
}

function AddressDisplayAvatar({ className, title }: AddressDisplayAvatarProps) {
  const { address } = useAddressDisplay();
  return <AddressAvatar addressOrEns={address} className={className} title={title} />;
}

// Text Component
interface AddressDisplayTextProps extends React.ComponentProps<"span"> {}

const AddressDisplayText = React.forwardRef<HTMLSpanElement, AddressDisplayTextProps>(
  ({ className, ...props }, ref) => {
    const { ensName, formattedAddress, address } = useAddressDisplay();
    const displayText = ensName || formattedAddress;

    return (
      <span ref={ref} className={cn("truncate text-nowrap", className)} title={address} {...props}>
        {displayText}
      </span>
    );
  },
);

AddressDisplayText.displayName = "AddressDisplayText";

// Copy Button Component
interface AddressDisplayCopyProps extends Omit<React.ComponentProps<typeof Button>, "onCopy"> {}

const AddressDisplayCopy = React.forwardRef<HTMLButtonElement, AddressDisplayCopyProps>(
  ({ children, ...props }, ref) => {
    const { handleCopy, copied } = useAddressDisplay();

    return (
      <IconCopyButton ref={ref} copied={copied} onCopy={handleCopy} copyTitle="Copy address" {...props}>
        {children}
      </IconCopyButton>
    );
  },
);

AddressDisplayCopy.displayName = "AddressDisplayCopy";

// External Link Component
interface AddressDisplayLinkProps extends React.ComponentProps<typeof Button> {}

const AddressDisplayLink = React.forwardRef<HTMLButtonElement, AddressDisplayLinkProps>(
  ({ children, ...props }, ref) => {
    const { explorerUrl } = useAddressDisplay();

    if (!explorerUrl) {
      return null;
    }

    return (
      <IconLinkButton ref={ref} href={explorerUrl} linkTitle="View on block explorer" {...props}>
        {children}
      </IconLinkButton>
    );
  },
);

AddressDisplayLink.displayName = "AddressDisplayLink";

export { AddressDisplayRoot, AddressDisplayAvatar, AddressDisplayText, AddressDisplayCopy, AddressDisplayLink };
