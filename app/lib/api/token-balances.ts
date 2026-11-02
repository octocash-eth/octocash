import { type Address, erc20Abi, formatUnits, zeroAddress } from "viem";
import { chains } from "~/data/supported-chains";
import { getPublicClient } from "../public-client";
import type { ConsolidationState, TokenAmount } from "../types";
import { scanBalances } from "./balance-scanner";
import { type DeloraCatalog, deloraPriceKey, EXTRA_TOKENS, fetchDeloraPrices } from "./delora";

/**
 * A token to check balances for. Metadata and price are optional: whatever is
 * missing for a token that turns out to be held is looked up (RPC for
 * metadata, Delora `/v1/prices` for the price).
 */
export interface TokenRef {
  chainId: number;
  token: Address;
  symbol?: string;
  name?: string;
  decimals?: number;
  priceUSD?: number;
}

/** Balances worth less than this (or unpriced) are dropped as dust. */
const DUST_USD = 0.01;

type Metadata = { symbol: string; name?: string; decimals: number };

/** `${chainId}:${lowercased token}` → on-chain metadata, `null` when unreadable. */
const metadataCache = new Map<string, Metadata | null>();

/** Test-only: forget cached on-chain metadata. */
export function resetTokenMetadataCache(): void {
  metadataCache.clear();
}

const refKey = (chainId: number, token: Address) => `${chainId}:${token.toLowerCase()}`;

async function readMetadata(chainId: number, tokens: Address[]): Promise<void> {
  const missing = tokens.filter((t) => !metadataCache.has(refKey(chainId, t)));
  if (missing.length === 0) return;
  try {
    const results = await getPublicClient(chainId).multicall({
      contracts: missing.flatMap((address) => [
        { address, abi: erc20Abi, functionName: "name" as const },
        { address, abi: erc20Abi, functionName: "symbol" as const },
        { address, abi: erc20Abi, functionName: "decimals" as const },
      ]),
      allowFailure: true,
    });
    missing.forEach((token, i) => {
      const [name, symbol, decimals] = results.slice(i * 3, i * 3 + 3);
      metadataCache.set(
        refKey(chainId, token),
        symbol?.status === "success" && decimals?.status === "success"
          ? {
              symbol: symbol.result as string,
              decimals: Number(decimals.result),
              name: name?.status === "success" ? (name.result as string) : undefined,
            }
          : null,
      );
    });
  } catch (error) {
    // Not cached: a transient RPC failure shouldn't hide the token for the session.
    console.error(`[TokenBalances] Metadata multicall failed for chain ${chainId}:`, error);
  }
}

/**
 * Read `wallets`' balances of `refs` on `chainId` over RPC (one balance
 * scanner pass), then attach metadata and drop dust. Throws if the scan
 * fails, so a query never caches a partial view.
 */
export async function fetchTokenBalances(
  chainId: number,
  wallets: readonly Address[],
  refs: readonly TokenRef[],
): Promise<TokenAmount[]> {
  const byToken = new Map<string, TokenRef>();
  for (const ref of refs) {
    if (ref.chainId === chainId && !byToken.has(ref.token.toLowerCase())) byToken.set(ref.token.toLowerCase(), ref);
  }
  if (wallets.length === 0 || byToken.size === 0) return [];

  const balances = await scanBalances(
    chainId,
    wallets,
    [...byToken.values()].map((r) => r.token),
  );
  if (balances.size === 0) return [];

  const walletByLower = new Map(wallets.map((w) => [w.toLowerCase(), w]));
  const held = [...balances].map(([key, amount]) => {
    const [token, wallet] = key.split(":");
    return { ref: byToken.get(token) as TokenRef, wallet: walletByLower.get(wallet) as Address, amount };
  });

  // Metadata: from the ref, the chain's native currency, or on-chain.
  const nativeCurrency = chains[chainId as keyof typeof chains]?.nativeCurrency;
  const metadataOf = (ref: TokenRef): Metadata | null => {
    if (ref.symbol !== undefined && ref.decimals !== undefined) {
      return { symbol: ref.symbol, name: ref.name, decimals: ref.decimals };
    }
    if (ref.token === zeroAddress) return nativeCurrency ?? null;
    return metadataCache.get(refKey(chainId, ref.token)) ?? null;
  };
  await readMetadata(chainId, [...new Set(held.filter((h) => metadataOf(h.ref) === null).map((h) => h.ref.token))]);

  // Prices: the ref's snapshot (Delora catalog) or a Delora /v1/prices lookup.
  const unpriced = [...new Set(held.filter((h) => h.ref.priceUSD === undefined).map((h) => h.ref.token))];
  const fetched = await fetchDeloraPrices(unpriced.map((token) => ({ chainId, token })));

  const out: TokenAmount[] = [];
  for (const { ref, wallet, amount } of held) {
    const metadata = metadataOf(ref);
    if (!metadata) continue;
    const price = ref.priceUSD ?? fetched.get(deloraPriceKey(chainId, ref.token));
    if (price === undefined || Number(formatUnits(amount, metadata.decimals)) * price < DUST_USD) continue;
    out.push({
      token: ref.token,
      amount,
      chainId,
      walletAddress: wallet,
      symbol: metadata.symbol,
      decimals: metadata.decimals,
      name: metadata.name,
    });
  }
  return out;
}

/** Every entry of a chain's Delora catalog, as scan refs (with metadata and price). */
export function catalogTokenRefs(chainId: number, catalog: DeloraCatalog): TokenRef[] {
  return [...catalog.values()].map(({ address, ...meta }) => ({ chainId, token: address, ...meta }));
}

/**
 * Tokens recent consolidations sent to or drew from — the "must check" list,
 * so a swap's output shows up on the next RPC refresh without asking Zerion.
 */
export function watchedTokensFromConsolidations(records: readonly ConsolidationState[]): TokenRef[] {
  return records.flatMap((r) =>
    [r.destinationToken, ...r.sourceTokens].map((t) => ({
      chainId: t.chainId,
      token: t.token,
      symbol: t.symbol,
      name: t.name,
      decimals: t.decimals,
    })),
  );
}

/** Hand-curated staked/LP tokens (data/staked-tokens.ts) as scan refs. */
export const STAKED_TOKEN_REFS: readonly TokenRef[] = EXTRA_TOKENS.map((t) => ({
  chainId: t.chainId,
  token: t.address,
}));

/**
 * The out-of-catalog tokens to check on `chainId`: deduped `sources` minus
 * anything the catalog scan already covers. With no catalog (it failed to
 * load) the native coin is added so it's still checked.
 */
export function extraTokenRefs(
  chainId: number,
  catalog: DeloraCatalog | undefined,
  sources: readonly TokenRef[],
): TokenRef[] {
  const out = new Map<string, TokenRef>();
  if (!catalog) out.set(zeroAddress, { chainId, token: zeroAddress });
  for (const ref of sources) {
    if (ref.chainId !== chainId) continue;
    const key = ref.token.toLowerCase();
    if (catalog?.has(key)) continue;
    // Prefer the entry that carries metadata.
    if (!out.has(key) || out.get(key)?.symbol === undefined) out.set(key, ref);
  }
  return [...out.values()];
}
