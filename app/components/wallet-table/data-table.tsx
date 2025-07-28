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
import { Coins, Filter, Link, Wallet } from "lucide-react";
import * as React from "react";
import { Button } from "../ui/button";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuTrigger } from "../ui/dropdown-menu";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { formatAddress } from "~/lib/utils";

interface DataTableProps<TData, TValue> {
  columns: ColumnDef<TData, TValue>[];
  data: TData[];
  connectedAddresses?: readonly string[];
  onRowSelectionChange?: (value: RowSelectionState) => void;
}

export function DataTable<TData, TValue>({ columns, data, onRowSelectionChange }: DataTableProps<TData, TValue>) {
  const [sorting, setSorting] = React.useState<SortingState>([]);
  const [columnFilters, setColumnFilters] = React.useState<ColumnFiltersState>([]);
  const [columnVisibility, setColumnVisibility] = React.useState<VisibilityState>({});
  const [rowSelection, setRowSelection] = React.useState<RowSelectionState>({});
  const [selectedAddresses, setSelectedAddresses] = React.useState<string[]>([]);
  const [selectedTokens, setSelectedTokens] = React.useState<string[]>([]);
  const [selectedChains, setSelectedChains] = React.useState<string[]>([]);

  // Get unique wallet addresses from the data
  const uniqueWallets = React.useMemo(() => {
    const wallets = new Set<string>();
    data.forEach((item: TData) => {
      if ((item as { wallet: string }).wallet) {
        wallets.add((item as { wallet: string }).wallet);
      }
    });
    return Array.from(wallets);
  }, [data]);

  // Get unique tokens from the data
  const uniqueTokens = React.useMemo(() => {
    const tokens = new Set<string>();
    data.forEach((item: TData) => {
      if ((item as { token: string }).token) {
        tokens.add((item as { token: string }).token);
      }
    });
    return Array.from(tokens);
  }, [data]);

  // Get unique chains from the data
  const uniqueChains = React.useMemo(() => {
    const chains = new Set<string>();
    data.forEach((item: TData) => {
      if ((item as { chain: string }).chain) {
        chains.add((item as { chain: string }).chain);
      }
    });
    return Array.from(chains);
  }, [data]);

  // Update filters when selected addresses change
  React.useEffect(() => {
    if (selectedAddresses.length === 0) {
      // If no addresses selected, clear the filter
      setColumnFilters(columnFilters.filter((filter) => filter.id !== "wallet"));
    } else {
      // Set filter to show only selected addresses
      setColumnFilters((prev) => {
        const filtered = prev.filter((filter) => filter.id !== "wallet");
        return [
          ...filtered,
          {
            id: "wallet",
            value: selectedAddresses,
          },
        ];
      });
    }
  }, [selectedAddresses, columnFilters.filter]);

  // Update filters when selected tokens change
  React.useEffect(() => {
    if (selectedTokens.length === 0) {
      // If no tokens selected, clear the filter
      setColumnFilters(columnFilters.filter((filter) => filter.id !== "token"));
    } else {
      // Set filter to show only selected tokens
      setColumnFilters((prev) => {
        const filtered = prev.filter((filter) => filter.id !== "token");
        return [
          ...filtered,
          {
            id: "token",
            value: selectedTokens,
          },
        ];
      });
    }
  }, [selectedTokens, columnFilters.filter]);

  // Update filters when selected chains change
  React.useEffect(() => {
    if (selectedChains.length === 0) {
      // If no chains selected, clear the filter
      setColumnFilters(columnFilters.filter((filter) => filter.id !== "chain"));
    } else {
      // Set filter to show only selected chains
      setColumnFilters((prev) => {
        const filtered = prev.filter((filter) => filter.id !== "chain");
        return [
          ...filtered,
          {
            id: "chain",
            value: selectedChains,
          },
        ];
      });
    }
  }, [selectedChains, columnFilters.filter]);

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
  const clearAllFilters = () => {
    setSelectedAddresses([]);
    setSelectedTokens([]);
    setSelectedChains([]);
    // Directly clear all column filters related to our filter types
    setColumnFilters((prev) =>
      prev.filter((filter) => filter.id !== "wallet" && filter.id !== "token" && filter.id !== "chain"),
    );
  };

  // Check if any filters are active
  const hasActiveFilters = selectedAddresses.length > 0 || selectedTokens.length > 0 || selectedChains.length > 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-2 flex-1">
          <span className="text-sm font-medium">
            <Filter className="h-4 w-4 inline-block mr-1" />
            Filter by
          </span>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="flex gap-2">
                <Wallet className="h-4 w-4" />
                Wallets
                {selectedAddresses.length > 0 && (
                  <span className="ml-1 rounded-full bg-primary text-primary-foreground px-2 py-0.5 text-xs">
                    {selectedAddresses.length}
                  </span>
                )}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56">
              {uniqueWallets.length > 0 ? (
                uniqueWallets.map((address) => (
                  <DropdownMenuCheckboxItem
                    key={address}
                    checked={selectedAddresses.includes(address)}
                    onCheckedChange={(checked) => {
                      if (checked) {
                        setSelectedAddresses([...selectedAddresses, address]);
                      } else {
                        setSelectedAddresses(selectedAddresses.filter((a) => a !== address));
                      }
                    }}
                  >
                    {formatAddress(address)}
                  </DropdownMenuCheckboxItem>
                ))
              ) : (
                <div className="px-2 py-1.5 text-sm text-muted-foreground">No wallets available</div>
              )}

              <Button
                disabled={selectedAddresses.length === 0}
                variant="ghost"
                size="sm"
                className="w-full mt-2 text-xs"
                onClick={() => {
                  setSelectedAddresses([]);
                  // Directly clear wallet filter
                  setColumnFilters((prev) => prev.filter((filter) => filter.id !== "wallet"));
                }}
              >
                Clear
              </Button>
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="flex gap-2">
                <Coins className="h-4 w-4" />
                Tokens
                {selectedTokens.length > 0 && (
                  <span className="ml-1 rounded-full bg-primary text-primary-foreground px-2 py-0.5 text-xs">
                    {selectedTokens.length}
                  </span>
                )}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56">
              {uniqueTokens.length > 0 ? (
                uniqueTokens.map((token) => (
                  <DropdownMenuCheckboxItem
                    key={token}
                    checked={selectedTokens.includes(token)}
                    onCheckedChange={(checked) => {
                      if (checked) {
                        setSelectedTokens([...selectedTokens, token]);
                      } else {
                        setSelectedTokens(selectedTokens.filter((t) => t !== token));
                      }
                    }}
                  >
                    {token}
                  </DropdownMenuCheckboxItem>
                ))
              ) : (
                <div className="px-2 py-1.5 text-sm text-muted-foreground">No tokens available</div>
              )}
              <Button
                disabled={selectedTokens.length === 0}
                variant="ghost"
                size="sm"
                className="w-full mt-2 text-xs"
                onClick={() => {
                  setSelectedTokens([]);
                  // Directly clear token filter
                  setColumnFilters((prev) => prev.filter((filter) => filter.id !== "token"));
                }}
              >
                Clear
              </Button>
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="flex gap-2">
                <Link className="h-4 w-4" />
                Chains
                {selectedChains.length > 0 && (
                  <span className="ml-1 rounded-full bg-primary text-primary-foreground px-2 py-0.5 text-xs">
                    {selectedChains.length}
                  </span>
                )}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56">
              {uniqueChains.length > 0 ? (
                uniqueChains.map((chain) => (
                  <DropdownMenuCheckboxItem
                    key={chain}
                    checked={selectedChains.includes(chain)}
                    onCheckedChange={(checked) => {
                      if (checked) {
                        setSelectedChains([...selectedChains, chain]);
                      } else {
                        setSelectedChains(selectedChains.filter((c) => c !== chain));
                      }
                    }}
                  >
                    {chain}
                  </DropdownMenuCheckboxItem>
                ))
              ) : (
                <div className="px-2 py-1.5 text-sm text-muted-foreground">No chains available</div>
              )}
              <Button
                disabled={selectedChains.length === 0}
                variant="ghost"
                size="sm"
                className="w-full mt-2 text-xs"
                onClick={() => {
                  setSelectedChains([]);
                  // Directly clear chain filter
                  setColumnFilters((prev) => prev.filter((filter) => filter.id !== "chain"));
                }}
              >
                Clear
              </Button>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button disabled={!hasActiveFilters} variant="ghost" size="sm" onClick={clearAllFilters} className="text-xs">
            Clear all
          </Button>
        </div>
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
