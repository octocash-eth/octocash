import type {
  ColumnDef,
  ColumnFiltersState,
  RowSelectionState,
  SortingState,
  VisibilityState,
} from "@tanstack/react-table";
import {
  flexRender,
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
import { Button } from "../ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { emptyPixel, uniq } from "./utils";
import type { WalletTableFilterConfig } from "./wallet-table-filters";
import { WalletTableFilters } from "./wallet-table-filters";

interface DataTableProps<TData, TValue> {
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
      <AddressAvatar addressOrEns={address} size={16} />
      {formatAddress(address)}
    </div>
  );
}

function RenderedTokenCell({ token: { token, iconUrl } }: { token: { token: string; iconUrl?: string | null } }) {
  return (
    <div className="flex items-center gap-2">
      <img
        src={iconUrl ?? emptyPixel}
        onError={(e) => {
          e.currentTarget.src = emptyPixel;
        }}
        alt={token}
        className="w-4 h-4"
      />
      {token}
    </div>
  );
}

function RenderedChainCell({ chain }: { chain: string }) {
  return (
    <div className="flex items-center gap-2">
      <img
        src={`/chain-icons/${chain.toLowerCase().replace(/\s+/g, "-")}.svg`}
        alt={chain}
        className="w-4 h-4 rounded-full"
      />
      {chain}
    </div>
  );
}

export function DataTable<TData, TValue>({
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
        renderOption: (option) => <RenderedTokenCell token={option as { token: string; iconUrl: string }} />,
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
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => {
                  return (
                    <TableHead key={header.id}>
                      {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
                    </TableHead>
                  );
                })}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows?.length ? (
              table.getRowModel().rows.map((row) => (
                <TableRow key={row.id} data-state={row.getIsSelected() && "selected"}>
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={columns.length} className="h-24 text-center">
                  No results.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      <div className="flex items-center justify-end space-x-2 py-4">
        <div className="flex-1 text-sm text-muted-foreground">
          {table.getFilteredSelectedRowModel().rows.length} of {table.getFilteredRowModel().rows.length} row(s)
          selected.
        </div>
        <div className="space-x-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => table.previousPage()}
            disabled={!table.getCanPreviousPage()}
          >
            Previous
          </Button>
          <Button variant="outline" size="sm" onClick={() => table.nextPage()} disabled={!table.getCanNextPage()}>
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}
