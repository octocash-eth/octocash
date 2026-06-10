import { ShieldCheck } from "lucide-react";
import * as React from "react";
import type { Address } from "viem";
import { isAddress } from "viem";
import { normalize } from "viem/ens";
import { useEnsAddress, useEnsName } from "wagmi";
import { IconCopyButton, IconLinkButton } from "~/components/icon";
import { supportedChains } from "~/data/supported-chains";
import { isRailgunAddress, truncateRailgunAddress } from "~/lib/railgun";
import { cn, formatAddress } from "~/lib/utils";
import type { Button } from "../ui/button";
import AddressAvatar from "./address-avatar";

// Context
interface AddressDisplayContextValue {
  address: string;
  chainId?: number;
  ensName?: string;
  formattedAddress: string;
  explorerUrl?: string;
  /** True when the address is a private Railgun 0zk address. */
  isRailgun: boolean;
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
  const isRailgun = isRailgunAddress(address);
  const isEnsName = !isRailgun && address.endsWith(".eth");
  const isAddr = !isRailgun && isAddress(address);

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
  const formattedAddress = isRailgun ? truncateRailgunAddress(address) : formatAddress(resolvedAddress);

  // Get explorer URL if chainId is provided (0zk addresses have no explorer page)
  const explorerUrl = React.useMemo(() => {
    if (!chainId || isRailgun) return undefined;
    const chain = supportedChains.find((c) => c.id === chainId);
    if (!chain?.explorerUrl) return undefined;
    return `${chain.explorerUrl}/address/${resolvedAddress}`;
  }, [chainId, resolvedAddress, isRailgun]);

  const contextValue = React.useMemo(
    () => ({
      address: resolvedAddress,
      chainId,
      ensName: normalizedName,
      formattedAddress,
      explorerUrl,
      isRailgun,
    }),
    [resolvedAddress, chainId, normalizedName, formattedAddress, explorerUrl, isRailgun],
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
  const { address, isRailgun } = useAddressDisplay();
  if (isRailgun) {
    return (
      <span title={title ?? address} className="inline-flex shrink-0">
        <ShieldCheck className={cn("text-primary", className)} aria-label="Private Railgun address" />
      </span>
    );
  }
  return <AddressAvatar addressOrEns={address} className={className} title={title} />;
}

// Text Component
interface AddressDisplayTextProps extends React.ComponentProps<"span"> {}

const AddressDisplayText = React.forwardRef<HTMLSpanElement, AddressDisplayTextProps>(
  ({ className, ...props }, ref) => {
    const { ensName, formattedAddress, address, isRailgun } = useAddressDisplay();
    const displayText = ensName || formattedAddress;

    return (
      <span
        ref={ref}
        className={cn("truncate text-nowrap", isRailgun && "font-mono", className)}
        title={address}
        {...props}
      >
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
    const { address } = useAddressDisplay();

    return (
      <IconCopyButton ref={ref} text={address} copyTitle="Copy address" {...props}>
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

export { AddressDisplayAvatar, AddressDisplayCopy, AddressDisplayLink, AddressDisplayRoot, AddressDisplayText };
