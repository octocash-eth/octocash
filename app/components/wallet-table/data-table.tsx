import type { ColumnDef, OnChangeFn, RowSelectionState, SortingState } from "@tanstack/react-table";
import { useTable } from "@tanstack/react-table";
import { Coins, Link, RotateCw, Wallet } from "lucide-react";
import * as React from "react";
import { AddressDisplayAvatar, AddressDisplayRoot, AddressDisplayText } from "~/components/address";
import { TokenDisplayIcon, TokenDisplayRoot, TokenDisplaySymbol } from "~/components/token";
import { useFormatFiat } from "~/context/currency-provider";
import { MAX_SOURCE_TOKENS } from "~/lib/planning";
import { getChainName, getTokenId } from "~/lib/tokens";
import type { TokenAmount } from "~/lib/types";
import { ChainIcon } from "../chain/chain-icon";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { ScrollArea, ScrollBar } from "../ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { getUsdValue } from "./columns";
import { DataGrid, DataGridContainer } from "./data-grid";
import { DataGridPaginationNav, DataGridPaginationSize } from "./data-grid-pagination";
import { DataGridTable } from "./data-grid-table";
import { type WalletTableFeatures, walletTableFeatures } from "./features";
import { MobileTokenList } from "./mobile-token-list";
import type { WalletTableFilterConfig } from "./wallet-table-filters";
import { WalletTableFilters } from "./wallet-table-filters";

interface DataTableProps {
  columns: ColumnDef<WalletTableFeatures, TokenAmount>[];
  data: TokenAmount[];
  connectedAddresses?: readonly string[];
  rowSelection: RowSelectionState;
  onRowSelectionChange: OnChangeFn<RowSelectionState>;
  onRefresh?: () => void;
  isRefreshing?: boolean;
  priceFor?: (row: TokenAmount) => number | undefined;
  isPending?: (row: TokenAmount) => boolean;
  canSelectMore?: boolean;
  /** Rendered inline at the start of the filter toolbar row. */
  toolbarStart?: React.ReactNode;
}

function RenderedAddressCell({ address }: { address: string }) {
  return (
    <AddressDisplayRoot address={address}>
      <AddressDisplayAvatar className="size-4" />
      <AddressDisplayText />
    </AddressDisplayRoot>
  );
}

function RenderedTokenCell({ token }: { token: TokenAmount }) {
  return (
    <TokenDisplayRoot tokenAddress={token.token} chainId={token.chainId} symbol={token.symbol} className="gap-2">
      <TokenDisplayIcon className="size-4" />
      <TokenDisplaySymbol />
    </TokenDisplayRoot>
  );
}

function RenderedChainCell({ chain }: { chain: string }) {
  return (
    <div className="flex items-center gap-2">
      <ChainIcon chain={chain} className="size-4" />
      {chain}
    </div>
  );
}

export function DataTable({
  columns,
  data,
  rowSelection,
  onRowSelectionChange,
  onRefresh,
  isRefreshing = false,
  priceFor,
  isPending,
  canSelectMore = true,
  toolbarStart,
}: DataTableProps) {
  const [sorting, setSorting] = React.useState<SortingState>([]);

  // One dropdown per filterable column, offering each distinct value in `data`.
  // Option values must match what the column's `isAnyOf` filter compares:
  // the stringified column value.
  const filterConfigs = React.useMemo<readonly WalletTableFilterConfig[]>(() => {
    const wallets = [...new Set(data.map((token) => token.walletAddress))];
    // Unique tokens (by symbol); the first token of each symbol renders its option.
    const seenSymbols = new Set<string>();
    const tokens = data.filter((token) => {
      if (seenSymbols.has(token.symbol)) return false;
      seenSymbols.add(token.symbol);
      return true;
    });
    const chainIds = [...new Set(data.map((token) => token.chainId))];

    return [
      {
        columnId: "walletAddress",
        label: "Wallets",
        icon: Wallet,
        emptyMessage: "No wallets available",
        options: wallets.map((address) => ({ value: address, label: <RenderedAddressCell address={address} /> })),
      },
      {
        columnId: "symbol",
        label: "Tokens",
        icon: Coins,
        emptyMessage: "No tokens available",
        options: tokens.map((token) => ({ value: token.symbol, label: <RenderedTokenCell token={token} /> })),
      },
      {
        columnId: "chainId",
        label: "Chains",
        icon: Link,
        emptyMessage: "No chains available",
        options: chainIds.map((chainId) => ({
          value: String(chainId),
          label: <RenderedChainCell chain={getChainName(chainId)} />,
        })),
      },
    ];
  }, [data]);

  const meta = React.useMemo(() => ({ priceFor, isPending, canSelectMore }), [priceFor, isPending, canSelectMore]);

  const table = useTable({
    features: walletTableFeatures,
    data,
    columns,
    onSortingChange: setSorting,
    onRowSelectionChange,
    enableRowSelection: true,
    // Keep the user on the current page. The `tokens` pipeline re-derives a
    // fresh `data` array on every render (it flows through `useQueries`
    // results), so the default `autoResetPageIndex` would snap back to page 1
    // on any selection change or streamed price update.
    autoResetPageIndex: false,
    getRowId: (row) => getTokenId(row),
    meta,
    state: {
      sorting,
      rowSelection,
    },
  });

  // Filter changes send the user back to page 1 themselves (see
  // `WalletTableFilters`). This is the backstop for everything else (a refresh
  // returning fewer tokens, a page size change): with `autoResetPageIndex` off the user could be stranded on
  // a now-empty page past the end, so fall back to page 1 there too.
  const pageIndex = table.state.pagination.pageIndex;
  const pageCount = table.getPageCount();
  React.useEffect(() => {
    if (pageIndex > 0 && pageIndex > pageCount - 1) {
      table.setPageIndex(0);
    }
  }, [pageIndex, pageCount, table]);

  const formatFiat = useFormatFiat();

  // Total reflects the currently filtered/visible rows; the selection sum
  // reflects every selected row. Both reuse the value column's `getUsdValue`
  // so the indicator stays in lockstep with the displayed cell values.
  // Grand total across every loaded token (ignores filters/selection).
  const totalUsd = data.reduce((sum, row) => sum + getUsdValue(row, priceFor), 0);
  const filteredUsd = table
    .getFilteredRowModel()
    .rows.reduce((sum, row) => sum + getUsdValue(row.original, priceFor), 0);
  const selectedRows = table.getSelectedRowModel().rows;
  const selectedUsd = selectedRows.reduce((sum, row) => sum + getUsdValue(row.original, priceFor), 0);
  const hasSelection = selectedRows.length > 0;
  const hasActiveFilter = table.state.columnFilters.length > 0;

  const indicatorLabel = hasSelection ? "Selected: " : hasActiveFilter ? "Filtered: " : "Total: ";
  const indicatorUsd = hasSelection ? selectedUsd : hasActiveFilter ? filteredUsd : totalUsd;
  const showTotalTooltip = hasSelection || hasActiveFilter;

  const totalIndicator = showTotalTooltip ? (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="text-lg whitespace-nowrap text-muted-foreground cursor-default">
          {indicatorLabel}
          <span className="font-bold text-primary bg-primary-foreground">{formatFiat(indicatorUsd)}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent className="text-lg text-nowrap">Total: {formatFiat(totalUsd)}</TooltipContent>
    </Tooltip>
  ) : (
    <span className="text-lg whitespace-nowrap text-muted-foreground">
      {indicatorLabel}
      <span className="font-bold text-primary bg-primary-foreground">{formatFiat(indicatorUsd)}</span>
    </span>
  );

  const selectedCount = Object.keys(rowSelection).length;
  const atSelectionLimit = selectedCount >= MAX_SOURCE_TOKENS;
  const totalTokens = data.length;

  const selectionText =
    selectedCount === 0
      ? `${totalTokens} available ${totalTokens === 1 ? "token" : "tokens"}`
      : `${selectedCount} of ${totalTokens} ${totalTokens === 1 ? "token" : "tokens"} selected${
          atSelectionLimit ? " (consolidation limit reached)" : ""
        }`;

  const selectionIndicator = (
    <p className={`text-sm whitespace-nowrap ${atSelectionLimit ? "text-amber-600" : "text-muted-foreground"}`}>
      {selectionText}
    </p>
  );

  const refreshButton = onRefresh ? (
    <Button variant="outline" size="icon" onClick={onRefresh} disabled={isRefreshing}>
      <RotateCw className={`h-4 w-4 ${isRefreshing ? "animate-spin" : ""}`} />
      <span className="sr-only">Refresh table data</span>
    </Button>
  ) : null;

  // Function to clear all filters
  return (
    <div className="space-y-4">
      {/* On mobile, keep the total + filters pinned below the sticky site header. */}
      <div className="space-y-4 max-md:sticky max-md:top-[57px] max-md:z-30 max-md:-mx-4 max-md:bg-background/95 max-md:px-4 max-md:py-3 max-md:backdrop-blur">
        {/* Mobile: total + refresh in a dedicated card above the filters. */}
        <Card className="flex md:hidden flex-row items-center justify-between gap-3 px-4 py-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            {totalIndicator}
            {selectionIndicator}
          </div>
          {refreshButton}
        </Card>

        <div className="flex flex-wrap items-center justify-between gap-2">
          {toolbarStart}
          <WalletTableFilters table={table} filterConfigs={filterConfigs} />
          {/* Desktop: total + refresh inline in the header row. */}
          <div className="hidden md:flex items-center gap-3 ml-auto">
            {totalIndicator}
            {refreshButton}
          </div>
        </div>
      </div>

      <DataGrid
        table={table}
        recordCount={data.length}
        isLoading={isRefreshing && data.length === 0}
        emptyMessage="No tokens found"
        onRowClick={(row) => {
          if (row.getIsSelected() || canSelectMore) {
            row.toggleSelected();
          }
        }}
        tableLayout={{
          headerSticky: true,
          headerBackground: false,
          striped: false,
          cellBorder: false,
          rowBorder: false,
          width: "fixed",
        }}
        tableClassNames={{
          bodyRow: "cursor-default",
        }}
      >
        {/* Desktop: the full data grid table with horizontal scroll. */}
        <DataGridContainer className="hidden md:grid">
          <ScrollArea className="max-h-[calc(100vh-300px)]">
            <div className="min-w-5xl">
              <DataGridTable />
            </div>
            <ScrollBar orientation="vertical" />
            <ScrollBar orientation="horizontal" />
          </ScrollArea>
        </DataGridContainer>

        {/* Mobile: card list driven by the same table, with infinite scroll. */}
        <MobileTokenList
          table={table}
          priceFor={priceFor}
          isPending={isPending}
          canSelectMore={canSelectMore}
          className="md:hidden"
        />

        {/* Pagination is desktop-only; mobile uses infinite scroll. */}
        <div className="hidden md:grid grid-cols-3 items-center gap-4 px-2 pt-1 pb-2">
          <div className="justify-self-start -mt-1">{selectionIndicator}</div>
          <DataGridPaginationNav className="justify-self-center" />
          <DataGridPaginationSize sizes={[10, 25, 50, 100]} className="justify-self-end" />
        </div>
      </DataGrid>
    </div>
  );
}
