import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { fetchCoinGeckoExchangeRates, STATIC_FALLBACK_RATES } from "./coingecko";

const mockFetch = vi.fn();
global.fetch = mockFetch as unknown as typeof fetch;

function okResponse(json: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => json,
  } as Response;
}

function errorResponse(status: number) {
  return { ok: false, status } as Response;
}

describe("fetchCoinGeckoExchangeRates", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  test("derives USD->X rates from BTC-denominated rates and includes USD=1", async () => {
    mockFetch.mockResolvedValue(
      okResponse({
        rates: {
          usd: { name: "US Dollar", unit: "$", value: 60_000, type: "fiat" },
          eur: { name: "Euro", unit: "€", value: 55_200, type: "fiat" },
          jpy: { name: "Japanese Yen", unit: "¥", value: 9_300_000, type: "fiat" },
          btc: { name: "Bitcoin", unit: "BTC", value: 1, type: "crypto" },
        },
      }),
    );

    const rates = await fetchCoinGeckoExchangeRates();

    expect(rates.USD).toBe(1);
    // 55_200 / 60_000 = 0.92
    expect(rates.EUR).toBeCloseTo(0.92, 5);
    // 9_300_000 / 60_000 = 155
    expect(rates.JPY).toBeCloseTo(155, 5);
    // 1 / 60_000 — crypto assets (BTC/ETH) are exposed as alternative units.
    expect(rates.BTC).toBeCloseTo(1 / 60_000, 10);
  });

  test("includes crypto asset codes like BTC and ETH", async () => {
    mockFetch.mockResolvedValue(
      okResponse({
        rates: {
          usd: { name: "US Dollar", unit: "$", value: 60_000, type: "fiat" },
          btc: { name: "Bitcoin", unit: "BTC", value: 1, type: "crypto" },
          eth: { name: "Ether", unit: "ETH", value: 30, type: "crypto" },
          xau: { name: "Gold - Troy Ounce", unit: "XAU", value: 25.6, type: "commodity" },
        },
      }),
    );

    const rates = await fetchCoinGeckoExchangeRates();

    expect(rates.BTC).toBeCloseTo(1 / 60_000, 10);
    expect(rates.ETH).toBeCloseTo(30 / 60_000, 10);
    expect(rates.XAU).toBeCloseTo(25.6 / 60_000, 10);
  });

  test("uppercases currency codes", async () => {
    mockFetch.mockResolvedValue(
      okResponse({
        rates: {
          usd: { name: "US Dollar", unit: "$", value: 60_000, type: "fiat" },
          twd: { name: "New Taiwan Dollar", unit: "NT$", value: 1_938_000, type: "fiat" },
        },
      }),
    );

    const rates = await fetchCoinGeckoExchangeRates();

    expect(rates.TWD).toBeCloseTo(32.3, 5);
    expect(rates.twd).toBeUndefined();
  });

  test("includes commodity codes like XDR", async () => {
    mockFetch.mockResolvedValue(
      okResponse({
        rates: {
          usd: { name: "US Dollar", unit: "$", value: 60_000, type: "fiat" },
          xdr: { name: "Special Drawing Rights", unit: "SDR", value: 45_000, type: "commodity" },
        },
      }),
    );

    const rates = await fetchCoinGeckoExchangeRates();

    expect(rates.XDR).toBeCloseTo(0.75, 5);
  });

  test("falls back to static rates on non-OK response", async () => {
    mockFetch.mockResolvedValue(errorResponse(500));

    const rates = await fetchCoinGeckoExchangeRates();

    expect(rates).toEqual(STATIC_FALLBACK_RATES);
  });

  test("falls back to static rates on network error", async () => {
    mockFetch.mockRejectedValue(new Error("network down"));

    const rates = await fetchCoinGeckoExchangeRates();

    expect(rates).toEqual(STATIC_FALLBACK_RATES);
  });

  test("falls back to static rates when USD anchor missing", async () => {
    mockFetch.mockResolvedValue(
      okResponse({
        rates: {
          eur: { name: "Euro", unit: "€", value: 55_200, type: "fiat" },
        },
      }),
    );

    const rates = await fetchCoinGeckoExchangeRates();

    expect(rates).toEqual(STATIC_FALLBACK_RATES);
  });

  test("skips entries with invalid values", async () => {
    mockFetch.mockResolvedValue(
      okResponse({
        rates: {
          usd: { name: "US Dollar", unit: "$", value: 60_000, type: "fiat" },
          eur: { name: "Euro", unit: "€", value: 55_200, type: "fiat" },
          bad1: { name: "Bad", unit: "?", value: 0, type: "fiat" },
          bad2: { name: "Bad2", unit: "?", value: Number.NaN, type: "fiat" },
          bad3: { name: "Bad3", unit: "?", value: -1, type: "fiat" },
        },
      }),
    );

    const rates = await fetchCoinGeckoExchangeRates();

    expect(rates.EUR).toBeCloseTo(0.92, 5);
    expect(rates.BAD1).toBeUndefined();
    expect(rates.BAD2).toBeUndefined();
    expect(rates.BAD3).toBeUndefined();
  });
});
