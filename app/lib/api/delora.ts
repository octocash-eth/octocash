import { type Address, erc20Abi, formatUnits, isAddressEqual, parseUnits, zeroAddress } from "viem";
import { STAKED_TOKENS } from "~/data/staked-tokens";
import { USDC } from "~/data/token-contracts";
import { getPublicClient } from "../public-client";
import { groupTokensByChain } from "../tokens";
import type { TokenAmount } from "../types";
import { deloraBaseUrl, deloraHeaders } from "./delora-client";

function isEffectivelyZero(balance: number): boolean {
  return balance < 0.01; // Consider anything less than $0.01 as effectively zero
}

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
// of token catalog entries. We only care about the address; the rest is
// metadata we already have.
interface DeloraTokenInfo {
  address: string;
  chainId: number;
  symbol: string;
  name: string;
  decimals: number;
}

/**
 * Fetch Delora's swappable-token catalog for a single chain.
 *
 * Returns a Set of lowercased addresses. Throws on non-2xx so callers (e.g.
 * TanStack Query) can observe the failure and decide whether to fail open.
 * Native ETH is represented in the response as `0x0000…0000`, which matches
 * the `zeroAddress` we use internally — no special-casing required.
 */
export async function fetchDeloraTokensForChain(chainId: number, signal?: AbortSignal): Promise<ReadonlySet<string>> {
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
  const tokens = data[String(chainId)] ?? [];
  return new Set(tokens.map((t) => t.address.toLowerCase()));
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
 * Maximum `chainId:address` pairs per `/v1/prices` request, to keep the URL
 * comfortably under common length limits (each pair is ~46 chars).
 */
const PRICES_CHUNK_SIZE = 100;

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

/** Fetch extra token balances via RPC (slower, for tokens not indexed by Zerion) */
export async function fetchExtraTokenBalances(walletAddresses: string[]): Promise<TokenAmount[]> {
  try {
    if (walletAddresses.length === 0) return [];

    // Step 1: Group tokens by chainId for efficient multicall
    const tokensByChain = groupTokensByChain(EXTRA_TOKENS);
    const nonEmptyBalances: {
      chainId: number;
      tokenAddress: Address;
      walletAddress: Address;
      amount: bigint;
    }[] = [];

    // Step 2: Check balances for ALL wallets and ALL tokens using multicall
    await Promise.all(
      Array.from(tokensByChain.entries()).map(async ([chainId, tokens]) => {
        try {
          const publicClient = getPublicClient(chainId);

          // For each token, check balance for each wallet
          // We flatten this into a single list of calls
          const contracts = tokens.flatMap((token) =>
            walletAddresses.map((walletAddress) => ({
              address: token.address,
              abi: erc20Abi,
              functionName: "balanceOf" as const,
              args: [walletAddress as Address],
            })),
          );

          // Execute multicall
          const results = await publicClient.multicall({
            contracts,
            allowFailure: true,
          });

          // Process results
          // The order matches: tokens[0] -> (wallets[0], wallets[1]...), tokens[1] -> ...
          let resultIndex = 0;
          for (const token of tokens) {
            for (const walletAddress of walletAddresses) {
              const result = results[resultIndex++];

              if (result.status === "success" && (result.result as bigint) > 0n) {
                nonEmptyBalances.push({
                  chainId,
                  tokenAddress: token.address,
                  walletAddress: walletAddress as Address,
                  amount: result.result as bigint,
                });
              }
            }
          }
        } catch (error) {
          console.error(`[ExtraTokens] Balance multicall failed for chain ${chainId}:`, error);
        }
      }),
    );

    // If no non-zero balances, return early
    if (nonEmptyBalances.length === 0) {
      return [];
    }

    // Step 3: Fetch metadata ONLY for tokens with non-zero balances
    // We need unique tokens per chain to avoid fetching metadata twice for the same token
    const uniqueTokensWithBalance = nonEmptyBalances.reduce((acc, item) => {
      const key = `${item.chainId}:${item.tokenAddress}`;
      if (!acc.has(key)) {
        acc.set(key, { chainId: item.chainId, address: item.tokenAddress });
      }
      return acc;
    }, new Map<string, { chainId: number; address: Address }>());

    const tokensToFetchMetadata = groupTokensByChain(Array.from(uniqueTokensWithBalance.values()));
    const tokenMetadata = new Map<string, { name: string; symbol: string; decimals: number }>();

    await Promise.all(
      Array.from(tokensToFetchMetadata.entries()).map(async ([chainId, tokens]) => {
        try {
          const publicClient = getPublicClient(chainId);
          const contracts = tokens.flatMap((token) => [
            {
              address: token.address,
              abi: erc20Abi,
              functionName: "name" as const,
            },
            {
              address: token.address,
              abi: erc20Abi,
              functionName: "symbol" as const,
            },
            {
              address: token.address,
              abi: erc20Abi,
              functionName: "decimals" as const,
            },
          ]);

          const results = await publicClient.multicall({
            contracts,
            allowFailure: true,
          });

          for (let i = 0; i < tokens.length; i++) {
            const token = tokens[i];
            const baseIndex = i * 3;
            const nameResult = results[baseIndex];
            const symbolResult = results[baseIndex + 1];
            const decimalsResult = results[baseIndex + 2];

            if (
              nameResult.status === "success" &&
              symbolResult.status === "success" &&
              decimalsResult.status === "success"
            ) {
              const key = `${chainId}:${token.address}`;
              tokenMetadata.set(key, {
                name: nameResult.result as string,
                symbol: symbolResult.result as string,
                decimals: decimalsResult.result as number,
              });
            }
          }
        } catch (error) {
          console.error(`[ExtraTokens] Metadata multicall failed for chain ${chainId}:`, error);
        }
      }),
    );

    // Step 4: Construct initial TokenAmount objects
    const tokenAmounts: TokenAmount[] = [];
    for (const item of nonEmptyBalances) {
      const metadata = tokenMetadata.get(`${item.chainId}:${item.tokenAddress}`);
      if (metadata) {
        tokenAmounts.push({
          token: item.tokenAddress,
          amount: item.amount,
          chainId: item.chainId,
          walletAddress: item.walletAddress,
          name: metadata.name,
          symbol: metadata.symbol,
          decimals: metadata.decimals,
        });
      }
    }

    if (tokenAmounts.length === 0) return [];

    // Step 5: Fetch Delora prices once, then use them in-place to drop dust
    // and order by USD value descending. We deliberately do NOT stamp the
    // price onto the returned `TokenAmount` — downstream consumers read
    // live prices from the central price context to avoid two-sources-of-
    // truth bugs (see app/context/token-price-provider.tsx).
    const prices = await fetchDeloraPrices(tokenAmounts);
    const usdValue = (t: TokenAmount): number => {
      const price = prices.get(deloraPriceKey(t.chainId, t.token));
      if (price === undefined) return 0;
      return Number(formatUnits(t.amount, t.decimals)) * price;
    };

    return tokenAmounts.filter((t) => !isEffectivelyZero(usdValue(t))).sort((a, b) => usdValue(b) - usdValue(a));
  } catch (error) {
    console.error("[ExtraTokens] Error fetching extra token balances:", error);
    return [];
  }
}
