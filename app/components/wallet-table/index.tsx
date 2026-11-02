import { useQueries } from "@tanstack/react-query";
import type { RowSelectionState } from "@tanstack/react-table";
import * as React from "react";
import { type Address, formatUnits } from "viem";
import { ConsolidateTokensModal } from "~/components/consolidate-tokens-modal";
import { usePriceMap, useRegisterPrices } from "~/context/token-price-provider";
import { chains } from "~/data/supported-chains";
import { useConsolidationRecords } from "~/hooks/use-consolidation-records";
import { type AccountsMap, accountFor, controlledOn } from "~/lib/accounts";
import {
  catalogTokenRefs,
  checkDeloraRoutableToUsdc,
  discoverZerionTokens,
  extraTokenRefs,
  fetchDeloraTokensForChain,
  fetchTokenBalances,
  STAKED_TOKEN_REFS,
  type TokenRef,
  watchedTokensFromConsolidations,
} from "~/lib/api";
import { MAX_SOURCE_TOKENS } from "~/lib/planning";
import type { TokenAmount } from "~/lib/types";
import { buildColumns } from "./columns";
import { DataTable } from "./data-table";

/** Chain IDs the wallet table cares about. */
const SUPPORTED_CHAIN_IDS = Object.keys(chains).map(Number);

interface WalletTableProps {
  connectedAddresses?: readonly string[];
  /** Account-kind lookup for `connectedAddresses`; absent entries are EOAs. */
  accounts?: AccountsMap;
  /**
   * Shows the Addresses / Safes tabs — token selection is scoped to one
   * wallet kind per consolidation, so Safe-held funds always plan with a
   * Safe intermediate (funds never transit an EOA).
   */
  showSafesTab?: boolean;
}

type WalletTab = "addresses" | "safes";

// Empty state component
const EmptyState = ({ hasAddresses }: { hasAddresses: boolean }) => (
  <div className="flex flex-col items-center justify-center h-64 text-center">
    <p className="mb-2 text-muted-foreground">No tokens found</p>
    <p className="text-sm text-muted-foreground">
      {hasAddresses ? "Connect a wallet with tokens or try a different address" : "Connect a wallet to see your tokens"}
    </p>
  </div>
);

export function WalletTable({ connectedAddresses = [], accounts, showSafesTab = false }: WalletTableProps) {
  const [rowSelection, setRowSelection] = React.useState<RowSelectionState>({});
  const [activeTab, setActiveTab] = React.useState<WalletTab>("addresses");
  const showTabs = showSafesTab;

  // Selection must never span both kinds — clear it when switching tabs.
  const switchTab = React.useCallback((tab: WalletTab) => {
    setActiveTab(tab);
    setRowSelection({});
  }, []);

  // Stable addresses key for query
  const addressesKey = React.useMemo(() => Array.from(connectedAddresses).sort().join(","), [connectedAddresses]);
  const addresses = React.useMemo(() => Array.from(connectedAddresses) as Address[], [connectedAddresses]);

  // Per-chain Delora `/v1/tokens` catalog fetches. The catalog is both the
  // token list the RPC balance scan checks and the routability filter. It is
  // global (independent of `addresses`), so the cache key omits them and is
  // shared across users.
  const deloraTokenListQueries = useQueries({
    queries: SUPPORTED_CHAIN_IDS.map((chainId) => ({
      queryKey: ["delora-token-list", chainId],
      queryFn: ({ signal }: { signal: AbortSignal }) => fetchDeloraTokensForChain(chainId, signal),
      staleTime: 10 * 60_000, // catalog is stable, refresh sparingly
    })),
  });

  // Index per-chain so the row filter is O(1) per token.
  const deloraByChain = React.useMemo(() => {
    const m = new Map<number, (typeof deloraTokenListQueries)[number]>();
    SUPPORTED_CHAIN_IDS.forEach((id, i) => {
      m.set(id, deloraTokenListQueries[i]);
    });
    return m;
  }, [deloraTokenListQueries]);

  // Token discovery: one Zerion request per wallet, reused for a day across
  // reloads (see `discoverZerionTokens`). It only decides *which* tokens to
  // check — mainly ones outside the catalog; balances always come from the
  // RPC scans below, so refreshes never touch Zerion.
  const discoveryQueries = useQueries({
    queries: addresses.map((address) => ({
      queryKey: ["zerion-discovery", address.toLowerCase()],
      queryFn: () => discoverZerionTokens(address),
      staleTime: Number.POSITIVE_INFINITY,
      retry: 1,
    })),
  });

  // Must-check list: tokens that consolidations on this device produced or
  // spent, so a swap's output shows up on the next refresh without Zerion.
  const { consolidations } = useConsolidationRecords();

  const extraSources: TokenRef[] = [
    ...STAKED_TOKEN_REFS,
    ...discoveryQueries.flatMap((q) => q.data ?? []),
    ...watchedTokensFromConsolidations(consolidations),
  ];

  // Balances are RPC-only: per chain, one balance-scanner pass over the whole
  // catalog for every wallet, plus a small pass over out-of-catalog tokens
  // (staked list, Zerion discoveries, consolidation tokens).
  const catalogBalanceQueries = useQueries({
    queries: SUPPORTED_CHAIN_IDS.map((chainId, i) => {
      const catalog = deloraTokenListQueries[i];
      return {
        queryKey: ["catalog-balances", chainId, addressesKey, catalog.dataUpdatedAt],
        queryFn: () =>
          fetchTokenBalances(chainId, addresses, catalog.data ? catalogTokenRefs(chainId, catalog.data) : []),
        enabled: addresses.length > 0 && catalog.isSuccess,
        staleTime: 30_000,
      };
    }),
  });

  const extraBalanceQueries = useQueries({
    queries: SUPPORTED_CHAIN_IDS.map((chainId, i) => {
      const catalog = deloraTokenListQueries[i];
      const refs = extraTokenRefs(chainId, catalog.isSuccess ? catalog.data : undefined, extraSources);
      return {
        queryKey: [
          "extra-balances",
          chainId,
          addressesKey,
          refs
            .map((r) => r.token.toLowerCase())
            .sort()
            .join(","),
        ],
        queryFn: () => fetchTokenBalances(chainId, addresses, refs),
        // Wait for the catalog to settle so catalog tokens aren't scanned twice.
        enabled: addresses.length > 0 && !catalog.isPending && refs.length > 0,
        staleTime: 30_000,
      };
    }),
  });
  const balanceQueries = [...catalogBalanceQueries, ...extraBalanceQueries];

  // Register every fetched token (visible *and* not-yet-admitted) with the
  // shared price context. Hidden candidates need a live price to drive the
  // routability probe, so we can't wait until after `isDeloraAllowed` filters
  // the list. Delora's pricing endpoint accepts many addresses per request,
  // so the cost of priceing the long tail is small.
  //
  // When a scan's key changes (a wallet was added, discovery found tokens)
  // `useQueries` starts a fresh observer with no data, and `keepPreviousData`
  // can't help: observers are matched by query hash. So each chain slot keeps
  // its last result and shows it while the replacement scan is in flight;
  // rows of wallets that are no longer connected are dropped.
  const lastBalances = React.useRef(new Map<number, TokenAmount[]>());
  const balancesSignature = balanceQueries.map((q) => `${q.dataUpdatedAt}:${q.isFetching}`).join(",");
  const allFetchedTokens = React.useMemo<TokenAmount[]>(() => {
    const connected = new Set(addresses.map((a) => a.toLowerCase()));
    const seen = new Set<string>();
    const out: TokenAmount[] = [];
    for (const [slot, q] of balanceQueries.entries()) {
      if (q.data) lastBalances.current.set(slot, q.data);
      const data = q.data ?? (q.isFetching ? lastBalances.current.get(slot) : undefined);
      for (const t of data ?? []) {
        if (!connected.has(t.walletAddress.toLowerCase())) continue; // disconnected since the last scan
        const key = `${t.chainId}:${t.token.toLowerCase()}:${t.walletAddress.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(t);
      }
    }
    return out;
  }, [balancesSignature, addresses]);
  useRegisterPrices(allFetchedTokens);
  const { priceFor, isPending: isPriceLoading } = usePriceMap();

  // USD value via the live Delora price. Returns 0 when no price is known yet
  // (token not yet priced or the chain's pricing call hasn't returned).
  const liveUsd = React.useCallback(
    (t: TokenAmount): number => {
      const price = priceFor(t);
      if (price === undefined) return 0;
      return Number(formatUnits(t.amount, t.decimals)) * price;
    },
    [priceFor],
  );

  // Tokens that the per-chain Delora `/v1/tokens` catalog definitively does not
  // know about, deduped by `${chainId}:${token}`. The catalog is conservative
  // — many legitimately routable tokens are missing — so we probe each of
  // these against Delora's `/v1/quotes` endpoint (the same one planning
  // uses) and re-admit anything that comes back with a real USDC route.
  //
  // We only consider tokens with a live Delora price and a USD value above
  // the existing dust threshold ($0.01), to keep this off the hot path for
  // the long tail of priceless / dusty hidden tokens.
  const hiddenCandidates = React.useMemo<TokenAmount[]>(() => {
    const seen = new Map<string, TokenAmount>();
    for (const t of allFetchedTokens) {
      const q = deloraByChain.get(t.chainId);
      if (!q?.isSuccess || q.data === undefined) continue;
      if (q.data.has(t.token.toLowerCase())) continue;
      if (priceFor(t) === undefined) continue;
      if (liveUsd(t) <= 0.01) continue;
      const key = `${t.chainId}:${t.token.toLowerCase()}`;
      if (!seen.has(key)) seen.set(key, t);
    }
    return Array.from(seen.values());
  }, [allFetchedTokens, deloraByChain, priceFor, liveUsd]);

  // Probe each hidden candidate. We gate on the first successful balance scan
  // so the initial table render — driven by catalog-known tokens — paints
  // before any of these network requests fire. As probes resolve, `routableSet`
  // grows and `isDeloraAllowed` flips for the affected tokens, which causes
  // the `tokens` memo to fold them back into the visible table reactively.
  const hasBalances = catalogBalanceQueries.some((q) => q.isSuccess);
  const routabilityQueries = useQueries({
    queries: hiddenCandidates.map((t) => {
      // Filtered above; `hiddenCandidates` only contains tokens with a
      // resolved live price, so this is non-undefined.
      const price = priceFor(t) as number;
      return {
        queryKey: ["delora-routable-usdc", t.chainId, t.token.toLowerCase()],
        queryFn: ({ signal }: { signal: AbortSignal }) =>
          checkDeloraRoutableToUsdc(
            {
              chainId: t.chainId,
              token: t.token,
              decimals: t.decimals,
              unitaryPrice: price,
            },
            signal,
          ),
        enabled: hasBalances,
        staleTime: 5 * 60_000,
      };
    }),
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
  // chain's Delora catalog resolves (success or error). On success we keep
  // only addresses present in the catalog *plus* any token a deferred Delora
  // quote probe confirmed is still routable to USDC; on error we keep
  // everything so a transient Delora blip doesn't nuke the user's balance
  // view.
  const isDeloraAllowed = React.useCallback(
    (token: TokenAmount): boolean => {
      if (routableSet.has(`${token.chainId}:${token.token.toLowerCase()}`)) return true;
      const q = deloraByChain.get(token.chainId);
      if (!q) return false; // chain not in our supported set
      if (q.isPending) return false; // per-chain gate: still loading
      if (q.isError) return true; // fail-open on chain-level failure
      return q.data?.has(token.token.toLowerCase()) ?? false;
    },
    [deloraByChain, routableSet],
  );

  // Dev-aid: surface tokens that we've definitively dropped *and* the
  // routability probe came back negative for. Tokens that are still being
  // probed, or that were re-admitted, are intentionally excluded so the
  // signal is only the truly-stuck long tail.
  const lastHiddenLogRef = React.useRef<string>("");
  React.useEffect(() => {
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

    const stuck = allFetchedTokens.filter((token) => {
      const q = deloraByChain.get(token.chainId);
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

    const totalUsd = stuck.reduce((sum, t) => sum + liveUsd(t), 0);
    console.warn(
      `[WalletTable] Hiding ${stuck.length} non-routable token(s) (~$${totalUsd.toFixed(2)} total):`,
      stuck.map((t) => ({
        chainId: t.chainId,
        address: t.token,
        symbol: t.symbol,
        name: t.name,
        wallet: t.walletAddress,
        amountUsd: liveUsd(t),
      })),
    );
  }, [allFetchedTokens, deloraByChain, hiddenCandidates, routabilityQueries, liveUsd]);

  // Tokens sitting at a Safe's address on a chain where that Safe has no
  // controlled deployment are unreachable (either the Safe doesn't exist
  // there, or a replayed deployment has a different owner set) — planning
  // would reject them, so they must never be selectable.
  const isReachable = React.useCallback(
    (token: TokenAmount): boolean => controlledOn(accountFor(accounts, token.walletAddress), token.chainId),
    [accounts],
  );

  // Scope rows to the active tab's wallet kind: Safes on their own tab
  // (custody + co-signing make mixed plans incoherent), everything the user
  // signs synchronously — EOAs and connected ERC-4337 smart wallets — on the
  // Addresses tab. Without tabs (no Safes discovered), all rows pass through.
  const matchesTab = React.useCallback(
    (token: TokenAmount): boolean => {
      if (!showTabs) return true;
      const kind = accountFor(accounts, token.walletAddress).kind;
      return activeTab === "safes" ? kind === "safe" : kind !== "safe";
    },
    [showTabs, activeTab, accounts],
  );

  // Every scanned balance passes through `isDeloraAllowed` so non-routable
  // tokens never reach the table, then we sort by the same live `priceFor`
  // the value column uses so the default order matches the displayed values.
  const tokens = React.useMemo(
    () =>
      allFetchedTokens
        .filter(isDeloraAllowed)
        .filter(isReachable)
        .filter(matchesTab)
        .sort((a, b) => liveUsd(b) - liveUsd(a)),
    [allFetchedTokens, isDeloraAllowed, isReachable, matchesTab, liveUsd],
  );

  // Rebuild columns when `priceFor` changes so the value column's `sortFn`
  // (which closes over `priceFor`) sees fresh prices and the table re-sorts.
  const columns = React.useMemo(() => buildColumns(priceFor), [priceFor]);

  // Loading until every chain has finished its first catalog scan (a chain
  // whose catalog failed has nothing to scan and counts as done).
  const isLoading =
    addresses.length > 0 &&
    SUPPORTED_CHAIN_IDS.some(
      (_, i) =>
        !deloraTokenListQueries[i].isError &&
        catalogBalanceQueries[i].data === undefined &&
        !catalogBalanceQueries[i].isError,
    );
  // Discovery is left out on purpose: balances are already on screen without
  // it, so a slow or unreachable Zerion must not keep the spinner going.
  const isRefreshing = [...balanceQueries, ...deloraTokenListQueries].some((q) => q.isFetching);
  const error = balanceQueries.find((q) => q.error)?.error?.message ?? null;

  // Refresh is RPC-only (plus the Delora catalog): Zerion discovery is not
  // re-asked; it expires on its own after a day.
  const handleRefresh = React.useCallback(() => {
    setRowSelection({});
    for (const q of [...balanceQueries, ...deloraTokenListQueries]) q.refetch();
  }, [balanceQueries, deloraTokenListQueries]);

  const zerionApiKeyMissing = !import.meta.env.VITE_ZERION_API_KEY;

  const walletTabs = showTabs ? (
    <div
      role="tablist"
      aria-label="Wallet kind"
      className="inline-flex rounded-md border border-border p-0.5 bg-muted/40"
    >
      {(
        [
          ["addresses", "Addresses"],
          ["safes", "Safes"],
        ] as const
      ).map(([tab, label]) => (
        <button
          key={tab}
          type="button"
          role="tab"
          aria-selected={activeTab === tab}
          onClick={() => switchTab(tab)}
          className={
            activeTab === tab
              ? "rounded px-3 py-1 text-sm font-medium bg-background shadow-sm"
              : "rounded px-3 py-1 text-sm text-muted-foreground hover:text-foreground"
          }
        >
          {label}
        </button>
      ))}
    </div>
  ) : null;

  return (
    <div className="space-y-4">
      {zerionApiKeyMissing && (
        <div className="p-4 text-muted-foreground rounded-md bg-muted border border-border">
          VITE_ZERION_API_KEY is not set — tokens outside Delora&apos;s catalog won&apos;t be discovered.
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
            canSelectMore={Object.keys(rowSelection).length < MAX_SOURCE_TOKENS}
            toolbarStart={walletTabs}
          />
          {/* Mobile: gradient scrim so the list fades out behind the floating buttons. */}
          <div
            aria-hidden
            className="pointer-events-none fixed inset-x-0 bottom-0 z-30 h-32 bg-linear-to-t from-background via-background/80 to-transparent md:hidden mb-0 pb-2"
          />
          <div className="flex flex-col items-center gap-2 mt-6 max-md:fixed max-md:bottom-4 max-md:left-4 max-md:right-20 max-md:z-40 max-md:mt-0">
            <ConsolidateTokensModal
              tokens={tokens}
              rowSelection={rowSelection}
              selectedRows={Object.keys(rowSelection).length}
              onComplete={handleRefresh}
              accounts={accounts}
            />
          </div>
        </>
      ) : (
        <>
          {/* Keep the tabs reachable so an empty tab (e.g. Safes with no
              tokens) still offers a way back to the other one. */}
          {walletTabs}
          <EmptyState hasAddresses={connectedAddresses.length > 0} />
        </>
      )}
    </div>
  );
}
