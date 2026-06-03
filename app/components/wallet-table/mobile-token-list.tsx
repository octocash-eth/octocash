import type { Row, Table } from "@tanstack/react-table";
import { ChevronDown } from "lucide-react";
import * as React from "react";
import { AddressDisplayAvatar, AddressDisplayRoot, AddressDisplayText } from "~/components/address";
import { TokenDisplayAmount, TokenDisplayIcon, TokenDisplayRoot, TokenDisplaySymbol } from "~/components/token";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Skeleton } from "~/components/ui/skeleton";
import { useFormatFiat } from "~/context/currency-provider";
import { getChainName } from "~/lib/tokens";
import type { TokenAmount } from "~/lib/types";
import { cn } from "~/lib/utils";
import { ChainIcon } from "../chain/chain-icon";
import { getUsdValue } from "./columns";
import { TokenActionsMenu } from "./token-actions-menu";

const INITIAL_VISIBLE = 10;
const PAGE_INCREMENT = 10;

interface MobileTokenListProps<TData extends TokenAmount> {
  table: Table<TData>;
  priceFor?: (row: TokenAmount) => number | undefined;
  isPending?: (row: TokenAmount) => boolean;
  canSelectMore?: boolean;
  className?: string;
}

function MobileFiatValue({
  token,
  priceFor,
  isPending,
}: {
  token: TokenAmount;
  priceFor?: (row: TokenAmount) => number | undefined;
  isPending?: (row: TokenAmount) => boolean;
}) {
  const formatFiat = useFormatFiat();
  const price = priceFor?.(token);
  const pending = isPending?.(token) ?? false;

  if (price === undefined && pending) {
    return <Skeleton className="h-4 w-16 ml-auto" />;
  }

  const usd = getUsdValue(token, priceFor);
  if (usd <= 0) {
    return <span className="text-sm text-muted-foreground">-</span>;
  }
  return <span className="text-sm text-muted-foreground">{formatFiat(usd)}</span>;
}

function MobileTokenCard<TData extends TokenAmount>({
  row,
  priceFor,
  isPending,
  canSelectMore,
}: {
  row: Row<TData>;
  priceFor?: (row: TokenAmount) => number | undefined;
  isPending?: (row: TokenAmount) => boolean;
  canSelectMore: boolean;
}) {
  const token = row.original;
  const isSelected = row.getIsSelected();
  const chainName = getChainName(token.chainId);
  const canToggle = isSelected || canSelectMore;

  const toggle = () => {
    if (canToggle) row.toggleSelected();
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: card contains nested interactive controls (checkbox, actions menu), which are invalid inside a <button>
    <div
      role="button"
      tabIndex={0}
      aria-pressed={isSelected}
      data-state={isSelected ? "selected" : undefined}
      onClick={(event) => {
        // Ignore clicks bubbling up from the checkbox or actions menu.
        if ((event.target as HTMLElement).closest("[data-row-action]")) return;
        toggle();
      }}
      onKeyDown={(event) => {
        // Only the card itself drives keyboard selection; let nested
        // controls (checkbox, actions menu) handle their own keys.
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          toggle();
        }
      }}
      className={cn(
        "flex w-full cursor-pointer items-start gap-3 rounded-lg border border-border bg-card p-3 text-left",
        "data-[state=selected]:border-primary data-[state=selected]:bg-muted/50",
        !canToggle && "opacity-60",
      )}
    >
      {/* Match the icon's height so the checkbox centers against the icon row */}
      <div className="flex h-11 shrink-0 items-center">
        <Checkbox
          data-row-action
          checked={isSelected}
          disabled={!isSelected && !canSelectMore}
          onCheckedChange={(value) => row.toggleSelected(!!value)}
          aria-label="Select token"
        />
      </div>

      {/* Left column: token icon with the chain badge, centered against the identity block */}
      <TokenDisplayRoot
        tokenAddress={token.token}
        chainId={token.chainId}
        symbol={token.symbol}
        name={token.name || token.symbol}
        className="min-w-0 flex-1 items-center gap-3"
      >
        <div className="relative shrink-0 border border-secondary/20 rounded-full">
          <TokenDisplayIcon className="size-11 rounded-full" />
          <ChainIcon
            chain={chainName}
            className="absolute -bottom-0.5 -right-0.5 size-4 rounded-full ring-2 ring-card"
          />
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-1 ml-3">
          <div className="flex min-w-0 items-baseline gap-1.5">
            <TokenDisplaySymbol className="truncate text-base font-semibold" />
            <span className="truncate text-xs text-muted-foreground">{chainName}</span>
          </div>

          <AddressDisplayRoot
            address={token.walletAddress}
            chainId={token.chainId}
            className="gap-1.5 text-xs text-muted-foreground mt-1"
          >
            <AddressDisplayAvatar className="size-4 shrink-0" />
            <AddressDisplayText />
          </AddressDisplayRoot>
        </div>
      </TokenDisplayRoot>

      {/* Right column: amount, fiat value, actions — mirrors the 3 rows on the left */}
      <div className="flex shrink-0 items-start gap-1">
        <div className="flex flex-col items-end gap-1">
          <TokenDisplayRoot
            tokenAddress={token.token}
            chainId={token.chainId}
            symbol={token.symbol}
            decimals={token.decimals}
            className="items-baseline gap-1 text-base font-semibold"
          >
            <TokenDisplayAmount amount={token.amount} />
          </TokenDisplayRoot>
          <MobileFiatValue token={token} priceFor={priceFor} isPending={isPending} />
        </div>
        <div data-row-action className="-mr-1">
          <TokenActionsMenu
            token={token}
            trigger={
              <Button variant="ghost" className="size-5 p-0 text-muted-foreground">
                <span className="sr-only">Open menu</span>
                <ChevronDown className="size-4" />
              </Button>
            }
          />
        </div>
      </div>
    </div>
  );
}

export function MobileTokenList<TData extends TokenAmount>({
  table,
  priceFor,
  isPending,
  canSelectMore = true,
  className,
}: MobileTokenListProps<TData>) {
  // Mobile uses infinite scroll over the full filtered set, ignoring the
  // table's pagination (which only drives the desktop view).
  const rows = table.getFilteredRowModel().rows;
  const [visibleCount, setVisibleCount] = React.useState(INITIAL_VISIBLE);
  const sentinelRef = React.useRef<HTMLDivElement | null>(null);

  // Reset the reveal window whenever the underlying filtered set changes
  // (filter toggles, refreshes), so the user starts back at the top.
  const rowSignature = rows.map((row) => row.id).join("|");
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset the reveal window whenever the filtered set identity changes
  React.useEffect(() => {
    setVisibleCount(INITIAL_VISIBLE);
  }, [rowSignature]);

  const hasMore = visibleCount < rows.length;

  React.useEffect(() => {
    if (!hasMore) return;
    const sentinel = sentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisibleCount((count) => Math.min(count + PAGE_INCREMENT, rows.length));
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, rows.length]);

  if (rows.length === 0) {
    return <div className={cn("py-6 text-center text-sm text-muted-foreground", className)}>No tokens found</div>;
  }

  const visibleRows = rows.slice(0, visibleCount);

  return (
    <div className={cn("flex flex-col gap-3 max-md:pb-24", className)}>
      {visibleRows.map((row) => (
        <MobileTokenCard
          key={row.id}
          row={row}
          priceFor={priceFor}
          isPending={isPending}
          canSelectMore={canSelectMore}
        />
      ))}
      {hasMore && <div ref={sentinelRef} aria-hidden="true" className="h-1" />}
    </div>
  );
}
