import { zeroAddress } from "viem";
import { AddressDisplayAvatar, AddressDisplayRoot, AddressDisplayText } from "~/components/address";
import { ChainIcon } from "~/components/chain/chain-icon";
import { usePrice } from "~/context/token-price-provider";
import { chains } from "~/data/supported-chains";
import { useToken } from "~/hooks/use-token";
import type { TokenAmount } from "~/lib/types";
import {
  TokenDisplayAmount,
  TokenDisplayFiat,
  TokenDisplayIcon,
  TokenDisplayRoot,
  TokenDisplaySymbol,
} from "./token-display";

interface TokenCardProps {
  token: TokenAmount;
  label?: string;
}

export function TokenCard({ token, label }: TokenCardProps) {
  const { data: tokenData } = useToken({
    address: token.token,
    chainId: token.chainId,
    query: {
      enabled: token.token !== zeroAddress,
    },
  });
  const { price } = usePrice(token.chainId, token.token);

  if (token.token !== zeroAddress && !tokenData) {
    return null;
  }

  const chain = chains[token.chainId as keyof typeof chains];
  const chainName = chain?.name || `Chain ${token.chainId}`;

  return (
    <div className="bg-background rounded-lg border border-border p-3 space-y-2">
      {/* Token Info */}
      <TokenDisplayRoot tokenAddress={token.token} chainId={token.chainId} symbol={token.symbol} className="gap-2">
        <div className="flex items-center gap-2 flex-1">
          <TokenDisplayIcon className="size-4" />
          {token.amount > 0n && (
            <span className="font-semibold text-sm">
              <TokenDisplayAmount amount={token.amount} unitaryPrice={price} />
            </span>
          )}
          <TokenDisplaySymbol />
          {label && (
            <span className="text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-medium">{label}</span>
          )}
          {token.amount > 0n && (
            <TokenDisplayFiat
              amount={token.amount}
              unitaryPrice={price}
              className="ml-auto text-sm text-muted-foreground"
            />
          )}
        </div>
      </TokenDisplayRoot>

      {/* Chain & Wallet Info */}
      <div className="flex items-center justify-between text-xs">
        <div className="flex items-center gap-1.5 text-muted-foreground">
          <ChainIcon chain={chainName} className="size-4" />
          <span>{chainName}</span>
        </div>
        <div className="text-muted-foreground">
          <AddressDisplayRoot address={token.walletAddress} className="gap-1.5">
            <AddressDisplayAvatar className="size-3" />
            <AddressDisplayText />
          </AddressDisplayRoot>
        </div>
      </div>
    </div>
  );
}
