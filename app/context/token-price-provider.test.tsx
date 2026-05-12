import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, renderHook, waitFor } from "@testing-library/react";
import type * as React from "react";
import type { Address } from "viem";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { TokenPriceProvider, usePrice, usePriceMap, useRegisterPrices } from "./token-price-provider";

// Mock the Odos API so we control what prices come back. The provider relies
// on `fetchOdosPrices` returning a Map<OdosPriceKey, number> keyed by
// `${chainId}:${lowercase address}`.
vi.mock("~/lib/api/odos", async () => {
  const actual = await vi.importActual<typeof import("~/lib/api/odos")>("~/lib/api/odos");
  return {
    ...actual,
    fetchOdosPrices: vi.fn(),
  };
});

const { fetchOdosPrices } = await import("~/lib/api/odos");
const mockedFetch = vi.mocked(fetchOdosPrices);

const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" as Address;
const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2" as Address;
const DAI = "0x6b175474e89094c44da98b954eedeac495271d0f" as Address;
const CHAIN = 1;

function key(chainId: number, address: Address) {
  return `${chainId}:${address.toLowerCase()}` as const;
}

/**
 * Fresh QueryClient per test so refetch counters / cache isolation are clean.
 * Retries are disabled to make failed-fetch behaviour deterministic.
 */
function makeWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
    },
  });
  function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <TokenPriceProvider>{children}</TokenPriceProvider>
      </QueryClientProvider>
    );
  }
  return { Wrapper, queryClient };
}

describe("TokenPriceProvider", () => {
  beforeEach(() => {
    mockedFetch.mockReset();
    mockedFetch.mockResolvedValue(new Map());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("usePrice registers a token and exposes its price after a fetch", async () => {
    mockedFetch.mockResolvedValue(new Map([[key(CHAIN, USDC), 1.0001]]));
    const { Wrapper } = makeWrapper();

    const { result } = renderHook(() => usePrice(CHAIN, USDC), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.price).toBe(1.0001));
    expect(result.current.isPending).toBe(false);
  });

  test("usePrice with undefined chainId/address yields no price and registers nothing", async () => {
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => usePrice(undefined, undefined), { wrapper: Wrapper });

    expect(result.current.price).toBeUndefined();
    expect(result.current.isPending).toBe(false);
    // No tokens registered, query stays disabled.
    await new Promise((r) => setTimeout(r, 20));
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  test("useRegisterPrices registers a batch; usePriceMap reads the prices back", async () => {
    mockedFetch.mockResolvedValue(
      new Map([
        [key(CHAIN, USDC), 1],
        [key(CHAIN, WETH), 2500],
      ]),
    );
    const { Wrapper } = makeWrapper();

    const tokens = [
      { chainId: CHAIN, token: USDC },
      { chainId: CHAIN, token: WETH },
    ];

    const { result } = renderHook(
      () => {
        useRegisterPrices(tokens);
        return usePriceMap();
      },
      { wrapper: Wrapper },
    );

    await waitFor(() => expect(result.current.priceFor(tokens[0])).toBe(1));
    expect(result.current.priceFor(tokens[1])).toBe(2500);
  });

  test("multiple consumers registering the same token share one query", async () => {
    mockedFetch.mockResolvedValue(new Map([[key(CHAIN, USDC), 1.23]]));
    const { Wrapper } = makeWrapper();

    render(
      <Wrapper>
        <ConsumerWithPrice />
        <ConsumerWithPrice />
      </Wrapper>,
    );

    await waitFor(() => expect(mockedFetch).toHaveBeenCalled());

    // The two consumers share the same refcounted registration, so the query
    // only ever asks about one (chainId, token) pair.
    const allUniqueArgs = new Set<string>();
    for (const call of mockedFetch.mock.calls) {
      for (const t of call[0] ?? []) {
        allUniqueArgs.add(`${t.chainId}:${t.token.toLowerCase()}`);
      }
    }
    expect(allUniqueArgs).toEqual(new Set([key(CHAIN, USDC)]));
  });

  test("unmounted consumer drops its token from the registered set", async () => {
    mockedFetch.mockResolvedValue(new Map());
    const { Wrapper } = makeWrapper();

    function Harness({ show }: { show: boolean }) {
      return show ? <ConsumerWithPrice /> : null;
    }

    const { rerender } = render(
      <Wrapper>
        <Harness show={true} />
      </Wrapper>,
    );

    await waitFor(() => expect(mockedFetch).toHaveBeenCalled());
    const callsBeforeUnmount = mockedFetch.mock.calls.length;

    rerender(
      <Wrapper>
        <Harness show={false} />
      </Wrapper>,
    );

    // After unmount the registered set is empty; useQuery is disabled and
    // will not fire again on its own.
    await new Promise((r) => setTimeout(r, 30));
    // Either no new calls, or any later call was with an empty list (a
    // disabled query). The important invariant is "no new fetch with USDC".
    for (let i = callsBeforeUnmount; i < mockedFetch.mock.calls.length; i++) {
      const args = mockedFetch.mock.calls[i]?.[0] ?? [];
      expect(args).toHaveLength(0);
    }
  });

  test("isPending is true while the first fetch is in flight, false after it resolves", async () => {
    type PriceMap = Awaited<ReturnType<typeof fetchOdosPrices>>;
    let resolveFetch!: (value: PriceMap) => void;
    mockedFetch.mockImplementation(
      () =>
        new Promise<PriceMap>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const { Wrapper } = makeWrapper();

    const { result } = renderHook(() => usePrice(CHAIN, DAI), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isPending).toBe(true));
    expect(result.current.price).toBeUndefined();

    resolveFetch(new Map([[key(CHAIN, DAI), 1]]));

    await waitFor(() => expect(result.current.isPending).toBe(false));
    expect(result.current.price).toBe(1);
  });

  test("previously-known prices survive a refetch that omits them", async () => {
    // First call returns USDC=1, second call omits USDC entirely.
    mockedFetch.mockResolvedValueOnce(new Map([[key(CHAIN, USDC), 1]])).mockResolvedValueOnce(new Map());
    const { Wrapper, queryClient } = makeWrapper();

    const { result } = renderHook(() => usePrice(CHAIN, USDC), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.price).toBe(1));

    // Force a refetch on the same query; the accumulator should preserve the
    // earlier USDC price even though the second response is empty.
    await queryClient.refetchQueries({ queryKey: ["odos-prices"] });

    expect(result.current.price).toBe(1);
  });
});

function ConsumerWithPrice() {
  const { price } = usePrice(CHAIN, USDC);
  return <span data-testid="consumer">{price ?? "loading"}</span>;
}

describe("usePrice / useRegisterPrices outside provider", () => {
  test("throws if used without <TokenPriceProvider>", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() =>
      renderHook(() => usePrice(CHAIN, USDC), {
        wrapper: ({ children }) => <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>,
      }),
    ).toThrow(/Token price hooks must be used within <TokenPriceProvider>/);
    spy.mockRestore();
  });
});
