import { ExternalLink } from "lucide-react";
import * as React from "react";
import type { Address } from "viem";
import { formatUnits, isAddress, zeroAddress } from "viem";
import { useToken } from "wagmi";
import { supportedChains } from "~/data/supported-chains";
import { cn } from "~/lib/utils";
import { TokenIcon } from "../token-icon";

// Context
interface TokenDisplayContextValue {
  tokenAddress: Address;
  chainId: number;
  symbol: string;
  decimals: number;
  fullName?: string;
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
  fullName?: string;
  children: React.ReactNode;
  className?: string;
}

function TokenDisplayRoot({
  tokenAddress,
  chainId,
  symbol: providedSymbol,
  decimals: providedDecimals,
  fullName: providedFullName,
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
  const resolvedFullName = providedFullName || tokenData?.name;

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
      fullName: resolvedFullName,
      iconUrl,
      explorerUrl,
      tokenUrl: tokenAddress !== zeroAddress ? `${explorerUrl}/token/${tokenAddress}` : undefined,
    }),
    [tokenAddress, chainId, resolvedSymbol, resolvedDecimals, resolvedFullName, iconUrl, explorerUrl],
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
  const { fullName, symbol } = useTokenDisplay();
  const displayName = fullName || symbol;

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
  maximumFractionDigits?: number;
  minimumFractionDigits?: number;
}

const TokenDisplayAmount = React.forwardRef<HTMLSpanElement, TokenDisplayAmountProps>(
  ({ amount, maximumFractionDigits = 6, minimumFractionDigits = 2, className, ...props }, ref) => {
    const { decimals } = useTokenDisplay();

    const formattedAmount = React.useMemo(() => {
      const value = Number(formatUnits(amount, decimals));
      if (value !== 0 && value < 0.000001) return "<0.000001";
      return value.toLocaleString(undefined, {
        maximumFractionDigits,
        minimumFractionDigits,
      });
    }, [amount, decimals, maximumFractionDigits, minimumFractionDigits]);

    return (
      <span ref={ref} className={cn("truncate text-nowrap", className)} title={formattedAmount} {...props}>
        {formattedAmount}
      </span>
    );
  },
);

TokenDisplayAmount.displayName = "TokenDisplayAmount";

// Link Component
interface TokenDisplayLinkProps extends React.ComponentProps<"a"> {
  walletAddress?: Address;
}

const TokenDisplayLink = React.forwardRef<HTMLAnchorElement, TokenDisplayLinkProps>(
  ({ children, walletAddress, className, ...props }, ref) => {
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
      <a
        ref={ref}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className={cn("text-blue-500 hover:text-blue-700 inline-flex items-center", className)}
        title="View token on block explorer"
        {...props}
      >
        {children ?? <ExternalLink className="h-3 w-3" />}
      </a>
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
  TokenDisplayLink,
};
