import { type Address, getAddress, isAddress, isAddressEqual, parseUnits, zeroAddress } from "viem";
import { STAKED_TOKENS } from "~/data/staked-tokens";
import { USDC } from "~/data/token-contracts";
import type { TokenAmount } from "../types";
import { deloraBaseUrl, deloraHeaders } from "./delora-client";

export const EXTRA_TOKENS = STAKED_TOKENS.map((token) => {
  const [chainId, address] = token.split(":") as [string, Address];
  return { chainId: Number(chainId), address: address as Address };
});

// Delora `/v1/prices` response type
interface DeloraPricesResponse {
  prices: {
    chainId: number;
    token: string;
    priceUSD: string;
    source?: string;
    updatedAt?: string;
    stale?: boolean;
  }[];
}

// Delora `/v1/tokens?chains=N` returns a record keyed by chainId with arrays
// of token catalog entries.
interface DeloraTokenInfo {
  address: string;
  chainId: number;
  symbol: string;
  name: string;
  decimals: number;
  priceUSD?: string | null;
}

/** A Delora catalog entry, normalised for balance scanning and display. */
export interface DeloraCatalogToken {
  address: Address;
  symbol: string;
  name: string;
  decimals: number;
  /** Catalog price snapshot; absent for unpriced entries. */
  priceUSD?: number;
}

/** Lowercased address → catalog entry. */
export type DeloraCatalog = ReadonlyMap<string, DeloraCatalogToken>;

/**
 * Fetch Delora's swappable-token catalog for a single chain.
 *
 * Returns a Map keyed by lowercased address. Entries that aren't plain EVM
 * addresses (mainnet lists a few `facet_0x…` ids) are dropped. Throws on
 * non-2xx so callers (e.g. TanStack Query) can observe the failure and decide
 * whether to fail open. Native ETH is represented in the response as
 * `0x0000…0000`, which matches the `zeroAddress` we use internally — no
 * special-casing required.
 */
export async function fetchDeloraTokensForChain(chainId: number, signal?: AbortSignal): Promise<DeloraCatalog> {
  const url = new URL(`${deloraBaseUrl()}/v1/tokens`);
  url.searchParams.set("chains", String(chainId));

  const response = await fetch(url.toString(), {
    headers: deloraHeaders({ accept: "application/json" }),
    signal,
  });

  if (!response.ok) {
    throw new Error(`Delora /v1/tokens failed for chain ${chainId}: ${response.status} ${response.statusText}`);
  }

  const data: Record<string, DeloraTokenInfo[]> = await response.json();
  const catalog = new Map<string, DeloraCatalogToken>();
  for (const t of data[String(chainId)] ?? []) {
    if (!isAddress(t.address, { strict: false })) continue;
    const price = t.priceUSD == null ? Number.NaN : Number(t.priceUSD);
    catalog.set(t.address.toLowerCase(), {
      address: getAddress(t.address.toLowerCase()),
      symbol: t.symbol,
      name: t.name,
      decimals: t.decimals,
      ...(Number.isFinite(price) && price > 0 ? { priceUSD: price } : {}),
    });
  }
  return catalog;
}

/**
 * Input for {@link checkDeloraRoutableToUsdc}. `unitaryPrice` is required so
 * we can normalise the probe to a $1-equivalent amount regardless of the
 * token's decimals/price — callers that don't have a price should skip the
 * probe.
 *
 * Requests use viem `zeroAddress` as `senderAddress` so routability discovery
 * does not disclose real wallet addresses to Delora (only route existence is
 * needed).
 */
export interface RoutabilityProbe {
  chainId: number;
  token: Address;
  decimals: number;
  unitaryPrice: number;
}

/**
 * Probe whether Delora can quote a swap from `token` → USDC on the same chain.
 *
 * Used by the wallet table to re-admit tokens that aren't in Delora's
 * `/v1/tokens` catalog but still have a live route through `/v1/quotes` (the
 * same endpoint planning uses). We send a normalised ~$1-equivalent input
 * amount derived from `unitaryPrice` so the probe is stable across token
 * decimals and price magnitudes. `senderAddress` on the quote request is the
 * zero address so Delora logs do not record the viewer's wallet for this
 * discovery-only call. No integrator/fee params are sent — this is not a
 * monetizable swap.
 *
 * Returns `false` (without making a request) when the chain has no mapped
 * USDC address or when the input token already *is* USDC, since neither is a
 * meaningful "swap to USDC" question. Any non-2xx response (including the
 * deterministic "No adapters available" 500 for unroutable tokens), network
 * error, or zero/missing `outputAmount` also yields `false` — failing closed
 * is OK here because the only consequence is the token staying hidden until
 * the user refreshes.
 */
export async function checkDeloraRoutableToUsdc(probe: RoutabilityProbe, signal?: AbortSignal): Promise<boolean> {
  const usdc = USDC[probe.chainId];
  if (usdc === undefined) return false;
  if (isAddressEqual(probe.token, usdc)) return false;
  if (!Number.isFinite(probe.unitaryPrice) || probe.unitaryPrice <= 0) return false;

  // Normalise to ~$1 of input. `parseUnits` only accepts a fixed-point string
  // with at most `decimals` fractional digits, so we cap to `decimals` and
  // clamp the resulting amount to 1n in the degenerate case where the
  // truncated string evaluates to zero (extreme-priced or low-decimal tokens).
  let amount: bigint;
  try {
    const tokensPerDollar = 1 / probe.unitaryPrice;
    const fixedString = tokensPerDollar.toFixed(probe.decimals);
    amount = parseUnits(fixedString, probe.decimals);
    if (amount === 0n) amount = 1n;
  } catch {
    return false;
  }

  try {
    const url = new URL(`${deloraBaseUrl()}/v1/quotes`);
    url.searchParams.set("senderAddress", zeroAddress);
    url.searchParams.set("originChainId", String(probe.chainId));
    url.searchParams.set("destinationChainId", String(probe.chainId));
    url.searchParams.set("amount", amount.toString());
    url.searchParams.set("originCurrency", probe.token);
    url.searchParams.set("destinationCurrency", usdc);
    url.searchParams.set("slippage", "0.005");

    const response = await fetch(url.toString(), {
      headers: deloraHeaders({ accept: "application/json" }),
      signal,
    });

    if (!response.ok) return false;

    const data = (await response.json()) as { outputAmount?: string };
    if (data.outputAmount === undefined) return false;
    try {
      return BigInt(data.outputAmount) > 0n;
    } catch {
      return false;
    }
  } catch (error) {
    if (signal?.aborted) return false;
    console.warn(`[DeloraRoutable] Probe failed for ${probe.chainId}:${probe.token}:`, error);
    return false;
  }
}

export type DeloraPriceKey = `${number}:${string}`;
export const deloraPriceKey = (chainId: number, address: Address): DeloraPriceKey =>
  `${chainId}:${address.toLowerCase()}`;

/**
 * Maximum `chainId:address` pairs per `/v1/prices` request. Delora rejects
 * larger batches with 400 VALIDATION_ERROR "Too many token price requests.
 * Max is 50." (verified live), so bigger wallets must be chunked.
 */
const PRICES_CHUNK_SIZE = 50;

/**
 * Fetch Delora token prices for the given (chainId, token) pairs.
 *
 * - Delora's `/v1/prices` accepts pairs across chains in a single request
 *   (`?tokens=1:0xabc…,137:0xdef…`), so all chains are batched together;
 *   requests are only split into chunks of {@link PRICES_CHUNK_SIZE} to
 *   bound URL length.
 * - Native tokens (zeroAddress) are priced directly by Delora — no
 *   wrapped-native substitution needed.
 * - Returned map keys are `${chainId}:${lowercase address}`. Use
 *   `deloraPriceKey()`. Stale-flagged entries are still included — a slightly
 *   old price beats a gap, and the price context refreshes every poll.
 * - Failures are swallowed and logged; missing keys mean "no price".
 */
export async function fetchDeloraPrices(
  tokens: ReadonlyArray<Pick<TokenAmount, "chainId" | "token">>,
  signal?: AbortSignal,
): Promise<Map<DeloraPriceKey, number>> {
  const prices = new Map<DeloraPriceKey, number>();
  if (tokens.length === 0) return prices;

  // Dedupe pairs (case-insensitive) across all chains.
  const uniquePairs = new Set<DeloraPriceKey>();
  for (const t of tokens) {
    uniquePairs.add(deloraPriceKey(t.chainId, t.token));
  }
  const pairs = Array.from(uniquePairs);

  const chunks: DeloraPriceKey[][] = [];
  for (let i = 0; i < pairs.length; i += PRICES_CHUNK_SIZE) {
    chunks.push(pairs.slice(i, i + PRICES_CHUNK_SIZE));
  }

  await Promise.all(
    chunks.map(async (chunk) => {
      try {
        const url = new URL(`${deloraBaseUrl()}/v1/prices`);
        url.searchParams.set("tokens", chunk.join(","));

        const response = await fetch(url.toString(), {
          headers: deloraHeaders({ accept: "application/json" }),
          signal,
        });

        if (!response.ok) {
          console.warn(`[DeloraPrices] Failed to fetch prices: ${response.status}`);
          return;
        }

        const data: DeloraPricesResponse = await response.json();
        for (const entry of data.prices ?? []) {
          const price = Number(entry.priceUSD);
          if (Number.isFinite(price)) {
            prices.set(deloraPriceKey(entry.chainId, entry.token as Address), price);
          }
        }
      } catch (error) {
        if (signal?.aborted) return;
        console.error("[DeloraPrices] Delora pricing API failed:", error);
      }
    }),
  );

  return prices;
}
