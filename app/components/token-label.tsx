import { useState } from "react";

interface TokenLabelProps {
  tokenAddress: string;
  chainId: number;
  symbol: string;
}

export function TokenLabel({ tokenAddress, chainId, symbol }: TokenLabelProps) {
  const [error, setError] = useState(false);

  const src = !error
    ? `https://assets.octo.cash/token/${chainId}/${tokenAddress}`
    : "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=";

  return (
    <div className="flex items-center gap-2">
      <img src={src} alt={symbol} className="w-4 h-4 rounded-full" onError={() => setError(true)} loading="lazy" />
      <span>{symbol}</span>
    </div>
  );
}
