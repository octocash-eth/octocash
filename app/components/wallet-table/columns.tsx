import type { ColumnDef } from "@tanstack/react-table";
import { ExternalLink, MoreHorizontal } from "lucide-react";
import { type Address, zeroAddress } from "viem";
import { useEnsName } from "wagmi";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { DataGridColumnHeader } from "~/components/ui/data-grid-column-header";
import { Skeleton } from "~/components/ui/skeleton";

import { supportedChains } from "~/data/supported-chains";
import { cn, formatAddress } from "~/lib/utils";
import AddressAvatar from "../address-avatar";
import { ChainIcon } from "../chain-icon";
import { TokenIcon } from "../token-icon";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";

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
      const tokenName = row.getValue("token") as string;
      const tokenAddress = row.original.tokenAddress;
      const chainName = row.getValue("chain") as string;
      const fullTokenName = row.original.tokenName || tokenName;
      const walletAddress = row.original.wallet;

      // If we don't have a token address, just show the token name
      if (!tokenAddress) {
        return <div className="text-left">{tokenName}</div>;
      }

      // Get the explorer URL for this token
      const explorerUrl = getExplorerUrl(chainName, tokenAddress, walletAddress);

      return (
        <div className="text-left flex items-center gap-1">
          <TokenIcon token={row.original.token} iconUrl={row.original.iconUrl} className="size-4 md:size-5" />
          <span title={fullTokenName} className="truncate text-nowrap">
            {fullTokenName}
          </span>
          <span className="text-muted-foreground">{tokenName}</span>
          <a
            href={explorerUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-500 hover:text-blue-700 inline-flex items-center"
            title={`View on block explorer`}
          >
            <ExternalLink className="h-3 w-3 ml-1" />
          </a>
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
      const explorerUrl = getExplorerUrl(chainName, undefined, walletAddress);
      return (
        <div className="font-medium text-left flex items-center gap-2">
          <AddressAvatar addressOrEns={row.getValue("wallet") as string} className="size-4 md:size-5" />
          <AddressDisplay address={row.getValue("wallet")} />
          <a
            href={explorerUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-500 hover:text-blue-700 inline-flex items-center"
            title={`View on block explorer`}
          >
            <ExternalLink className="h-3 w-3 ml-1" />
          </a>
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

function AddressDisplay({ address, className }: { address: Address; className?: string }) {
  const { data: ensName } = useEnsName({ address, chainId: 1 });
  const shortAddress = formatAddress(address);
  return (
    <span className={cn("truncate text-nowrap", className)} title={ensName || shortAddress}>
      {ensName || shortAddress}
    </span>
  );
}
