import { useQuery } from "@tanstack/react-query";
import * as React from "react";
import useLocalStorageState from "use-local-storage-state";
import { fetchCoinGeckoExchangeRates, STATIC_FALLBACK_RATES } from "~/lib/api/coingecko";
import { type Currency, DEFAULT_CURRENCY_CODE, getCurrency } from "~/lib/currencies";
import { formatFiat } from "~/lib/tokens";

/**
 * 15-minute stale time mirrors how often FX moves in practice; we won't see
 * meaningful USD/EUR drift between page loads under this window.
 */
const STALE_MS = 15 * 60_000;
/**
 * Refresh every hour while the app is open. CoinGecko's free tier rate-limits
 * aggressively; the static fallback keeps the UI responsive between refreshes
 * even if the request occasionally fails.
 */
const REFRESH_MS = 60 * 60_000;

const CURRENCY_STORAGE_KEY = "octocash:currency";

interface CurrencyContextValue {
  selectedCurrency: Currency;
  setSelectedCurrency: (code: string) => void;
  /** USD->X for the currently-selected currency. `1` for USD. */
  rate: number;
  /** Whether the CoinGecko fetch is currently in flight (initial load). */
  isLoadingRates: boolean;
  /** Convert a USD-denominated amount to the selected currency. */
  usdToFiat: (usdAmount: number) => number;
  /** Format a USD-denominated amount in the selected currency. */
  formatUsdAsFiat: (usdAmount: number, decimals?: number) => string;
}

const CurrencyContext = React.createContext<CurrencyContextValue | null>(null);

/**
 * Identity fallback used when consumers are rendered outside a
 * `<CurrencyProvider>`. Lets shared components like `TokenDisplayAmount` —
 * which are exercised in isolation by unit tests and may also render on
 * routes that haven't opted into the wallet stack — keep producing valid USD
 * output instead of throwing.
 */
const USD_IDENTITY_CONTEXT: CurrencyContextValue = {
  selectedCurrency: getCurrency(DEFAULT_CURRENCY_CODE),
  setSelectedCurrency: () => {},
  rate: 1,
  isLoadingRates: false,
  usdToFiat: (usdAmount) => usdAmount,
  formatUsdAsFiat: (usdAmount, decimals) => formatFiat(usdAmount, DEFAULT_CURRENCY_CODE, decimals),
};

function useCurrencyContext(): CurrencyContextValue {
  return React.useContext(CurrencyContext) ?? USD_IDENTITY_CONTEXT;
}

/**
 * Centralises the user-facing fiat currency:
 *
 * - Persists the user's selection to `localStorage` (`octocash:currency`),
 *   defaulting to USD.
 * - Fetches USD->X exchange rates from CoinGecko on mount and refreshes them
 *   hourly. Renders fall back to {@link STATIC_FALLBACK_RATES} until the first
 *   real response lands so the UI never shows NaN or `$0.00` placeholders.
 * - Exposes hooks: {@link useSelectedCurrency}, {@link useFormatFiat},
 *   {@link useUsdToFiat}.
 *
 * Prices remain USD-denominated upstream; conversion is purely a display-layer
 * concern that lives here.
 */
export function CurrencyProvider({ children }: { children: React.ReactNode }) {
  const [storedCode, setStoredCode] = useLocalStorageState<string>(CURRENCY_STORAGE_KEY, {
    defaultValue: DEFAULT_CURRENCY_CODE,
  });

  const ratesQuery = useQuery({
    queryKey: ["coingecko-exchange-rates"],
    queryFn: ({ signal }) => fetchCoinGeckoExchangeRates(signal),
    staleTime: STALE_MS,
    refetchInterval: REFRESH_MS,
    refetchIntervalInBackground: false,
    placeholderData: STATIC_FALLBACK_RATES,
  });

  const rates = ratesQuery.data ?? STATIC_FALLBACK_RATES;
  const selectedCurrency = React.useMemo(() => getCurrency(storedCode), [storedCode]);

  const setSelectedCurrency = React.useCallback(
    (code: string) => {
      setStoredCode(getCurrency(code).code);
    },
    [setStoredCode],
  );

  const rate = rates[selectedCurrency.code] ?? STATIC_FALLBACK_RATES[selectedCurrency.code] ?? 1;

  const usdToFiat = React.useCallback((usdAmount: number) => usdAmount * rate, [rate]);

  const formatUsdAsFiat = React.useCallback(
    (usdAmount: number, decimals?: number) => formatFiat(usdAmount * rate, selectedCurrency.code, decimals),
    [rate, selectedCurrency.code],
  );

  const value = React.useMemo<CurrencyContextValue>(
    () => ({
      selectedCurrency,
      setSelectedCurrency,
      rate,
      isLoadingRates: ratesQuery.isLoading,
      usdToFiat,
      formatUsdAsFiat,
    }),
    [selectedCurrency, setSelectedCurrency, rate, ratesQuery.isLoading, usdToFiat, formatUsdAsFiat],
  );

  return <CurrencyContext.Provider value={value}>{children}</CurrencyContext.Provider>;
}

/**
 * Returns the currently-selected currency and the setter used by the modal.
 */
export function useSelectedCurrency(): {
  currency: Currency;
  setCurrency: (code: string) => void;
} {
  const { selectedCurrency, setSelectedCurrency } = useCurrencyContext();
  return { currency: selectedCurrency, setCurrency: setSelectedCurrency };
}

/**
 * Returns a stable formatter that converts a USD amount to the user's
 * currency string. Designed as a drop-in replacement for `formatUsd(...)`
 * at React callsites.
 *
 * @example
 *   const format = useFormatFiat();
 *   <span>{format(usdAmount)}</span>
 */
export function useFormatFiat(): (usdAmount: number, decimals?: number) => string {
  return useCurrencyContext().formatUsdAsFiat;
}

/**
 * Returns a stable USD->selected-currency converter. Use this when you need
 * the raw number (e.g. for sorting) rather than a formatted string.
 */
export function useUsdToFiat(): (usdAmount: number) => number {
  return useCurrencyContext().usdToFiat;
}
