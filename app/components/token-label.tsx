import { TokenIcon } from "./token-icon";

interface TokenLabelProps {
  tokenAddress: string;
  chainId: number;
  symbol: string;
}

export function TokenLabel({ tokenAddress, chainId, symbol }: TokenLabelProps) {
  const iconUrl = `https://assets.octo.cash/token/${chainId}/${tokenAddress}`;

  return (
    <div className="flex items-center gap-2">
      <TokenIcon token={symbol} iconUrl={iconUrl} className="size-4" />
      <span>{symbol}</span>
    </div>
  );
}
