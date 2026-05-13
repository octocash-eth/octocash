import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type * as React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { CurrencyProvider, useFormatFiat, useSelectedCurrency, useUsdToFiat } from "./currency-provider";

vi.mock("~/lib/api/coingecko", async () => {
  const actual = await vi.importActual<typeof import("~/lib/api/coingecko")>("~/lib/api/coingecko");
  return {
    ...actual,
    fetchCoinGeckoExchangeRates: vi.fn(),
  };
});

const { fetchCoinGeckoExchangeRates } = await import("~/lib/api/coingecko");
const mockedFetchRates = vi.mocked(fetchCoinGeckoExchangeRates);

function makeWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
    },
  });
  function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <CurrencyProvider>{children}</CurrencyProvider>
      </QueryClientProvider>
    );
  }
  return { Wrapper, queryClient };
}

describe("CurrencyProvider", () => {
  beforeEach(() => {
    localStorage.clear();
    mockedFetchRates.mockReset();
    mockedFetchRates.mockResolvedValue({ USD: 1, EUR: 0.85, JPY: 150, KRW: 1300 });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  test("defaults to USD when no value is persisted", async () => {
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useSelectedCurrency(), { wrapper: Wrapper });

    expect(result.current.currency.code).toBe("USD");
  });

  test("reads an initial value from localStorage", async () => {
    localStorage.setItem("octocash:currency", JSON.stringify("EUR"));

    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useSelectedCurrency(), { wrapper: Wrapper });

    expect(result.current.currency.code).toBe("EUR");
  });

  test("persists the chosen currency to localStorage", async () => {
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useSelectedCurrency(), { wrapper: Wrapper });

    act(() => {
      result.current.setCurrency("EUR");
    });

    await waitFor(() => expect(result.current.currency.code).toBe("EUR"));
    expect(JSON.parse(localStorage.getItem("octocash:currency") ?? "null")).toBe("EUR");
  });

  test("falls back to USD when an unknown code is set", async () => {
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useSelectedCurrency(), { wrapper: Wrapper });

    act(() => {
      result.current.setCurrency("ZZZ");
    });

    expect(result.current.currency.code).toBe("USD");
  });

  test("useUsdToFiat multiplies by the fetched rate for the selected currency", async () => {
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(
      () => ({
        select: useSelectedCurrency(),
        toFiat: useUsdToFiat(),
      }),
      { wrapper: Wrapper },
    );

    // Initial USD (rate 1)
    expect(result.current.toFiat(100)).toBe(100);

    act(() => {
      result.current.select.setCurrency("EUR");
    });

    await waitFor(() => expect(result.current.select.currency.code).toBe("EUR"));
    await waitFor(() => expect(result.current.toFiat(100)).toBeCloseTo(85, 5));
  });

  test("useFormatFiat formats the converted amount using the currency symbol", async () => {
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(
      () => ({
        select: useSelectedCurrency(),
        format: useFormatFiat(),
      }),
      { wrapper: Wrapper },
    );

    expect(result.current.format(100)).toBe("$100.00");

    act(() => {
      result.current.select.setCurrency("EUR");
    });
    await waitFor(() => expect(result.current.select.currency.code).toBe("EUR"));
    await waitFor(() => expect(result.current.format(100)).toMatch(/€/));
    expect(result.current.format(100)).toMatch(/85/);
  });

  test("falls back to static rates when CoinGecko request fails", async () => {
    mockedFetchRates.mockRejectedValue(new Error("network down"));

    const { Wrapper } = makeWrapper();
    const { result } = renderHook(
      () => ({
        select: useSelectedCurrency(),
        toFiat: useUsdToFiat(),
      }),
      { wrapper: Wrapper },
    );

    act(() => {
      result.current.select.setCurrency("EUR");
    });

    // Static fallback EUR is 0.92, USD stays 1.
    await waitFor(() => expect(result.current.toFiat(100)).toBeCloseTo(92, 0));
  });
});
