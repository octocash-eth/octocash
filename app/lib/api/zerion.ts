import { type Address, getAddress, zeroAddress } from "viem";
import { chainIdToZerionId } from "~/data/supported-chains";

/**
 * Zerion is used for token *discovery* only: which tokens a wallet holds,
 * including ones outside Delora's catalog. Balances themselves are always
 * read over RPC (see ./token-balances.ts), so each wallet costs one Zerion
 * request per {@link DISCOVERY_TTL_MS}, not one per refresh.
 */

/** A token Zerion reports the wallet holding. No amount: balances come from RPC. */
export interface DiscoveredToken {
  chainId: number;
  token: Address;
  symbol: string;
  name: string;
  decimals: number;
}

/** How long a wallet's discovery result is reused, across reloads. */
export const DISCOVERY_TTL_MS = 24 * 60 * 60 * 1_000;
const STORAGE_PREFIX = "octocash:zerion-discovery:v1:";

interface CachedDiscovery {
  fetchedAt: number;
  tokens: DiscoveredToken[];
}

function readCache(address: string): DiscoveredToken[] | null {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_PREFIX + address.toLowerCase());
    if (!raw) return null;
    const cached = JSON.parse(raw) as CachedDiscovery;
    if (!Array.isArray(cached.tokens) || Date.now() - cached.fetchedAt > DISCOVERY_TTL_MS) return null;
    return cached.tokens;
  } catch {
    return null;
  }
}

function writeCache(address: string, tokens: DiscoveredToken[]): void {
  try {
    const entry: CachedDiscovery = { fetchedAt: Date.now(), tokens };
    globalThis.localStorage?.setItem(STORAGE_PREFIX + address.toLowerCase(), JSON.stringify(entry));
  } catch {
    // Storage full or blocked: discovery still works, it just isn't reused.
  }
}

/** Tokens below this Zerion-reported USD value aren't worth watching. */
const DISCOVERY_DUST_USD = 0.01;

// Zerion API Types
interface ZerionFungibleInfo {
  name: string;
  symbol: string;
  icon?: {
    url: string;
  } | null;
  implementations: Array<{
    chain_id: string;
    address: string | null;
    decimals: number;
  }>;
}

interface ZerionPositionAttributes {
  parent: string | null;
  protocol: string | null;
  name: string;
  position_type: string;
  quantity: {
    decimals: number;
    numeric: string;
  };
  value: number | null;
  price: number | null;
  fungible_info: ZerionFungibleInfo;
  flags: {
    displayable: boolean;
  };
  chain?: string; // Added: chain identifier for this position
}

interface ZerionPosition {
  type: string;
  id: string;
  attributes: ZerionPositionAttributes;
  relationships?: {
    chain?: {
      data?: {
        id: string;
        type: string;
      };
    };
  };
}

interface ZerionPositionsResponse {
  data: ZerionPosition[];
  links: {
    next?: string;
  };
}

// Zerion's API terms cap us at 3 requests/second. Stay strictly under that:
// at most 2 requests in any rolling 1s window, shared by every caller in the
// tab (retries included), and back off on 429.
const ZERION_MAX_REQUESTS_PER_WINDOW = 2;
const ZERION_WINDOW_MS = 1_000;
const ZERION_MAX_RETRIES = 4;
const ZERION_BASE_BACKOFF_MS = 1_000;
const ZERION_MAX_BACKOFF_MS = 30_000;
/** Per-attempt cap, so a hung Zerion request fails instead of pending forever. */
export const ZERION_TIMEOUT_MS = 10_000;

// Start times of the most recently reserved request slots, in order.
let reservedSlots: number[] = [];

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Reserve the next free request slot and wait for it. Slots are assigned
 * synchronously, so concurrent callers are served FIFO without overshooting.
 */
async function acquireZerionSlot(): Promise<void> {
  const now = Date.now();
  const blocker = reservedSlots[reservedSlots.length - ZERION_MAX_REQUESTS_PER_WINDOW];
  const slot = blocker === undefined ? now : Math.max(now, blocker + ZERION_WINDOW_MS);
  reservedSlots.push(slot);
  reservedSlots = reservedSlots.slice(-ZERION_MAX_REQUESTS_PER_WINDOW);
  if (slot > now) await sleep(slot - now);
}

/** Test-only: forget previously reserved slots. */
export function resetZerionRateLimiter(): void {
  reservedSlots = [];
}

/** Retry-After may be delta-seconds or an HTTP date; returns ms or null. */
function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

/** Rate-limited fetch against Zerion that retries 429s with backoff. */
async function zerionFetch(url: string, init: RequestInit): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    await acquireZerionSlot();
    // Timer starts once the slot is ours, so queueing behind the rate limiter
    // doesn't eat into the attempt's budget.
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error(`Zerion request timed out after ${ZERION_TIMEOUT_MS}ms`)),
      ZERION_TIMEOUT_MS,
    );
    let response: Response;
    try {
      response = await fetch(url, { ...init, signal: controller.signal });
    } catch (error) {
      throw controller.signal.aborted ? controller.signal.reason : error;
    } finally {
      clearTimeout(timer);
    }
    if (response.status !== 429 || attempt >= ZERION_MAX_RETRIES) return response;

    const backoff = Math.min(ZERION_BASE_BACKOFF_MS * 2 ** attempt, ZERION_MAX_BACKOFF_MS);
    const retryAfter = parseRetryAfter(response.headers?.get("Retry-After") ?? null);
    await sleep(Math.min(retryAfter ?? backoff, ZERION_MAX_BACKOFF_MS));
  }
}

/**
 * Discover which tokens `walletAddress` holds on our supported chains.
 *
 * Served from a per-address localStorage cache for {@link DISCOVERY_TTL_MS};
 * otherwise one rate-limited Zerion request. Returns `[]` without a request
 * when no API key is configured. Throws on HTTP errors (nothing is cached),
 * so the caller can retry later.
 */
export async function discoverZerionTokens(walletAddress: string): Promise<DiscoveredToken[]> {
  const apiKey = import.meta.env.VITE_ZERION_API_KEY;
  if (!apiKey) return [];

  const cached = readCache(walletAddress);
  if (cached) return cached;

  const url = new URL(`https://cors.blossom.deno.net/v0/https://api.zerion.io/v1/wallets/${walletAddress}/positions/`);
  url.searchParams.append("filter[chain_ids]", Object.values(chainIdToZerionId).join(","));
  url.searchParams.append("filter[positions]", "only_simple");
  url.searchParams.append("currency", "usd");

  const response = await zerionFetch(url.toString(), {
    headers: {
      // Basic auth: "API_KEY:" base64-encoded.
      Authorization: `Basic ${btoa(`${apiKey}:`)}`,
      accept: "application/json",
    },
  });
  if (!response.ok) {
    throw new Error(`Zerion API error: ${response.status} ${response.statusText}`);
  }

  const data: ZerionPositionsResponse = await response.json();
  const tokens = new Map<string, DiscoveredToken>();

  for (const position of data.data ?? []) {
    try {
      const { attributes } = position;
      if (!attributes.flags.displayable) continue;
      if ((attributes.value ?? 0) < DISCOVERY_DUST_USD) continue;

      const zerionChainId = position.relationships?.chain?.data?.id || attributes.chain;
      if (!zerionChainId) continue;
      const chainId = Number(Object.entries(chainIdToZerionId).find(([, id]) => id === zerionChainId)?.[0]);
      if (!chainId) continue; // not one of our chains

      const implementation = attributes.fungible_info.implementations.find((impl) => impl.chain_id === zerionChainId);
      if (!implementation) continue;

      // Zerion reports Polygon's native POL as 0x…1010; we use zeroAddress.
      const token =
        implementation.address &&
        !(chainId === 137 && implementation.address === "0x0000000000000000000000000000000000001010")
          ? getAddress(implementation.address)
          : zeroAddress;

      tokens.set(`${chainId}:${token.toLowerCase()}`, {
        chainId,
        token,
        symbol: attributes.fungible_info.symbol,
        name: attributes.fungible_info.name,
        decimals: implementation.decimals,
      });
    } catch (error) {
      console.error(`Error processing Zerion position ${position.id}:`, error);
    }
  }

  const result = [...tokens.values()];
  writeCache(walletAddress, result);
  return result;
}
