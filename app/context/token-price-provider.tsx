import { useQuery } from "@tanstack/react-query";
import * as React from "react";
import type { Address } from "viem";
import { type DeloraPriceKey, deloraPriceKey, fetchDeloraPrices } from "~/lib/api/delora";
import type { TokenAmount } from "~/lib/types";

/** Polling cadence for refreshing Delora prices (2 minutes). */
const REFRESH_MS = 120_000;
/** Stale time, mirrors the wallet table's existing 30s freshness window. */
const STALE_MS = 30_000;

type PriceKey = DeloraPriceKey;
type TokenIdentity = Pick<TokenAmount, "chainId" | "token">;

interface TokenPriceRegistry {
  /** Look up the latest cached price for a token. Reads from a ref. */
  priceFor: (token: TokenIdentity) => number | undefined;
  /**
   * Refcount-style registration. Each call adds one reference per token; the
   * returned disposer removes one reference per token. The polling query is
   * driven by the union of all currently-registered tokens.
   *
   * This callback is stable across renders.
   */
  registerTokens: (tokens: ReadonlyArray<TokenIdentity>) => () => void;
}

/**
 * Registry of price accessors. Stable for the lifetime of the provider, so
 * `useRegisterPrices` doesn't see a new `ctx` on every price update.
 */
const TokenPriceRegistryContext = React.createContext<TokenPriceRegistry | null>(null);

/**
 * Volatile data context: whether a refresh is currently in flight. Consumers
 * that *read* prices subscribe to this so they re-render at each
 * fetch-completed boundary; consumers that only *register* tokens stick to
 * the registry context and skip these updates.
 */
interface TokenPriceData {
  isFetching: boolean;
}
const TokenPriceDataContext = React.createContext<TokenPriceData>({ isFetching: false });

function useRegistry(): TokenPriceRegistry {
  const ctx = React.useContext(TokenPriceRegistryContext);
  if (!ctx) {
    throw new Error("Token price hooks must be used within <TokenPriceProvider>");
  }
  return ctx;
}

/**
 * Provider that centralises Delora token prices. Components anywhere in the
 * tree can call `usePrice(chainId, token)` to subscribe to a single token's
 * price, or `useRegisterPrices(tokens)` to subscribe to many at once.
 *
 * Internally it tracks a refcounted set of `(chainId:address)` keys and feeds
 * them into a single TanStack `useQuery` that refetches every
 * {@link REFRESH_MS}, pauses automatically while the tab is hidden (via
 * `refetchIntervalInBackground: false`), and aborts in-flight requests on
 * unmount. Previously-seen prices are accumulated in a ref so values never
 * flicker between refresh cycles even if a particular token is missing from
 * a later response.
 */
export function TokenPriceProvider({ children }: { children: React.ReactNode }) {
  const accumulatedPricesRef = React.useRef<Map<PriceKey, number>>(new Map());
  const refcountsRef = React.useRef<Map<PriceKey, number>>(new Map());
  /**
   * Timestamp of the last fetch that covered ALL registered tokens. Used to
   * avoid hammering the Delora pricing API: every registration change makes a
   * new query key, but within {@link STALE_MS} of a full fetch we only ask
   * for tokens that don't have an accumulated price yet (often none).
   */
  const lastFullFetchAtRef = React.useRef(0);

  const [registeredTokens, setRegisteredTokens] = React.useState<ReadonlyArray<TokenIdentity>>([]);

  const registerTokens = React.useCallback<TokenPriceRegistry["registerTokens"]>((tokens) => {
    if (tokens.length === 0) return () => {};

    const added: TokenIdentity[] = [];
    for (const t of tokens) {
      const key = deloraPriceKey(t.chainId, t.token as Address);
      const current = refcountsRef.current.get(key) ?? 0;
      refcountsRef.current.set(key, current + 1);
      if (current === 0) added.push({ chainId: t.chainId, token: t.token });
    }
    if (added.length > 0) {
      setRegisteredTokens((prev) => [...prev, ...added]);
    }

    return () => {
      const removedKeys = new Set<PriceKey>();
      for (const t of tokens) {
        const key = deloraPriceKey(t.chainId, t.token as Address);
        const current = refcountsRef.current.get(key);
        if (current === undefined) continue;
        if (current <= 1) {
          refcountsRef.current.delete(key);
          removedKeys.add(key);
        } else {
          refcountsRef.current.set(key, current - 1);
        }
      }
      if (removedKeys.size > 0) {
        setRegisteredTokens((prev) =>
          prev.filter((t) => !removedKeys.has(deloraPriceKey(t.chainId, t.token as Address))),
        );
      }
    };
  }, []);

  // Stable signature so identical token sets share a TanStack cache entry.
  const signature = React.useMemo(
    () =>
      registeredTokens
        .map((t) => deloraPriceKey(t.chainId, t.token as Address))
        .sort()
        .join("|"),
    [registeredTokens],
  );

  const query = useQuery({
    queryKey: ["delora-prices", signature],
    queryFn: async ({ signal }) => {
      // A signature change (token registered/unregistered) lands here even
      // when almost every price is already known. Within the stale window of
      // the last full fetch, restrict the request to tokens we have no price
      // for — usually one token (one GET) or none (no network at all). Full
      // fetches still happen on the polling interval to keep prices fresh.
      const now = Date.now();
      const fullRefresh = now - lastFullFetchAtRef.current >= STALE_MS;
      const targets = fullRefresh
        ? registeredTokens
        : registeredTokens.filter(
            (t) => !accumulatedPricesRef.current.has(deloraPriceKey(t.chainId, t.token as Address)),
          );
      if (fullRefresh) lastFullFetchAtRef.current = now;
      if (targets.length === 0) return new Map<PriceKey, number>();

      const prices = await fetchDeloraPrices(targets, signal);
      // Accumulate so previously-known prices survive even when a later
      // response omits some tokens (e.g. partial chain failure).
      for (const [key, price] of prices) {
        accumulatedPricesRef.current.set(key, price);
      }
      return prices;
    },
    enabled: registeredTokens.length > 0,
    staleTime: STALE_MS,
    refetchInterval: REFRESH_MS,
    // Pause polling while the tab is hidden — same UX as the previous
    // hand-rolled `useDeloraPrices` visibility listener, but built-in.
    refetchIntervalInBackground: false,
  });

  const registry = React.useMemo<TokenPriceRegistry>(
    () => ({
      priceFor: (token) => accumulatedPricesRef.current.get(deloraPriceKey(token.chainId, token.token as Address)),
      registerTokens,
    }),
    [registerTokens],
  );

  const data = React.useMemo<TokenPriceData>(() => ({ isFetching: query.isFetching }), [query.isFetching]);

  return (
    <TokenPriceRegistryContext.Provider value={registry}>
      <TokenPriceDataContext.Provider value={data}>{children}</TokenPriceDataContext.Provider>
    </TokenPriceRegistryContext.Provider>
  );
}

/**
 * Subscribe to a single token's price. Registers the key on mount, releases
 * it on unmount, and re-renders whenever the underlying price changes.
 */
export function usePrice(
  chainId: number | undefined,
  address: Address | undefined,
): { price: number | undefined; isPending: boolean } {
  const registry = useRegistry();
  const data = React.useContext(TokenPriceDataContext);

  React.useEffect(() => {
    if (chainId === undefined || address === undefined) return;
    return registry.registerTokens([{ chainId, token: address }]);
  }, [registry, chainId, address]);

  if (chainId === undefined || address === undefined) {
    return { price: undefined, isPending: false };
  }
  const token: TokenIdentity = { chainId, token: address };
  const price = registry.priceFor(token);
  return { price, isPending: price === undefined && data.isFetching };
}

/**
 * Subscribe to a batch of tokens. Registers all of them on mount and
 * releases them on unmount. Intended for places that already iterate over an
 * array (the wallet table, the consolidation modal).
 *
 * Does NOT subscribe to price updates — pair with {@link usePriceMap} or
 * {@link usePrice} on individual cells to actually render values.
 */
export function useRegisterPrices(tokens: ReadonlyArray<TokenIdentity>): void {
  const registry = useRegistry();
  const signature = React.useMemo(
    () => tokens.map((t) => deloraPriceKey(t.chainId, t.token as Address)).join("|"),
    [tokens],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: `tokens` is captured via the signature dep; we deliberately re-run only when the set of keys changes, not on every array identity change.
  React.useEffect(() => {
    if (signature.length === 0) return;
    return registry.registerTokens(tokens);
  }, [registry, signature]);
}

/**
 * Read-only accessor for code paths that need to look up prices in a loop
 * (e.g. computing a USD total over many tokens) without registering anything.
 * Combine with {@link useRegisterPrices} on the same list to keep the polling
 * loop fed.
 *
 * Subscribes to the data context so callers re-render after prices update.
 */
export function usePriceMap(): {
  priceFor: (token: TokenIdentity) => number | undefined;
  isPending: (token: TokenIdentity) => boolean;
} {
  const registry = useRegistry();
  const data = React.useContext(TokenPriceDataContext);
  return React.useMemo(
    () => ({
      priceFor: registry.priceFor,
      isPending: (token) => registry.priceFor(token) === undefined && data.isFetching,
    }),
    [registry, data.isFetching],
  );
}
