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

export type CurrencyGroup = "suggested" | "fiat" | "asset";

export interface Currency {
  code: string;
  name: string;
  group: CurrencyGroup;
  /**
   * BCP-47 locale used by `Intl.NumberFormat` to render this currency. We pick
   * the issuing region's locale so users see the currency in its native
   * convention (e.g. `10,00 €` for EUR, `￥1,235` for JPY), independent of the
   * viewer's browser locale.
   */
  locale: string;
}

/**
 * Order matters here — these render in this exact order in the "Suggested"
 * section of the modal, matching the design.
 */
export const SUGGESTED_CODES = ["USD", "IDR", "TWD", "EUR", "KRW", "JPY", "RUB", "CNY"] as const;

const SUGGESTED_SET = new Set<string>(SUGGESTED_CODES);

const SUGGESTED_CURRENCIES: Currency[] = [
  { code: "USD", name: "US Dollar", group: "suggested", locale: "en-US" },
  { code: "IDR", name: "Indonesian Rupiah", group: "suggested", locale: "id-ID" },
  { code: "TWD", name: "New Taiwan Dollar", group: "suggested", locale: "zh-TW" },
  { code: "EUR", name: "Euro", group: "suggested", locale: "de-DE" },
  { code: "KRW", name: "South Korean Won", group: "suggested", locale: "ko-KR" },
  { code: "JPY", name: "Japanese Yen", group: "suggested", locale: "ja-JP" },
  { code: "RUB", name: "Russian Ruble", group: "suggested", locale: "ru-RU" },
  { code: "CNY", name: "Chinese Yuan", group: "suggested", locale: "zh-CN" },
];

const FIAT_CURRENCIES: Currency[] = [
  { code: "AED", name: "United Arab Emirates Dirham", group: "fiat", locale: "ar-AE" },
  { code: "ARS", name: "Argentine Peso", group: "fiat", locale: "es-AR" },
  { code: "AUD", name: "Australian Dollar", group: "fiat", locale: "en-AU" },
  { code: "BDT", name: "Bangladeshi Taka", group: "fiat", locale: "bn-BD" },
  { code: "BHD", name: "Bahraini Dinar", group: "fiat", locale: "ar-BH" },
  { code: "BMD", name: "Bermudian Dollar", group: "fiat", locale: "en-BM" },
  { code: "BRL", name: "Brazil Real", group: "fiat", locale: "pt-BR" },
  { code: "CAD", name: "Canadian Dollar", group: "fiat", locale: "en-CA" },
  { code: "CHF", name: "Swiss Franc", group: "fiat", locale: "de-CH" },
  { code: "CLP", name: "Chilean Peso", group: "fiat", locale: "es-CL" },
  { code: "CZK", name: "Czech Koruna", group: "fiat", locale: "cs-CZ" },
  { code: "DKK", name: "Danish Krone", group: "fiat", locale: "da-DK" },
  { code: "GBP", name: "British Pound Sterling", group: "fiat", locale: "en-GB" },
  { code: "GEL", name: "Georgian Lari", group: "fiat", locale: "ka-GE" },
  { code: "HKD", name: "Hong Kong Dollar", group: "fiat", locale: "zh-HK" },
  { code: "HUF", name: "Hungarian Forint", group: "fiat", locale: "hu-HU" },
  { code: "ILS", name: "Israeli New Shekel", group: "fiat", locale: "he-IL" },
  { code: "INR", name: "Indian Rupee", group: "fiat", locale: "en-IN" },
  { code: "KWD", name: "Kuwaiti Dinar", group: "fiat", locale: "ar-KW" },
  { code: "LKR", name: "Sri Lankan Rupee", group: "fiat", locale: "si-LK" },
  { code: "MMK", name: "Burmese Kyat", group: "fiat", locale: "my-MM" },
  { code: "MXN", name: "Mexican Peso", group: "fiat", locale: "es-MX" },
  { code: "MYR", name: "Malaysian Ringgit", group: "fiat", locale: "ms-MY" },
  { code: "NGN", name: "Nigerian Naira", group: "fiat", locale: "en-NG" },
  { code: "NOK", name: "Norwegian Krone", group: "fiat", locale: "nb-NO" },
  { code: "NZD", name: "New Zealand Dollar", group: "fiat", locale: "en-NZ" },
  { code: "PHP", name: "Philippine Peso", group: "fiat", locale: "en-PH" },
  { code: "PKR", name: "Pakistani Rupee", group: "fiat", locale: "en-PK" },
  { code: "PLN", name: "Polish Zloty", group: "fiat", locale: "pl-PL" },
  { code: "SAR", name: "Saudi Riyal", group: "fiat", locale: "ar-SA" },
  { code: "SEK", name: "Swedish Krona", group: "fiat", locale: "sv-SE" },
  { code: "SGD", name: "Singapore Dollar", group: "fiat", locale: "en-SG" },
  { code: "THB", name: "Thai Baht", group: "fiat", locale: "th-TH" },
  { code: "TRY", name: "Turkish Lira", group: "fiat", locale: "tr-TR" },
  { code: "UAH", name: "Ukrainian hryvnia", group: "fiat", locale: "uk-UA" },
  { code: "VEF", name: "Venezuelan bolívar fuerte", group: "fiat", locale: "es-VE" },
  { code: "VND", name: "Vietnamese đồng", group: "fiat", locale: "vi-VN" },
  { code: "ZAR", name: "South African Rand", group: "fiat", locale: "en-ZA" },
  { code: "XDR", name: "IMF Special Drawing Rights", group: "fiat", locale: "en-US" },
];

/**
 * Non-fiat stores of value. CoinGecko's `/exchange_rates` snapshot exposes BTC
 * and ETH as `crypto` and gold (XAU) as a `commodity`, so all three convert
 * through the same BTC-denominated pipeline as the fiat currencies above.
 */
const ASSET_CURRENCIES: Currency[] = [
  { code: "BTC", name: "Bitcoin", group: "asset", locale: "en-US" },
  { code: "ETH", name: "Ethereum", group: "asset", locale: "en-US" },
  { code: "XAU", name: "Gold (troy ounce)", group: "asset", locale: "en-US" },
];

export const CURRENCIES: readonly Currency[] = Object.freeze([
  ...SUGGESTED_CURRENCIES,
  ...FIAT_CURRENCIES,
  ...ASSET_CURRENCIES,
]);

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
 * Returns the BCP-47 locale associated with a currency code. Falls back to the
 * default currency's locale when the code is unknown.
 */
export function getCurrencyLocale(code: string | undefined | null): string {
  return getCurrency(code).locale;
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
