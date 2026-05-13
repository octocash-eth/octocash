/**
 * Curated fiat currency catalog used by the top-bar currency selector.
 *
 * The list and grouping mirror the design mockup: a small "suggested" group
 * shown at the top of the modal, followed by an alphabetical list of all other
 * supported currencies. Codes are uppercase ISO 4217 where applicable, plus
 * XDR (IMF Special Drawing Rights), which CoinGecko exposes as a commodity.
 *
 * `Intl.NumberFormat` handles the symbol/locale conventions for each code, so
 * the only metadata we keep here is `name` (for the modal) and `group`.
 */

export type CurrencyGroup = "suggested" | "fiat";

export interface Currency {
  code: string;
  name: string;
  group: CurrencyGroup;
}

/**
 * Order matters here — these render in this exact order in the "Suggested"
 * section of the modal, matching the design.
 */
export const SUGGESTED_CODES = ["USD", "IDR", "TWD", "EUR", "KRW", "JPY", "RUB", "CNY"] as const;

const SUGGESTED_SET = new Set<string>(SUGGESTED_CODES);

const SUGGESTED_CURRENCIES: Currency[] = [
  { code: "USD", name: "US Dollar", group: "suggested" },
  { code: "IDR", name: "Indonesian Rupiah", group: "suggested" },
  { code: "TWD", name: "New Taiwan Dollar", group: "suggested" },
  { code: "EUR", name: "Euro", group: "suggested" },
  { code: "KRW", name: "South Korean Won", group: "suggested" },
  { code: "JPY", name: "Japanese Yen", group: "suggested" },
  { code: "RUB", name: "Russian Ruble", group: "suggested" },
  { code: "CNY", name: "Chinese Yuan", group: "suggested" },
];

const FIAT_CURRENCIES: Currency[] = [
  { code: "AED", name: "United Arab Emirates Dirham", group: "fiat" },
  { code: "ARS", name: "Argentine Peso", group: "fiat" },
  { code: "AUD", name: "Australian Dollar", group: "fiat" },
  { code: "BDT", name: "Bangladeshi Taka", group: "fiat" },
  { code: "BHD", name: "Bahraini Dinar", group: "fiat" },
  { code: "BMD", name: "Bermudian Dollar", group: "fiat" },
  { code: "BRL", name: "Brazil Real", group: "fiat" },
  { code: "CAD", name: "Canadian Dollar", group: "fiat" },
  { code: "CHF", name: "Swiss Franc", group: "fiat" },
  { code: "CLP", name: "Chilean Peso", group: "fiat" },
  { code: "CZK", name: "Czech Koruna", group: "fiat" },
  { code: "DKK", name: "Danish Krone", group: "fiat" },
  { code: "GBP", name: "British Pound Sterling", group: "fiat" },
  { code: "GEL", name: "Georgian Lari", group: "fiat" },
  { code: "HKD", name: "Hong Kong Dollar", group: "fiat" },
  { code: "HUF", name: "Hungarian Forint", group: "fiat" },
  { code: "ILS", name: "Israeli New Shekel", group: "fiat" },
  { code: "INR", name: "Indian Rupee", group: "fiat" },
  { code: "KWD", name: "Kuwaiti Dinar", group: "fiat" },
  { code: "LKR", name: "Sri Lankan Rupee", group: "fiat" },
  { code: "MMK", name: "Burmese Kyat", group: "fiat" },
  { code: "MXN", name: "Mexican Peso", group: "fiat" },
  { code: "MYR", name: "Malaysian Ringgit", group: "fiat" },
  { code: "NGN", name: "Nigerian Naira", group: "fiat" },
  { code: "NOK", name: "Norwegian Krone", group: "fiat" },
  { code: "NZD", name: "New Zealand Dollar", group: "fiat" },
  { code: "PHP", name: "Philippine Peso", group: "fiat" },
  { code: "PKR", name: "Pakistani Rupee", group: "fiat" },
  { code: "PLN", name: "Polish Zloty", group: "fiat" },
  { code: "SAR", name: "Saudi Riyal", group: "fiat" },
  { code: "SEK", name: "Swedish Krona", group: "fiat" },
  { code: "SGD", name: "Singapore Dollar", group: "fiat" },
  { code: "THB", name: "Thai Baht", group: "fiat" },
  { code: "TRY", name: "Turkish Lira", group: "fiat" },
  { code: "UAH", name: "Ukrainian hryvnia", group: "fiat" },
  { code: "VEF", name: "Venezuelan bolívar fuerte", group: "fiat" },
  { code: "VND", name: "Vietnamese đồng", group: "fiat" },
  { code: "ZAR", name: "South African Rand", group: "fiat" },
  { code: "XDR", name: "IMF Special Drawing Rights", group: "fiat" },
];

export const CURRENCIES: readonly Currency[] = Object.freeze([...SUGGESTED_CURRENCIES, ...FIAT_CURRENCIES]);

const CURRENCIES_BY_CODE = new Map<string, Currency>(CURRENCIES.map((c) => [c.code, c]));

export const DEFAULT_CURRENCY_CODE = "USD";

/**
 * Look up a currency by its code. Falls back to USD when the code is unknown
 * (e.g. an old localStorage value from a since-removed currency).
 */
export function getCurrency(code: string | undefined | null): Currency {
  if (!code) return CURRENCIES_BY_CODE.get(DEFAULT_CURRENCY_CODE) as Currency;
  return CURRENCIES_BY_CODE.get(code.toUpperCase()) ?? (CURRENCIES_BY_CODE.get(DEFAULT_CURRENCY_CODE) as Currency);
}

export function isSuggestedCode(code: string): boolean {
  return SUGGESTED_SET.has(code.toUpperCase());
}

/**
 * Case-insensitive substring match against the currency code and the localized
 * name. Returns currencies in their canonical (suggested-then-fiat) order so
 * callers can split the result by `group` for sectioned rendering.
 */
export function searchCurrencies(query: string): Currency[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [...CURRENCIES];
  return CURRENCIES.filter(
    (c) => c.code.toLowerCase().includes(normalized) || c.name.toLowerCase().includes(normalized),
  );
}
