import { MoreHorizontal } from "lucide-react";
import type * as React from "react";
import { zeroAddress } from "viem";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { supportedChains } from "~/data/supported-chains";
import type { TokenAmount } from "~/lib/types";

export function getExplorerUrl(chainId: number, tokenAddress: string | undefined, walletAddress: string): string {
  const chain = supportedChains.find((c) => c.id === chainId);
  if (!chain) {
    return "";
  }
  if (!tokenAddress || tokenAddress === zeroAddress) {
    return `${chain.explorerUrl}/address/${walletAddress}`;
  }
  return `${chain.explorerUrl}/token/${tokenAddress}?a=${walletAddress}`;
}

interface TokenActionsMenuProps {
  token: TokenAmount;
  trigger?: React.ReactNode;
}

/**
 * The row actions menu shared by the desktop table column and the mobile card
 * list, so both surfaces expose the exact same actions. Pass `trigger` to
 * override the default "three dots" button.
 */
export function TokenActionsMenu({ token, trigger }: TokenActionsMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {trigger ?? (
          <Button variant="ghost" className="h-8 w-8 p-0">
            <span className="sr-only">Open menu</span>
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        )}
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
  );
}
