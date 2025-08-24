import { getAddress, isAddress, zeroAddress } from "viem";
import { useToken } from "wagmi";

function getTokenImage(symbol: string) {
  switch (symbol) {
    case "USDC":
      return "https://assets.coingecko.com/coins/images/6319/small/usdc.png";
    case "WBTC":
      return "https://assets.coingecko.com/coins/images/7598/small/wrapped_bitcoin_wbtc.png";
    case "ETH":
    case "WETH":
      return "https://assets.coingecko.com/coins/images/279/standard/ethereum.png";
    default:
      return "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=";
  }
}

export function TokenLabel({ tokenAddress, chainId }: { tokenAddress: string; chainId: number }) {
  const address = isAddress(tokenAddress) ? getAddress(tokenAddress) : undefined;
  const { data } = useToken({
    chainId,
    address,
    query: {
      enabled: !!tokenAddress && tokenAddress !== zeroAddress,
    },
  });
  const token = tokenAddress === zeroAddress ? { symbol: chainId === 137 ? "POL" : "ETH" } : data;

  return (
    <div className="flex items-center gap-2">
      <img src={getTokenImage(token?.symbol ?? "")} alt={token?.symbol} className="w-4 h-4 rounded-full" />
      {token?.symbol}
    </div>
  );
}
