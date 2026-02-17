import * as React from "react";
import type { Address } from "viem";
import { formatUnits, isAddress, zeroAddress } from "viem";
import { IconCopyButton, IconLinkButton } from "~/components/icon";
import { supportedChains } from "~/data/supported-chains";
import { useToken } from "~/hooks/use-token";
import { formatUsd } from "~/lib/tokens";
import { cn } from "~/lib/utils";
import type { Button } from "../ui/button";
import { TokenIcon } from "./token-icon";

// Context
interface TokenDisplayContextValue {
  tokenAddress: Address;
  chainId: number;
  symbol: string;
  decimals: number;
  name?: string;
  iconUrl: string;
  explorerUrl?: string;
  tokenUrl?: string;
}

const TokenDisplayContext = React.createContext<TokenDisplayContextValue | null>(null);

function useTokenDisplay() {
  const context = React.useContext(TokenDisplayContext);
  if (!context) {
    throw new Error("TokenDisplay components must be used within TokenDisplayRoot");
  }
  return context;
}

// Root Component
interface TokenDisplayRootProps {
  tokenAddress: string;
  chainId: number;
  symbol?: string;
  decimals?: number;
  name?: string;
  children: React.ReactNode;
  className?: string;
}

function TokenDisplayRoot({
  tokenAddress,
  chainId,
  symbol: providedSymbol,
  decimals: providedDecimals,
  name: providedName,
  children,
  className,
}: TokenDisplayRootProps) {
  const isAddr = isAddress(tokenAddress);
  const isNativeToken = tokenAddress === zeroAddress;

  // Fetch token metadata if not provided and it's a valid address
  const { data: tokenData } = useToken({
    address: isAddr && !isNativeToken ? (tokenAddress as Address) : undefined,
    chainId,
    query: {
      enabled: isAddr && !isNativeToken && (!providedSymbol || !providedDecimals),
    },
  });

  // Resolve values: use provided values first, then fetched data, then defaults
  const resolvedSymbol = providedSymbol || tokenData?.symbol || "???";
  const resolvedDecimals = providedDecimals ?? tokenData?.decimals ?? 18;
  const resolvedName = providedName || tokenData?.name;

  // Generate icon URL
  const iconUrl = React.useMemo(() => {
    return `https://assets.octo.cash/token/${chainId}/${tokenAddress}`;
  }, [chainId, tokenAddress]);

  // Generate explorer URL
  const explorerUrl = React.useMemo(() => {
    const chain = supportedChains.find((c) => c.id === chainId);
    if (!chain?.explorerUrl) return undefined;
    return chain.explorerUrl;
  }, [chainId]);

  const contextValue = React.useMemo(
    () => ({
      tokenAddress: tokenAddress as Address,
      chainId,
      symbol: resolvedSymbol,
      decimals: resolvedDecimals,
      name: resolvedName,
      iconUrl,
      explorerUrl,
      tokenUrl: tokenAddress !== zeroAddress ? `${explorerUrl}/token/${tokenAddress}` : undefined,
    }),
    [tokenAddress, chainId, resolvedSymbol, resolvedDecimals, resolvedName, iconUrl, explorerUrl],
  );

  return (
    <TokenDisplayContext.Provider value={contextValue}>
      <div className={cn("flex items-center gap-2", className)}>{children}</div>
    </TokenDisplayContext.Provider>
  );
}

// Icon Component
interface TokenDisplayIconProps {
  className?: string;
}

function TokenDisplayIcon({ className }: TokenDisplayIconProps) {
  const { symbol, iconUrl } = useTokenDisplay();
  return <TokenIcon token={symbol} iconUrl={iconUrl} className={className} />;
}

// Symbol Component
interface TokenDisplaySymbolProps extends React.ComponentProps<"span"> {}

const TokenDisplaySymbol = React.forwardRef<HTMLSpanElement, TokenDisplaySymbolProps>(
  ({ className, ...props }, ref) => {
    const { symbol } = useTokenDisplay();

    return (
      <span ref={ref} className={cn("truncate text-nowrap", className)} title={symbol} {...props}>
        {symbol}
      </span>
    );
  },
);

TokenDisplaySymbol.displayName = "TokenDisplaySymbol";

// Name Component
interface TokenDisplayNameProps extends React.ComponentProps<"span"> {}

const TokenDisplayName = React.forwardRef<HTMLSpanElement, TokenDisplayNameProps>(({ className, ...props }, ref) => {
  const { name, symbol } = useTokenDisplay();
  const displayName = name || symbol;

  return (
    <span ref={ref} className={cn("truncate text-nowrap", className)} title={displayName} {...props}>
      {displayName}
    </span>
  );
});

TokenDisplayName.displayName = "TokenDisplayName";

// Amount Component
interface TokenDisplayAmountProps extends React.ComponentProps<"span"> {
  amount: bigint;
  unitaryPrice?: number;
}

/**
 * Formats a number with adaptive decimal places based on the value:
 * - >= 1000: 2 decimals
 * - >= 1: 4 decimals
 * - < 1: 6 decimals
 */
function formatAdaptiveAmount(value: number): string {
  if (value !== 0 && value < 0.000001) return "<0.000001";

  if (value >= 1000) {
    return value.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  } else if (value >= 1) {
    return value.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 4,
    });
  } else {
    return value.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 6,
    });
  }
}

const TokenDisplayAmount = React.forwardRef<HTMLSpanElement, TokenDisplayAmountProps>(
  ({ amount, unitaryPrice, className, ...props }, ref) => {
    const { decimals } = useTokenDisplay();

    const { formattedAmount, titleText } = React.useMemo(() => {
      const value = Number(formatUnits(amount, decimals));
      const tokenAmount = formatAdaptiveAmount(value);
      const title = unitaryPrice !== undefined ? `${tokenAmount} (${formatUsd(value * unitaryPrice)})` : tokenAmount;
      return { formattedAmount: tokenAmount, titleText: title };
    }, [amount, decimals, unitaryPrice]);

    return (
      <span ref={ref} className={cn("truncate text-nowrap", className)} title={titleText} {...props}>
        {formattedAmount}
      </span>
    );
  },
);

TokenDisplayAmount.displayName = "TokenDisplayAmount";

// Copy Button Component
interface TokenDisplayCopyProps extends Omit<React.ComponentProps<typeof Button>, "onCopy"> {}

const TokenDisplayCopy = React.forwardRef<HTMLButtonElement, TokenDisplayCopyProps>(({ children, ...props }, ref) => {
  const { tokenAddress } = useTokenDisplay();

  return (
    <IconCopyButton ref={ref} text={tokenAddress} copyTitle="Copy token address" {...props}>
      {children}
    </IconCopyButton>
  );
});

TokenDisplayCopy.displayName = "TokenDisplayCopy";

// Link Component
interface TokenDisplayLinkProps extends React.ComponentProps<typeof Button> {
  walletAddress?: Address;
}

const TokenDisplayLink = React.forwardRef<HTMLButtonElement, TokenDisplayLinkProps>(
  ({ children, walletAddress, ...props }, ref) => {
    const { explorerUrl, tokenAddress, tokenUrl } = useTokenDisplay();

    if (!explorerUrl || (tokenAddress === zeroAddress && !walletAddress)) {
      return null;
    }

    let href = "";
    if (walletAddress && tokenAddress !== zeroAddress) {
      href = `${tokenUrl}?a=${walletAddress}`;
    } else {
      href = `${explorerUrl}/address/${walletAddress}`;
    }

    return (
      <IconLinkButton ref={ref} href={href} linkTitle="View token on block explorer" {...props}>
        {children}
      </IconLinkButton>
    );
  },
);

TokenDisplayLink.displayName = "TokenDisplayLink";

export {
  TokenDisplayRoot,
  TokenDisplayIcon,
  TokenDisplaySymbol,
  TokenDisplayName,
  TokenDisplayAmount,
  TokenDisplayCopy,
  TokenDisplayLink,
};
