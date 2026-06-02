import type {
  ColumnDef,
  ColumnFiltersState,
  OnChangeFn,
  RowSelectionState,
  SortingState,
  VisibilityState,
} from "@tanstack/react-table";
import {
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
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
import { DataGrid, DataGridContainer } from "../ui/data-grid";
import { DataGridPaginationNav, DataGridPaginationSize } from "../ui/data-grid-pagination";
import { DataGridTable } from "../ui/data-grid-table";
import { ScrollArea, ScrollBar } from "../ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { getUsdValue } from "./columns";
import type { WalletTableFilterConfig } from "./wallet-table-filters";
import { WalletTableFilters } from "./wallet-table-filters";

interface DataTableProps<TData extends object, TValue> {
  columns: ColumnDef<TData, TValue>[];
  data: TData[];
  connectedAddresses?: readonly string[];
  rowSelection: RowSelectionState;
  onRowSelectionChange: OnChangeFn<RowSelectionState>;
  onRefresh?: () => void;
  isRefreshing?: boolean;
  priceFor?: (row: TData) => number | undefined;
  isPending?: (row: TData) => boolean;
  canSelectMore?: boolean;
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

export function DataTable<TData extends TokenAmount, TValue>({
  columns,
  data,
  rowSelection,
  onRowSelectionChange,
  onRefresh,
  isRefreshing = false,
  priceFor,
  isPending,
  canSelectMore = true,
}: DataTableProps<TData, TValue>) {
  const [sorting, setSorting] = React.useState<SortingState>([]);
  const [columnFilters, setColumnFilters] = React.useState<ColumnFiltersState>([]);
  const [columnVisibility, setColumnVisibility] = React.useState<VisibilityState>({});

  // Unique wallets
  const wallets = React.useMemo(() => {
    return [...new Set(data.map((token) => token.walletAddress))];
  }, [data]);

  // Unique tokens (by symbol) - we pass the full token for rendering
  const tokens = React.useMemo(() => {
    const seen = new Set<string>();
    return data.filter((token) => {
      if (seen.has(token.symbol)) return false;
      seen.add(token.symbol);
      return true;
    });
  }, [data]);

  // Unique chains (as chain names)
  const chains = React.useMemo(() => {
    const chainNames = data.map((token) => getChainName(token.chainId));
    return [...new Set(chainNames)];
  }, [data]);

  // Filter configs
  const filterConfigs = React.useMemo<ReadonlyArray<WalletTableFilterConfig<TData, unknown>>>(
    () => [
      {
        id: "walletAddress",
        label: "Wallets",
        icon: Wallet,
        emptyMessage: "No wallets available",
        items: wallets,
        renderOption: (address) => <RenderedAddressCell address={address as string} />,
      },
      {
        id: "symbol",
        label: "Tokens",
        icon: Coins,
        emptyMessage: "No tokens available",
        items: tokens,
        getValue: (option) => (option as TokenAmount).symbol,
        renderOption: (option) => <RenderedTokenCell token={option as TokenAmount} />,
      },
      {
        id: "chainId",
        label: "Chains",
        icon: Link,
        emptyMessage: "No chains available",
        items: chains,
        renderOption: (chain) => <RenderedChainCell chain={chain as string} />,
      },
    ],
    [chains, tokens, wallets],
  );

  const meta = React.useMemo(() => ({ priceFor, isPending, canSelectMore }), [priceFor, isPending, canSelectMore]);

  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    onSortingChange: setSorting,
    getSortedRowModel: getSortedRowModel(),
    onColumnFiltersChange: setColumnFilters,
    getFilteredRowModel: getFilteredRowModel(),
    onColumnVisibilityChange: setColumnVisibility,
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
      columnFilters,
      columnVisibility,
      rowSelection,
    },
  });

  // Navigate back to page 1 whenever the wallet/token/chain filters change.
  // We compare the *content* of `columnFilters`, not its array identity: the
  // filters pipeline re-creates that array on unrelated re-renders, so an
  // identity check would reset the page on every render (the bug
  // `autoResetPageIndex: false` exists to avoid). Only a real filter change
  // should move the user off their current page.
  const filterSignature = JSON.stringify(columnFilters);
  const lastFilterSignature = React.useRef(filterSignature);
  React.useEffect(() => {
    if (lastFilterSignature.current !== filterSignature) {
      lastFilterSignature.current = filterSignature;
      table.setPageIndex(0);
    }
  }, [filterSignature, table]);

  // Backstop for non-filter cases (a refresh returning fewer tokens, a page
  // size change): with `autoResetPageIndex` off the user could be stranded on
  // a now-empty page past the end, so fall back to page 1 there too.
  const pageIndex = table.getState().pagination.pageIndex;
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
  const priceForToken = priceFor as ((row: TokenAmount) => number | undefined) | undefined;
  // Grand total across every loaded token (ignores filters/selection).
  const totalUsd = data.reduce((sum, row) => sum + getUsdValue(row, priceForToken), 0);
  const filteredUsd = table
    .getFilteredRowModel()
    .rows.reduce((sum, row) => sum + getUsdValue(row.original, priceForToken), 0);
  const selectedRows = table.getSelectedRowModel().rows;
  const selectedUsd = selectedRows.reduce((sum, row) => sum + getUsdValue(row.original, priceForToken), 0);
  const hasSelection = selectedRows.length > 0;
  const hasActiveFilter = columnFilters.length > 0;

  const indicatorLabel = hasSelection ? "Selected: " : hasActiveFilter ? "Filtered: " : "Total: ";
  const indicatorUsd = hasSelection ? selectedUsd : hasActiveFilter ? filteredUsd : totalUsd;
  const showTotalTooltip = hasSelection || hasActiveFilter;

  // Function to clear all filters
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <WalletTableFilters setColumnFilters={setColumnFilters} filterConfigs={filterConfigs} />
        <div className="flex items-center gap-3 ml-auto">
          {showTotalTooltip ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="text-lg whitespace-nowrap text-muted-foreground cursor-default">
                  {indicatorLabel}
                  <span className="font-bold text-primary bg-primary-foreground">{formatFiat(indicatorUsd)}</span>
                </span>
              </TooltipTrigger>
              <TooltipContent>Total: {formatFiat(totalUsd)}</TooltipContent>
            </Tooltip>
          ) : (
            <span className="text-lg whitespace-nowrap text-muted-foreground">
              {indicatorLabel}
              <span className="font-bold text-primary bg-primary-foreground">{formatFiat(indicatorUsd)}</span>
            </span>
          )}
          {onRefresh ? (
            <Button variant="outline" size="icon" onClick={onRefresh} disabled={isRefreshing}>
              <RotateCw className={`h-4 w-4 ${isRefreshing ? "animate-spin" : ""}`} />
              <span className="sr-only">Refresh table data</span>
            </Button>
          ) : null}
        </div>
      </div>

      <DataGrid<TData>
        table={table}
        recordCount={data.length}
        isLoading={isRefreshing && data.length === 0}
        loadingMode="skeleton"
        emptyMessage="No tokens found"
        onRowClick={(rowData) => {
          const row = table.getRowModel().rows.find((r) => r.original === rowData);
          if (row && (row.getIsSelected() || canSelectMore)) {
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
        <DataGridContainer>
          <ScrollArea className="max-h-[calc(100vh-300px)]">
            <div className="min-w-5xl">
              <DataGridTable<TData> />
            </div>
            <ScrollBar orientation="vertical" />
            <ScrollBar orientation="horizontal" />
          </ScrollArea>
        </DataGridContainer>

        <div className="grid grid-cols-3 items-center gap-4 px-2 pt-1 pb-2">
          <p
            className={`text-sm whitespace-nowrap justify-self-start ${
              Object.keys(rowSelection).length >= MAX_SOURCE_TOKENS ? "text-amber-600" : "text-muted-foreground"
            }`}
          >
            {Object.keys(rowSelection).length} of {Math.min(MAX_SOURCE_TOKENS, data.length)} token(s) selected.
          </p>
          <DataGridPaginationNav className="justify-self-center" />
          <DataGridPaginationSize sizes={[10, 25, 50, 100]} className="justify-self-end" />
        </div>
      </DataGrid>
    </div>
  );
}
