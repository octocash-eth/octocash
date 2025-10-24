import type {
  ColumnDef,
  ColumnFiltersState,
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
import { Coins, Link, RotateCcw, Wallet } from "lucide-react";
import * as React from "react";
import { formatAddress } from "~/lib/utils";
import AddressAvatar from "../address-avatar";
import { ChainIcon } from "../chain-icon";
import { TokenIcon } from "../token-icon";
import { Button } from "../ui/button";
import { DataGrid, DataGridContainer } from "../ui/data-grid";
import { DataGridPagination } from "../ui/data-grid-pagination";
import { DataGridTable } from "../ui/data-grid-table";
import { ScrollArea, ScrollBar } from "../ui/scroll-area";
import { uniq } from "./utils";
import type { WalletTableFilterConfig } from "./wallet-table-filters";
import { WalletTableFilters } from "./wallet-table-filters";

interface DataTableProps<TData extends object, TValue> {
  columns: ColumnDef<TData, TValue>[];
  data: TData[];
  connectedAddresses?: readonly string[];
  onRowSelectionChange?: (value: RowSelectionState) => void;
  onRefresh?: () => void;
  isRefreshing?: boolean;
}

function RenderedAddressCell({ address }: { address: string }) {
  return (
    <div className="flex items-center gap-2">
      <AddressAvatar addressOrEns={address} className="size-4" />
      {formatAddress(address)}
    </div>
  );
}

function RenderedTokenCell({ token: { token, iconUrl } }: { token: { token: string; iconUrl?: string } }) {
  return (
    <div className="flex items-center gap-2">
      <TokenIcon token={token} iconUrl={iconUrl} className="size-4" />
      {token}
    </div>
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
  onRowSelectionChange,
  onRefresh,
  isRefreshing = false,
}: DataTableProps<TData, TValue>) {
  const [sorting, setSorting] = React.useState<SortingState>([]);
  const [columnFilters, setColumnFilters] = React.useState<ColumnFiltersState>([]);
  const [columnVisibility, setColumnVisibility] = React.useState<VisibilityState>({});
  const [rowSelection, setRowSelection] = React.useState<RowSelectionState>({});

  // Unique wallets
  const wallets = React.useMemo(() => {
    return uniq(data, "wallet");
  }, [data]);

  // Unique tokens
  const tokens = React.useMemo(() => {
    return uniq(data, "token", ["token", "iconUrl"]);
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
        renderOption: (option) => <RenderedTokenCell token={option as { token: string; iconUrl?: string }} />,
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

  // Update parent component when row selection changes
  React.useEffect(() => {
    if (onRowSelectionChange) {
      onRowSelectionChange(rowSelection);
    }
  }, [rowSelection, onRowSelectionChange]);

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
    onRowSelectionChange: setRowSelection,
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
            <RotateCcw className={`h-4 w-4 ${isRefreshing ? "animate-spin" : ""}`} />
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
        tableLayout={{
          headerSticky: true,
          headerBackground: false,
          striped: false,
          cellBorder: false,
          rowBorder: false,
          width: "fixed",
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
