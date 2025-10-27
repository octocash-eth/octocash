import { TokenDisplayIcon, TokenDisplayRoot, TokenDisplaySymbol } from "./ui/token-display";

interface TokenLabelProps {
  tokenAddress: string;
  chainId: number;
  symbol?: string;
}

export function TokenLabel({ tokenAddress, chainId, symbol }: TokenLabelProps) {
  return (
    <TokenDisplayRoot tokenAddress={tokenAddress} chainId={chainId} symbol={symbol}>
      <TokenDisplayIcon className="size-4" />
      <TokenDisplaySymbol />
    </TokenDisplayRoot>
  );
}
