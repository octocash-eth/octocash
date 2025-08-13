import type { ColumnDef } from "@tanstack/react-table";
import { ArrowUpDown, ExternalLink, MoreHorizontal } from "lucide-react";
import * as React from "react";
import { type Address, zeroAddress } from "viem";
import { useEnsName } from "wagmi";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";

import { supportedChains } from "~/data/supported-chains";
import { formatAddress } from "~/lib/utils";
import AddressAvatar from "../address-avatar";
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

// Format the amount for display in the input
function formatAmountForInput(value: number): string {
  if (value >= 1000) {
    return value.toFixed(2);
  } else if (value >= 1) {
    return value.toFixed(4);
  } else {
    return value.toFixed(6);
  }
}

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
  },
  {
    accessorKey: "token",
    header: ({ column }) => (
      <Button
        variant="ghost"
        onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
        className="text-left"
      >
        Token
        <ArrowUpDown className="ml-2 h-4 w-4" />
      </Button>
    ),
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
          <img src={row.original.iconUrl} alt={tokenName} className="w-6 h-6 rounded-full" />
          <span>{fullTokenName}</span>
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
  },
  {
    accessorKey: "chain",
    header: ({ column }) => (
      <Button
        variant="ghost"
        onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
        className="text-left"
      >
        Chain
        <ArrowUpDown className="ml-2 h-4 w-4" />
      </Button>
    ),
    cell: ({ row }) => {
      const chainName = row.getValue("chain") as string;
      const chainIcon = `/chain-icons/${chainName.toLowerCase().replace(/\s+/g, "-")}.svg`;
      return (
        <div className="text-left flex items-center gap-2">
          <img src={chainIcon} alt={chainName} className="w-6 h-6" />
          <span>{chainName}</span>
        </div>
      );
    },
    filterFn: (row, id, value) => {
      const values = value as string[];
      if (values.length === 0) return true;
      return values.includes(row.getValue(id));
    },
  },
  {
    accessorKey: "wallet",
    header: ({ column }) => (
      <Button
        variant="ghost"
        onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
        className="text-left"
      >
        Wallet
        <ArrowUpDown className="ml-2 h-4 w-4" />
      </Button>
    ),
    cell: ({ row }) => {
      const walletAddress = row.getValue("wallet") as string;
      const chainName = row.getValue("chain") as string;
      const explorerUrl = getExplorerUrl(chainName, undefined, walletAddress);
      return (
        <div className="font-medium text-left flex items-center gap-2">
          <AddressAvatar addressOrEns={row.getValue("wallet") as string} size={20} />
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
  },
  {
    accessorKey: "amount",
    header: ({ column }) => (
      <div className="text-right">
        <Button
          variant="ghost"
          onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
          className="text-right"
        >
          Amount
          <ArrowUpDown className="ml-2 h-4 w-4" />
        </Button>
      </div>
    ),
    cell: ({ row }) => {
      const amount = parseFloat(row.getValue("amount"));
      const isSelected = row.getIsSelected();
      const inputRef = React.useRef<HTMLInputElement>(null);

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

      // Set initial value when selected
      React.useEffect(() => {
        if (isSelected && inputRef.current) {
          inputRef.current.value = formatAmountForInput(amount);
        }
      }, [isSelected, amount]);

      // Handle click on the cell to select the row if not already selected
      const handleCellClick = () => {
        if (!isSelected) {
          row.toggleSelected(true);
        }
      };

      // Handle keyboard events for accessibility
      const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          handleCellClick();
        }
      };

      // Handle input change and validate range
      const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const newValue = parseFloat(e.target.value);
        let validatedValue = newValue;

        // Validate the range
        if (Number.isNaN(newValue) || newValue < 0) {
          validatedValue = 0;
          if (inputRef.current) {
            inputRef.current.value = "0";
          }
        } else if (newValue > amount) {
          validatedValue = amount;
          if (inputRef.current) {
            inputRef.current.value = formatAmountForInput(amount);
          }
        }

        // Create a custom event to notify about the change
        const event = new CustomEvent("amountToConsolidateChange", {
          detail: {
            rowId: row.id,
            value: validatedValue,
          },
        });
        document.dispatchEvent(event);
      };

      return (
        <button
          type="button"
          className="text-right font-medium flex items-center justify-end gap-2 cursor-pointer bg-transparent border-none p-0 w-full"
          onClick={handleCellClick}
          onKeyDown={handleKeyDown}
          aria-label={isSelected ? "Modify amount to consolidate" : "Select row to set amount to consolidate"}
        >
          {isSelected ? (
            <>
              <Input
                ref={inputRef}
                type="number"
                defaultValue={formatAmountForInput(amount)}
                onChange={handleInputChange}
                className="w-20 h-8 text-right"
                min="0"
                max={amount.toString()}
                step="0.000001"
                // Stop propagation to prevent the cell click handler from firing
                onClick={(e) => e.stopPropagation()}
              />
              <span className="text-muted-foreground">/</span>
            </>
          ) : (
            <>
              <span className="text-muted-foreground w-20 text-right">0</span>
              <span className="text-muted-foreground">/</span>
            </>
          )}
          <span>{formatAmount(amount)}</span>
        </button>
      );
    },
  },
  {
    accessorKey: "amountInUsd",
    header: ({ column }) => (
      <div className="text-right">
        <Button
          variant="ghost"
          onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
          className="text-right"
        >
          Amount in USD
          <ArrowUpDown className="ml-2 h-4 w-4" />
        </Button>
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
  },
  {
    id: "actions",
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
  },
];

function AddressDisplay({ address }: { address: Address }) {
  const { data: ensName } = useEnsName({ address, chainId: 1 });
  const shortAddress = formatAddress(address);
  return <span>{ensName || shortAddress}</span>;
}
