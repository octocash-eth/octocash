import { useQueries, useQuery } from "@tanstack/react-query";
import type { RowSelectionState } from "@tanstack/react-table";
import * as React from "react";
import { formatUnits } from "viem";
import { ConsolidateTokensModal } from "~/components/consolidate-tokens-modal";
import { usePriceMap, useRegisterPrices } from "~/context/token-price-provider";
import { chains } from "~/data/supported-chains";
import {
  checkOdosRoutableToUsdc,
  fetchExtraTokenBalances,
  fetchOdosTokensForChain,
  fetchZerionTokenBalances,
} from "~/lib/api";
import { isSameToken } from "~/lib/tokens";
import type { TokenAmount } from "~/lib/types";
import { buildColumns } from "./columns";
import { DataTable } from "./data-table";

/** Chain IDs the wallet table cares about. */
const SUPPORTED_CHAIN_IDS = Object.keys(chains).map(Number);

/**
 * USD value used solely for the table's first-paint sort, derived from the
 * `unitaryPrice` Zerion/Odos stamped on the `TokenAmount`. Live USD display
 * goes through the {@link usePriceMap} context instead.
 */
function sortPriceUsd(token: TokenAmount): number {
  if (token.unitaryPrice === undefined) return 0;
  return Number(formatUnits(token.amount, token.decimals)) * token.unitaryPrice;
}

interface WalletTableProps {
  connectedAddresses?: readonly string[];
}

// Empty state component
const EmptyState = ({ hasAddresses }: { hasAddresses: boolean }) => (
  <div className="flex flex-col items-center justify-center h-64 text-center">
    <p className="mb-2 text-muted-foreground">No tokens found</p>
    <p className="text-sm text-muted-foreground">
      {hasAddresses ? "Connect a wallet with tokens or try a different address" : "Connect a wallet to see your tokens"}
    </p>
  </div>
);

export function WalletTable({ connectedAddresses = [] }: WalletTableProps) {
  const [rowSelection, setRowSelection] = React.useState<RowSelectionState>({});

  // Stable addresses key for query
  const addressesKey = React.useMemo(() => Array.from(connectedAddresses).sort().join(","), [connectedAddresses]);
  const addresses = React.useMemo(() => Array.from(connectedAddresses), [connectedAddresses]);

  // Query for Zerion tokens (fast, indexed)
  const zerionQuery = useQuery({
    queryKey: ["zerion-tokens", addressesKey],
    queryFn: () => fetchZerionTokenBalances(addresses),
    enabled: addresses.length > 0,
    staleTime: 30_000, // 30 seconds
  });

  // Query for extra tokens (slower, RPC calls) - runs after Zerion data is loaded
  const extraQuery = useQuery({
    queryKey: ["extra-tokens", addressesKey],
    queryFn: async () => {
      return fetchExtraTokenBalances(addresses);
    },
    // Only fetch extra tokens after Zerion query succeeds to reduce concurrent RPC load
    enabled: addresses.length > 0 && zerionQuery.isSuccess,
    staleTime: 30_000, // 30 seconds
  });

  // Per-chain Odos `/token` catalog fetches. These run alongside `zerionQuery`
  // (no gating) so the catalog is usually ready by the time the filter runs.
  // The catalog is global (independent of `addresses`), so the cache key omits
  // them and is shared across users.
  const odosTokenListQueries = useQueries({
    queries: SUPPORTED_CHAIN_IDS.map((chainId) => ({
      queryKey: ["odos-token-list", chainId],
      queryFn: ({ signal }: { signal: AbortSignal }) => fetchOdosTokensForChain(chainId, signal),
      staleTime: 10 * 60_000, // catalog is stable, refresh sparingly
    })),
  });

  // Index per-chain so the row filter is O(1) per token.
  const odosByChain = React.useMemo(() => {
    const m = new Map<number, (typeof odosTokenListQueries)[number]>();
    SUPPORTED_CHAIN_IDS.forEach((id, i) => {
      m.set(id, odosTokenListQueries[i]);
    });
    return m;
  }, [odosTokenListQueries]);

  // Tokens that the per-chain Odos `/token` catalog definitively does not
  // know about, deduped by `${chainId}:${token}`. The catalog is conservative
  // — many legitimately routable tokens are missing — so we probe each of
  // these against Odos's `/sor/quote/v3` endpoint (the same one planning
  // uses) and re-admit anything that comes back with a real USDC route.
  //
  // We only consider tokens with a Zerion-stamped `unitaryPrice` and a USD
  // value above the existing dust threshold ($0.01), to keep this off the
  // hot path for the long tail of priceless / dusty hidden tokens.
  const hiddenCandidates = React.useMemo<TokenAmount[]>(() => {
    const all: TokenAmount[] = [...(zerionQuery.data ?? []), ...(extraQuery.data ?? [])];
    const seen = new Map<string, TokenAmount>();
    for (const t of all) {
      const q = odosByChain.get(t.chainId);
      if (!q?.isSuccess || q.data === undefined) continue;
      if (q.data.has(t.token.toLowerCase())) continue;
      if (t.unitaryPrice === undefined) continue;
      if (sortPriceUsd(t) <= 0.01) continue;
      const key = `${t.chainId}:${t.token.toLowerCase()}`;
      if (!seen.has(key)) seen.set(key, t);
    }
    return Array.from(seen.values());
  }, [zerionQuery.data, extraQuery.data, odosByChain]);

  // Probe each hidden candidate. We gate on `zerionQuery.isSuccess` so the
  // initial table render — driven by catalog-known tokens — paints before
  // any of these network requests fire. As probes resolve, `routableSet`
  // grows and `isOdosAllowed` flips for the affected tokens, which causes
  // the `tokens` memo to fold them back into the visible table reactively.
  const routabilityQueries = useQueries({
    queries: hiddenCandidates.map((t) => ({
      queryKey: ["odos-routable-usdc", t.chainId, t.token.toLowerCase()],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        checkOdosRoutableToUsdc(
          {
            chainId: t.chainId,
            token: t.token,
            decimals: t.decimals,
            // Filtered above; the `!` is just to satisfy TS.
            // biome-ignore lint/style/noNonNullAssertion: filtered in hiddenCandidates
            unitaryPrice: t.unitaryPrice!,
            walletAddress: t.walletAddress,
          },
          signal,
        ),
      enabled: zerionQuery.isSuccess,
      staleTime: 5 * 60_000,
    })),
  });

  const routableSet = React.useMemo<ReadonlySet<string>>(() => {
    const s = new Set<string>();
    for (let i = 0; i < hiddenCandidates.length; i++) {
      if (routabilityQueries[i]?.data === true) {
        const t = hiddenCandidates[i];
        s.add(`${t.chainId}:${t.token.toLowerCase()}`);
      }
    }
    return s;
  }, [hiddenCandidates, routabilityQueries]);

  // Per-chain gate + fail-open: a token on chain N is hidden until that
  // chain's Odos catalog resolves (success or error). On success we keep
  // only addresses present in the catalog *plus* any token a deferred Odos
  // quote probe confirmed is still routable to USDC; on error we keep
  // everything so a transient Odos blip doesn't nuke the user's balance
  // view.
  const isOdosAllowed = React.useCallback(
    (token: TokenAmount): boolean => {
      if (routableSet.has(`${token.chainId}:${token.token.toLowerCase()}`)) return true;
      const q = odosByChain.get(token.chainId);
      if (!q) return false; // chain not in our supported set
      if (q.isPending) return false; // per-chain gate: still loading
      if (q.isError) return true; // fail-open on chain-level failure
      return q.data?.has(token.token.toLowerCase()) ?? false;
    },
    [odosByChain, routableSet],
  );

  // Dev-aid: surface tokens that we've definitively dropped *and* the
  // routability probe came back negative for. Tokens that are still being
  // probed, or that were re-admitted, are intentionally excluded so the
  // signal is only the truly-stuck long tail.
  const lastHiddenLogRef = React.useRef<string>("");
  React.useEffect(() => {
    const all: TokenAmount[] = [...(zerionQuery.data ?? []), ...(extraQuery.data ?? [])];

    // Index probe results by `${chainId}:${address}` for cheap lookup.
    const probeStatus = new Map<string, "pending" | "routable" | "not-routable">();
    for (let i = 0; i < hiddenCandidates.length; i++) {
      const c = hiddenCandidates[i];
      const key = `${c.chainId}:${c.token.toLowerCase()}`;
      const q = routabilityQueries[i];
      if (!q || q.isPending) probeStatus.set(key, "pending");
      else if (q.data === true) probeStatus.set(key, "routable");
      else probeStatus.set(key, "not-routable");
    }

    const stuck = all.filter((token) => {
      const q = odosByChain.get(token.chainId);
      if (!q?.isSuccess || q.data === undefined) return false;
      if (q.data.has(token.token.toLowerCase())) return false;
      const status = probeStatus.get(`${token.chainId}:${token.token.toLowerCase()}`);
      // Tokens that weren't eligible to probe (dust / no price) fall through
      // here too — log them as "not-routable" since the table treats them
      // the same way.
      return status === undefined || status === "not-routable";
    });

    if (stuck.length === 0) {
      lastHiddenLogRef.current = "";
      return;
    }

    // Stable signature so we don't re-log on every render.
    const signature = stuck
      .map((t) => `${t.chainId}:${t.token.toLowerCase()}:${t.amount.toString()}`)
      .sort()
      .join("|");
    if (signature === lastHiddenLogRef.current) return;
    lastHiddenLogRef.current = signature;

    const totalUsd = stuck.reduce((sum, t) => sum + sortPriceUsd(t), 0);
    console.warn(
      `[WalletTable] Hiding ${stuck.length} non-routable token(s) (~$${totalUsd.toFixed(2)} total):`,
      stuck.map((t) => ({
        chainId: t.chainId,
        address: t.token,
        symbol: t.symbol,
        name: t.name,
        wallet: t.walletAddress,
        amountUsd: sortPriceUsd(t),
      })),
    );
  }, [zerionQuery.data, extraQuery.data, odosByChain, hiddenCandidates, routabilityQueries]);

  // Combine tokens: Zerion first, then extra tokens (deduplicated). Both
  // streams are passed through `isOdosAllowed` so non-routable tokens never
  // reach the table.
  const tokens = React.useMemo(() => {
    const zerionTokens = (zerionQuery.data ?? []).filter(isOdosAllowed);

    // Only include extra tokens if the query has successfully completed
    // This ensures zerion data renders first before extra tokens are added
    if (!extraQuery.isSuccess) {
      // Sort by USD value (descending) using the cached `unitaryPrice`
      const sorted = [...zerionTokens];
      sorted.sort((a, b) => sortPriceUsd(b) - sortPriceUsd(a));
      return sorted;
    }

    const extraTokens = (extraQuery.data ?? []).filter(isOdosAllowed);

    // Deduplicate extra tokens against Zerion tokens
    const deduplicatedExtra = extraTokens.filter((extra) => !zerionTokens.some((zerion) => isSameToken(zerion, extra)));

    const combined = [...zerionTokens, ...deduplicatedExtra];
    combined.sort((a, b) => sortPriceUsd(b) - sortPriceUsd(a));
    return combined;
  }, [zerionQuery.data, extraQuery.data, extraQuery.isSuccess, isOdosAllowed]);

  // Feed every visible token into the shared price context, then read prices
  // back through the same context so the table USD column and every other
  // component (plan card, consolidation modal) see identical values.
  useRegisterPrices(tokens);
  const { priceFor, isPending: isPriceLoading } = usePriceMap();

  // Rebuild columns when `priceFor` changes so the value column's `sortingFn`
  // (which closes over `priceFor`) sees fresh prices and the table re-sorts.
  const columns = React.useMemo(() => buildColumns(priceFor), [priceFor]);

  const isLoading = zerionQuery.isLoading;
  const isOdosFetching = odosTokenListQueries.some((q) => q.isFetching);
  const isRefreshing = zerionQuery.isFetching || extraQuery.isFetching || isOdosFetching;
  const error = zerionQuery.error?.message ?? extraQuery.error?.message ?? null;

  const handleRefresh = React.useCallback(() => {
    setRowSelection({});
    zerionQuery.refetch();
    extraQuery.refetch();
    odosTokenListQueries.forEach((q) => {
      q.refetch();
    });
  }, [zerionQuery.refetch, extraQuery.refetch, odosTokenListQueries]);

  const zerionApiKeyMissing = !import.meta.env.VITE_ZERION_API_KEY;

  return (
    <div className="space-y-4">
      {zerionApiKeyMissing && (
        <div className="p-4 text-muted-foreground rounded-md bg-muted border border-border">
          VITE_ZERION_API_KEY is not set — showing native coin balances only. Set the API key to see all tokens.
        </div>
      )}
      {error && <div className="p-4 text-red-700 rounded-md bg-red-50">{error}</div>}
      {tokens.length > 0 || isLoading ? (
        <>
          <DataTable
            columns={columns}
            data={tokens}
            connectedAddresses={connectedAddresses}
            rowSelection={rowSelection}
            onRowSelectionChange={setRowSelection}
            onRefresh={handleRefresh}
            isRefreshing={isRefreshing || isLoading}
            priceFor={priceFor}
            isPending={isPriceLoading}
          />
          <div className="flex justify-center mt-6">
            <ConsolidateTokensModal
              tokens={tokens}
              rowSelection={rowSelection}
              selectedRows={Object.keys(rowSelection).length}
              onComplete={handleRefresh}
            />
          </div>
        </>
      ) : (
        <EmptyState hasAddresses={connectedAddresses.length > 0} />
      )}
    </div>
  );
}
