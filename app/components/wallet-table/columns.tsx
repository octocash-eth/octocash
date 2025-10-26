import type { ColumnDef } from "@tanstack/react-table";
import { ExternalLink, MoreHorizontal } from "lucide-react";
import { type Address, zeroAddress } from "viem";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { DataGridColumnHeader } from "~/components/ui/data-grid-column-header";
import { Skeleton } from "~/components/ui/skeleton";

import { supportedChains } from "~/data/supported-chains";
import { ChainIcon } from "../chain-icon";
import {
  AddressDisplayAvatar,
  AddressDisplayLink,
  AddressDisplayRoot,
  AddressDisplayText,
} from "../ui/address-display";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import {
  TokenDisplayIcon,
  TokenDisplayLink,
  TokenDisplayName,
  TokenDisplayRoot,
  TokenDisplaySymbol,
} from "../ui/token-display";

export type WalletData = {
  id: string;
  wallet: Address;
  token: string;
  tokenName: string;
  tokenAddress: Address;
  chain: string;
  amount: string;
  amountInUsd: number;
  amountToConsolidate?: string;
  iconUrl?: string;
  decimals: number;
};

function getExplorerUrl(chainName: string, tokenAddress: string | undefined, address: string): string {
  const chain = supportedChains.find((chain) => chain.name === chainName);
  if (!chain) {
    return "";
  }
  if (!tokenAddress || tokenAddress === zeroAddress) {
    return `${chain.explorerUrl}/address/${address}`;
  }
  return `${chain.explorerUrl}/token/${tokenAddress}?a=${address}`;
}

export const columns: ColumnDef<WalletData>[] = [
  {
    id: "select",
    size: 20,
    header: ({ table }) => (
      <Checkbox
        checked={table.getIsAllPageRowsSelected() || (table.getIsSomePageRowsSelected() && "indeterminate")}
        onCheckedChange={(value) => table.toggleAllPageRowsSelected(!!value)}
        aria-label="Select all"
      />
    ),
    cell: ({ row }) => (
      <Checkbox
        checked={row.getIsSelected()}
        onCheckedChange={(value) => row.toggleSelected(!!value)}
        aria-label="Select row"
      />
    ),
    enableSorting: false,
    enableHiding: false,
    meta: {
      skeleton: <Skeleton className="h-4 w-4 rounded" />,
    },
  },
  {
    accessorKey: "token",
    size: 200,
    header: ({ column }) => <DataGridColumnHeader column={column} title="Token" />,
    cell: ({ row }) => {
      const tokenSymbol = row.getValue("token") as string;
      const tokenAddress = row.original.tokenAddress;
      const walletAddress = row.original.wallet;
      const chainName = row.getValue("chain") as string;
      const fullTokenName = row.original.tokenName || tokenSymbol;
      const chain = supportedChains.find((chain) => chain.name === chainName);
      const chainId = chain?.id;

      // If we don't have a token address, just show the token name
      if (!tokenAddress || !chainId) {
        return <div className="text-left">{tokenSymbol}</div>;
      }

      return (
        <div className="text-left">
          <TokenDisplayRoot
            tokenAddress={tokenAddress}
            chainId={chainId}
            symbol={tokenSymbol}
            fullName={fullTokenName}
            className="gap-1"
          >
            <TokenDisplayIcon className="size-4 md:size-5" />
            <TokenDisplayName className="truncate text-nowrap" />
            <span className="text-muted-foreground">
              <TokenDisplaySymbol />
            </span>
            <TokenDisplayLink walletAddress={walletAddress}>
              <ExternalLink className="h-3 w-3 ml-1" />
            </TokenDisplayLink>
          </TokenDisplayRoot>
        </div>
      );
    },
    filterFn: (row, id, value) => {
      const values = value as string[];
      if (values.length === 0) return true;
      return values.includes(row.getValue(id));
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
    accessorKey: "chain",
    size: 100,
    header: ({ column }) => <DataGridColumnHeader column={column} title="Chain" />,
    cell: ({ row }) => {
      const chainName = row.getValue("chain") as string;
      return (
        <div className="text-left flex items-center gap-2">
          <ChainIcon chain={chainName} className="size-4 md:size-5" />
          <span title={chainName} className="truncate text-nowrap">
            {chainName}
          </span>
        </div>
      );
    },
    filterFn: (row, id, value) => {
      const values = value as string[];
      if (values.length === 0) return true;
      return values.includes(row.getValue(id));
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
    accessorKey: "wallet",
    size: 150,
    header: ({ column }) => <DataGridColumnHeader column={column} title="Wallet" />,
    cell: ({ row }) => {
      const walletAddress = row.getValue("wallet") as string;
      const chainName = row.getValue("chain") as string;
      const chain = supportedChains.find((chain) => chain.name === chainName);
      const chainId = chain?.id;

      return (
        <div className="font-medium text-left">
          <AddressDisplayRoot address={walletAddress} chainId={chainId}>
            <AddressDisplayAvatar className="size-4 md:size-5" />
            <AddressDisplayText />
            <AddressDisplayLink />
          </AddressDisplayRoot>
        </div>
      );
    },
    filterFn: (row, id, value) => {
      const values = value as string[];
      if (values.length === 0) return true;
      return values.includes(row.getValue(id));
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
        <DataGridColumnHeader column={column} title="Amount" className="-ms-0 me-0" />
      </div>
    ),
    cell: ({ row }) => {
      const amount = parseFloat(row.getValue("amount"));

      // Format with appropriate decimal places based on the value
      const formatAmount = (value: number) => {
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
      };

      return <div className="text-right font-medium">{formatAmount(amount)}</div>;
    },
    meta: {
      skeleton: <Skeleton className="h-4 w-20 ml-auto" />,
    },
  },
  {
    accessorKey: "amountInUsd",
    size: 100,
    header: ({ column }) => (
      <div className="flex justify-end -me-7">
        <DataGridColumnHeader column={column} title="In USD" className="-ms-0 me-0" />
      </div>
    ),
    cell: ({ row }) => {
      const amount = parseFloat(row.getValue("amountInUsd"));
      if (amount <= 0) {
        return <div className="text-right font-medium text-muted-foreground">-</div>;
      }

      const formatted = new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(amount);

      return <div className="text-right font-medium">{formatted}</div>;
    },
    meta: {
      skeleton: <Skeleton className="h-4 w-16 ml-auto" />,
    },
  },
  {
    id: "actions",
    size: 70,
    cell: ({ row }) => {
      const wallet = row.original;
      const addressToCopy = wallet.wallet;

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
              <DropdownMenuItem onClick={() => navigator.clipboard.writeText(addressToCopy)}>
                Copy wallet address
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem>View details</DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => {
                  const tokenAddress = row.original.tokenAddress;
                  const chainName = row.getValue("chain") as string;
                  if (tokenAddress) {
                    window.open(getExplorerUrl(chainName, tokenAddress, wallet.wallet), "_blank");
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
