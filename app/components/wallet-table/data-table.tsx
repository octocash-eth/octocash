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
import { supportedChains } from "~/data/supported-chains";
import { ChainIcon } from "../chain-icon";
import { AddressDisplayAvatar, AddressDisplayRoot, AddressDisplayText } from "../ui/address-display";
import { Button } from "../ui/button";
import { DataGrid, DataGridContainer } from "../ui/data-grid";
import { DataGridPagination } from "../ui/data-grid-pagination";
import { DataGridTable } from "../ui/data-grid-table";
import { ScrollArea, ScrollBar } from "../ui/scroll-area";
import { TokenDisplayIcon, TokenDisplayRoot, TokenDisplaySymbol } from "../ui/token-display";
import { uniq } from "./utils";
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
}

function RenderedAddressCell({ address }: { address: string }) {
  return (
    <AddressDisplayRoot address={address}>
      <AddressDisplayAvatar className="size-4" />
      <AddressDisplayText />
    </AddressDisplayRoot>
  );
}

function RenderedTokenCell({
  token: { token, tokenAddress, chain },
}: {
  token: { token: string; tokenAddress?: string; chain?: string };
}) {
  // Map chain name to chainId
  const chainId = React.useMemo(() => {
    if (!chain) return undefined;
    const foundChain = supportedChains.find((c) => c.name === chain);
    return foundChain?.id;
  }, [chain]);

  // Fallback for cases where tokenAddress/chainId might not be available
  if (!tokenAddress || !chainId) {
    return <div className="flex items-center gap-2">{token}</div>;
  }

  return (
    <TokenDisplayRoot tokenAddress={tokenAddress} chainId={chainId} symbol={token} className="gap-2">
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

export function DataTable<TData extends object, TValue>({
  columns,
  data,
  rowSelection,
  onRowSelectionChange,
  onRefresh,
  isRefreshing = false,
}: DataTableProps<TData, TValue>) {
  const [sorting, setSorting] = React.useState<SortingState>([]);
  const [columnFilters, setColumnFilters] = React.useState<ColumnFiltersState>([]);
  const [columnVisibility, setColumnVisibility] = React.useState<VisibilityState>({});

  // Unique wallets
  const wallets = React.useMemo(() => {
    return uniq(data, "wallet");
  }, [data]);

  // Unique tokens
  const tokens = React.useMemo(() => {
    return uniq(data, "token", ["token", "tokenAddress", "chain"]);
  }, [data]);

  // Unique chains
  const chains = React.useMemo(() => {
    return uniq(data, "chain");
  }, [data]);

  // Filter configs
  const filterConfigs = React.useMemo<ReadonlyArray<WalletTableFilterConfig<TData, unknown>>>(
    () => [
      {
        id: "wallet",
        label: "Wallets",
        icon: Wallet,
        emptyMessage: "No wallets available",
        items: wallets,
        renderOption: (address) => <RenderedAddressCell address={address as string} />,
      },
      {
        id: "token",
        label: "Tokens",
        icon: Coins,
        emptyMessage: "No tokens available",
        items: tokens,
        getValue: (option) => (option as { token: string }).token,
        renderOption: (option) => (
          <RenderedTokenCell token={option as { token: string; tokenAddress?: string; chain?: string }} />
        ),
      },
      {
        id: "chain",
        label: "Chains",
        icon: Link,
        emptyMessage: "No chains available",
        items: chains,
        renderOption: (chain) => <RenderedChainCell chain={chain as string} />,
      },
    ],
    [chains, tokens, wallets],
  );

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
    state: {
      sorting,
      columnFilters,
      columnVisibility,
      rowSelection,
    },
  });

  // Function to clear all filters
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <WalletTableFilters setColumnFilters={setColumnFilters} filterConfigs={filterConfigs} />
        {onRefresh ? (
          <Button variant="outline" size="icon" onClick={onRefresh} className="ml-auto" disabled={isRefreshing}>
            <RotateCw className={`h-4 w-4 ${isRefreshing ? "animate-spin" : ""}`} />
            <span className="sr-only">Refresh table data</span>
          </Button>
        ) : null}
      </div>

      <DataGrid<TData>
        table={table}
        recordCount={data.length}
        isLoading={isRefreshing}
        loadingMode="skeleton"
        emptyMessage="No tokens found"
        onRowClick={(rowData) => {
          const row = table.getRowModel().rows.find((r) => r.original === rowData);
          if (row) {
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

        <div className="flex items-center justify-between px-2 py-4">
          <DataGridPagination sizes={[10, 25, 50, 100]} />
        </div>
      </DataGrid>
    </div>
  );
}
