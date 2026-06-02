import type { Column, ColumnDef } from "@tanstack/react-table";
import { MoreHorizontal } from "lucide-react";
import { formatUnits, zeroAddress } from "viem";
import {
  AddressDisplayAvatar,
  AddressDisplayCopy,
  AddressDisplayLink,
  AddressDisplayRoot,
  AddressDisplayText,
} from "~/components/address";
import {
  TokenDisplayAmount,
  TokenDisplayCopy,
  TokenDisplayIcon,
  TokenDisplayLink,
  TokenDisplayName,
  TokenDisplayRoot,
  TokenDisplaySymbol,
} from "~/components/token";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { DataGridColumnHeader } from "~/components/ui/data-grid-column-header";
import { Skeleton } from "~/components/ui/skeleton";
import { useFormatFiat, useSelectedCurrency } from "~/context/currency-provider";
import { supportedChains } from "~/data/supported-chains";
import { getChainName } from "~/lib/tokens";
import type { TokenAmount } from "~/lib/types";
import { ChainIcon } from "../chain/chain-icon";
import { ButtonGroup } from "../ui/button-group";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";

/**
 * Header for the value column. Reflects the user's selected fiat currency
 * (e.g. "In USD", "In EUR") so the column label stays in sync with the rest
 * of the table.
 */
function ValueColumnHeader({ column }: { column: Column<TokenAmount> }) {
  const { currency } = useSelectedCurrency();
  return (
    <div className="flex justify-end -me-7">
      <DataGridColumnHeader column={column} title={`In ${currency.code}`} className="ms-0 me-0" />
    </div>
  );
}

/**
 * Computes the row's USD value for both the cell render and the column's
 * sort comparator, so the two stay in lockstep. Falls back to 0 when no
 * price is known yet — same as the cell's "—" rendering — which keeps
 * priceless rows sortable as the bottom of an ascending sort.
 */
export function getUsdValue(token: TokenAmount, priceFor?: (row: TokenAmount) => number | undefined): number {
  const price = priceFor?.(token);
  if (price === undefined) return 0;
  const formattedAmount = Number(formatUnits(token.amount, token.decimals));
  return price * formattedAmount;
}

/**
 * Cell that converts the row's USD value to the user's selected fiat
 * currency. Renders a skeleton while the price is loading, an em-dash when
 * the row is worth effectively nothing, and the formatted amount otherwise.
 */
function ValueCell({
  row,
  priceFor,
  isPending,
}: {
  row: { original: TokenAmount };
  priceFor?: (row: TokenAmount) => number | undefined;
  isPending?: (row: TokenAmount) => boolean;
}) {
  const formatFiat = useFormatFiat();
  const price = priceFor?.(row.original);
  const pending = isPending?.(row.original) ?? false;

  if (price === undefined && pending) {
    return <Skeleton className="h-4 w-16 ml-auto" />;
  }

  const usd = getUsdValue(row.original, priceFor);
  if (usd <= 0) {
    return <div className="text-right font-medium text-muted-foreground">-</div>;
  }
  return <div className="text-right font-medium">{formatFiat(usd)}</div>;
}

function getExplorerUrl(chainId: number, tokenAddress: string | undefined, walletAddress: string): string {
  const chain = supportedChains.find((c) => c.id === chainId);
  if (!chain) {
    return "";
  }
  if (!tokenAddress || tokenAddress === zeroAddress) {
    return `${chain.explorerUrl}/address/${walletAddress}`;
  }
  return `${chain.explorerUrl}/token/${tokenAddress}?a=${walletAddress}`;
}

/**
 * Builds the wallet table's column defs.
 *
 * The value column ("In USD/EUR/...") is computed from a live `priceFor`
 * lookup, so its `sortingFn` needs the same lookup in closure scope —
 * TanStack's `SortingFn` signature `(rowA, rowB, columnId) => number` does
 * not pass `meta` through. Callers (re)build columns whenever `priceFor`
 * changes so the table re-sorts as prices stream in.
 */
export function buildColumns(priceFor?: (row: TokenAmount) => number | undefined): ColumnDef<TokenAmount>[] {
  return [
    {
      id: "select",
      size: 20,
      header: ({ table }) => {
        const canSelectMore = table.options.meta?.canSelectMore ?? true;
        const allSelected = table.getIsAllPageRowsSelected();
        const someSelected = table.getIsSomePageRowsSelected();
        return (
          <Checkbox
            checked={allSelected || (someSelected && "indeterminate")}
            disabled={!canSelectMore && !allSelected && !someSelected}
            onCheckedChange={(value) => table.toggleAllPageRowsSelected(!!value)}
            aria-label="Select all"
          />
        );
      },
      cell: ({ row, table }) => {
        const canSelectMore = table.options.meta?.canSelectMore ?? true;
        const isSelected = row.getIsSelected();
        return (
          <Checkbox
            checked={isSelected}
            disabled={!isSelected && !canSelectMore}
            onCheckedChange={(value) => row.toggleSelected(!!value)}
            aria-label="Select row"
          />
        );
      },
      enableSorting: false,
      enableHiding: false,
      meta: {
        skeleton: <Skeleton className="h-4 w-4 rounded" />,
      },
    },
    {
      accessorKey: "symbol",
      size: 200,
      header: ({ column }) => <DataGridColumnHeader column={column} title="Token" />,
      cell: ({ row }) => {
        const token = row.original;
        const tokenName = token.name || token.symbol;

        // If we don't have a token address, just show the token symbol
        if (!token.token || !token.chainId) {
          return <div className="text-left">{token.symbol}</div>;
        }

        return (
          <div className="text-left">
            <TokenDisplayRoot
              tokenAddress={token.token}
              chainId={token.chainId}
              symbol={token.symbol}
              name={tokenName}
              className="gap-1"
            >
              <TokenDisplayIcon className="size-4 md:size-5" />
              <TokenDisplayName className="truncate text-nowrap" />
              <span className="text-muted-foreground">
                <TokenDisplaySymbol />
              </span>
              <ButtonGroup>
                <TokenDisplayCopy />
                <TokenDisplayLink walletAddress={token.walletAddress} />
              </ButtonGroup>
            </TokenDisplayRoot>
          </div>
        );
      },
      filterFn: (row, _id, value) => {
        const values = value as string[];
        if (values.length === 0) return true;
        return values.includes(row.original.symbol);
      },
      meta: {
        skeleton: (
          <div className="flex items-center gap-1">
            <Skeleton className="h-6 w-6 rounded-full" />
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-4 w-12" />
          </div>
        ),
      },
    },
    {
      accessorKey: "chainId",
      size: 100,
      header: ({ column }) => <DataGridColumnHeader column={column} title="Chain" />,
      cell: ({ row }) => {
        const chainName = getChainName(row.original.chainId);
        return (
          <div className="text-left flex items-center gap-2">
            <ChainIcon chain={chainName} className="size-4 md:size-5" />
            <span title={chainName} className="truncate text-nowrap">
              {chainName}
            </span>
          </div>
        );
      },
      filterFn: (row, _id, value) => {
        const values = value as string[];
        if (values.length === 0) return true;
        const chainName = getChainName(row.original.chainId);
        return values.includes(chainName);
      },
      meta: {
        skeleton: (
          <div className="flex items-center gap-2">
            <Skeleton className="h-6 w-6 rounded-full" />
            <Skeleton className="h-4 w-24" />
          </div>
        ),
      },
    },
    {
      accessorKey: "walletAddress",
      size: 150,
      header: ({ column }) => <DataGridColumnHeader column={column} title="Wallet" />,
      cell: ({ row }) => {
        const token = row.original;

        return (
          <div className="font-medium text-left">
            <AddressDisplayRoot address={token.walletAddress} chainId={token.chainId}>
              <AddressDisplayAvatar className="size-4 md:size-5" />
              <AddressDisplayText />
              <ButtonGroup>
                <AddressDisplayCopy />
                <AddressDisplayLink />
              </ButtonGroup>
            </AddressDisplayRoot>
          </div>
        );
      },
      filterFn: (row, _id, value) => {
        const values = value as string[];
        if (values.length === 0) return true;
        return values.includes(row.original.walletAddress);
      },
      meta: {
        skeleton: (
          <div className="flex items-center gap-2">
            <Skeleton className="size-5 rounded-full" />
            <Skeleton className="h-4 w-32" />
          </div>
        ),
      },
    },
    {
      accessorKey: "amount",
      size: 70,
      header: ({ column }) => (
        <div className="flex justify-end -me-7">
          <DataGridColumnHeader column={column} title="Amount" className="ms-0 me-0" />
        </div>
      ),
      cell: ({ row }) => {
        const token = row.original;
        return (
          <div className="text-right font-medium">
            <TokenDisplayRoot
              tokenAddress={token.token}
              chainId={token.chainId}
              symbol={token.symbol}
              decimals={token.decimals}
            >
              <TokenDisplayAmount amount={token.amount} />
            </TokenDisplayRoot>
          </div>
        );
      },
      meta: {
        skeleton: <Skeleton className="h-4 w-20 ml-auto" />,
      },
    },
    {
      id: "amountInUsd",
      // `accessorFn` is required for `column.getCanSort()` to return true —
      // TanStack treats columns without an accessor as display-only and
      // refuses to sort them, regardless of `enableSorting`. The numeric
      // value we return is also what the default `basic` sorting compares.
      accessorFn: (row) => getUsdValue(row, priceFor),
      size: 100,
      enableSorting: true,
      header: ({ column }) => <ValueColumnHeader column={column} />,
      cell: ({ row, table }) => {
        const meta = table.options.meta;
        return <ValueCell row={row} priceFor={meta?.priceFor} isPending={meta?.isPending} />;
      },
      sortingFn: "basic",
      meta: {
        skeleton: <Skeleton className="h-4 w-16 ml-auto" />,
      },
    },
    {
      id: "actions",
      size: 70,
      cell: ({ row }) => {
        const token = row.original;

        return (
          <div className="text-right">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" className="h-8 w-8 p-0">
                  <span className="sr-only">Open menu</span>
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>Actions</DropdownMenuLabel>
                <DropdownMenuItem onClick={() => navigator.clipboard.writeText(token.walletAddress)}>
                  Copy wallet address
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem>View details</DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => {
                    if (token.token) {
                      window.open(getExplorerUrl(token.chainId, token.token, token.walletAddress), "_blank");
                    }
                  }}
                >
                  View on explorer
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        );
      },
      meta: {
        skeleton: <Skeleton className="h-8 w-8 rounded ml-auto" />,
      },
    },
  ];
}
