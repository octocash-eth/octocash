/**
 * CoinGecko exchange-rates client.
 *
 * Provides USD->fiat conversion rates derived from CoinGecko's BTC-denominated
 * `/exchange_rates` endpoint. Used by `CurrencyProvider` to convert the USD
 * numbers we already get from Delora/Zerion into the user's selected currency at
 * the display layer (price providers stay USD-internal).
 *
 * Why BTC-denominated? CoinGecko doesn't expose a direct USD->X endpoint, but
 * `/exchange_rates` returns a single coherent snapshot of "1 BTC = X" for ~60
 * fiats. Dividing two of those by each other gives a USD->X ratio that's
 * self-consistent across all currencies in the snapshot.
 */

const COINGECKO_EXCHANGE_RATES_URL = "https://api.coingecko.com/api/v3/exchange_rates";

interface CoinGeckoRate {
  name: string;
  unit: string;
  /** Value of 1 BTC in this currency's unit. */
  value: number;
  type: "fiat" | "crypto" | "commodity";
}

interface CoinGeckoExchangeRatesResponse {
  rates: Record<string, CoinGeckoRate>;
}

/**
 * Static fallback rates (USD -> X) used when the CoinGecko request fails or
 * hasn't resolved yet. Numbers are intentionally rough mid-market quotes; they
 * exist so the UI shows a sensible non-NaN amount immediately and are replaced
 * the moment the real fetch completes.
 *
 * Keys are uppercase ISO codes. USD is always 1.
 */
export const STATIC_FALLBACK_RATES: Readonly<Record<string, number>> = Object.freeze({
  USD: 1,
  EUR: 0.92,
  GBP: 0.78,
  JPY: 155,
  CNY: 7.25,
  KRW: 1380,
  IDR: 16200,
  TWD: 32.3,
  RUB: 92,
  AED: 3.67,
  ARS: 880,
  AUD: 1.52,
  BDT: 117,
  BHD: 0.38,
  BMD: 1,
  BRL: 5.1,
  CAD: 1.36,
  CHF: 0.91,
  CLP: 950,
  CZK: 23.2,
  DKK: 6.85,
  GEL: 2.7,
  HKD: 7.82,
  HUF: 360,
  ILS: 3.7,
  INR: 83.3,
  KWD: 0.31,
  LKR: 305,
  MMK: 2100,
  MXN: 17,
  MYR: 4.7,
  NGN: 1450,
  NOK: 10.7,
  NZD: 1.65,
  PHP: 57,
  PKR: 278,
  PLN: 3.95,
  SAR: 3.75,
  SEK: 10.6,
  SGD: 1.34,
  THB: 36,
  TRY: 32.3,
  UAH: 39.5,
  VEF: 36.5,
  VND: 25400,
  ZAR: 18.4,
  XDR: 0.75,
  BTC: 0.0000095,
  ETH: 0.00033,
  XAU: 0.0003,
});

/**
 * Fetch USD->fiat exchange rates from CoinGecko.
 *
 * - Returns uppercase-keyed `Record<string, number>` where each value is the
 *   number of units of that currency you get for 1 USD.
 * - Always includes `USD: 1` so callers can look up the identity case
 *   uniformly.
 * - On any network/HTTP failure, malformed payload, or missing USD anchor in
 *   the response, returns {@link STATIC_FALLBACK_RATES}. Errors are logged but
 *   never thrown — currency display must keep working.
 */
export async function fetchCoinGeckoExchangeRates(signal?: AbortSignal): Promise<Record<string, number>> {
  try {
    const response = await fetch(COINGECKO_EXCHANGE_RATES_URL, {
      headers: { accept: "application/json" },
      signal,
    });

    if (!response.ok) {
      console.warn(`[CoinGecko] Exchange rates request failed: ${response.status}`);
      return { ...STATIC_FALLBACK_RATES };
    }

    const data = (await response.json()) as CoinGeckoExchangeRatesResponse;
    const usdAnchor = data.rates?.usd?.value;

    if (typeof usdAnchor !== "number" || !Number.isFinite(usdAnchor) || usdAnchor <= 0) {
      console.warn("[CoinGecko] Missing or invalid USD anchor in response");
      return { ...STATIC_FALLBACK_RATES };
    }

    const rates: Record<string, number> = { USD: 1 };
    for (const [code, rate] of Object.entries(data.rates)) {
      if (rate.type !== "fiat" && rate.type !== "commodity" && rate.type !== "crypto") continue;
      if (typeof rate.value !== "number" || !Number.isFinite(rate.value) || rate.value <= 0) continue;
      rates[code.toUpperCase()] = rate.value / usdAnchor;
    }

    return rates;
  } catch (error) {
    if (signal?.aborted) return { ...STATIC_FALLBACK_RATES };
    console.error("[CoinGecko] Exchange rates fetch error:", error);
    return { ...STATIC_FALLBACK_RATES };
  }
}
