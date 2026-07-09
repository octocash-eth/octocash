import { useQuery } from "@tanstack/react-query";
import { AlertTriangleIcon } from "lucide-react";
import type { Address } from "viem";
import { formatUnits } from "viem";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { useFormatFiat } from "~/context/currency-provider";
import { usePrice } from "~/context/token-price-provider";
import { LOW_PRIVACY_TVL_USD, RAILGUN_SUPPORTED_CHAINS } from "~/data/railgun";
import { getRailgunPoolBalance } from "~/lib/railgun";

interface RailgunPoolTvl {
  /** Pool TVL in USD, or undefined while balance/price are still loading. */
  tvlUsd: number | undefined;
  isLowPrivacy: boolean;
  /**
   * True when the pool's balance read failed (e.g. RPC outage on this chain),
   * so the TVL — and therefore the pool's privacy level — can't be verified.
   */
  isUnverifiable: boolean;
}

/**
 * USD value of `token` shielded in the Railgun pool on `chainId`
 * (`balanceOf(proxy)` x live Delora price).
 */
export function useRailgunPoolTvl(
  chainId: number | undefined,
  token: Address | undefined,
  decimals: number | undefined,
): RailgunPoolTvl {
  const enabled = chainId !== undefined && token !== undefined && RAILGUN_SUPPORTED_CHAINS.includes(chainId);

  const { data: balance, isError: balanceFailed } = useQuery({
    queryKey: ["railgun-pool-balance", chainId, token],
    queryFn: () => {
      if (chainId === undefined || token === undefined) throw new Error("unreachable");
      return getRailgunPoolBalance(chainId, token);
    },
    enabled,
    staleTime: 60_000,
  });

  const { price } = usePrice(enabled ? chainId : undefined, enabled ? token : undefined);

  const tvlUsd =
    balance !== undefined && price !== undefined && decimals !== undefined
      ? Number(formatUnits(balance, decimals)) * price
      : undefined;

  return {
    tvlUsd,
    isLowPrivacy: tvlUsd !== undefined && tvlUsd < LOW_PRIVACY_TVL_USD,
    isUnverifiable: balanceFailed,
  };
}

interface RailgunPoolWarningProps {
  chainId: number;
  token: Address;
  symbol: string;
  decimals: number;
  chainName: string;
}

/**
 * Warns when the selected token's Railgun pool TVL is below
 * {@link LOW_PRIVACY_TVL_USD}: deposits into small pools are easier to
 * correlate with their later unshields.
 *
 * Fails closed: if the pool balance can't be read (e.g. RPC failure on that
 * chain), a fallback warning is shown instead of silently rendering nothing.
 */
export function RailgunPoolWarning({ chainId, token, symbol, decimals, chainName }: RailgunPoolWarningProps) {
  const { tvlUsd, isLowPrivacy, isUnverifiable } = useRailgunPoolTvl(chainId, token, decimals);
  const formatFiat = useFormatFiat();

  if (isUnverifiable) {
    return (
      <Alert variant="destructive">
        <AlertTriangleIcon />
        <AlertTitle>Pool size unverified</AlertTitle>
        <AlertDescription>
          Couldn't read the Railgun {symbol} pool on {chainName}, so its privacy level can't be verified. Deposits into
          small pools are easier to trace. For maximum privacy, prefer WETH or stablecoins on Ethereum mainnet.
        </AlertDescription>
      </Alert>
    );
  }

  if (!isLowPrivacy || tvlUsd === undefined) return null;

  return (
    <Alert variant="destructive">
      <AlertTriangleIcon />
      <AlertTitle>Low privacy pool</AlertTitle>
      <AlertDescription>
        Only ~{formatFiat(tvlUsd)} of {symbol} is shielded in Railgun on {chainName}, so your deposit may be easier to
        trace. For maximum privacy, prefer WETH or stablecoins on Ethereum mainnet.
      </AlertDescription>
    </Alert>
  );
}
