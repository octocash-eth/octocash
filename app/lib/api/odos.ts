import { type Address, erc20Abi, formatUnits, isAddressEqual, parseUnits, zeroAddress } from "viem";
import { STAKED_TOKENS } from "~/data/staked-tokens";
import { wrappedNative } from "~/data/supported-chains";
import { USDC } from "~/data/token-contracts";
import { getPublicClient } from "../public-client";
import { groupTokensByChain } from "../tokens";
import type { TokenAmount } from "../types";

function isEffectivelyZero(balance: number): boolean {
  return balance < 0.01; // Consider anything less than $0.01 as effectively zero
}

export const EXTRA_TOKENS = STAKED_TOKENS.map((token) => {
  const [chainId, address] = token.split(":") as [string, Address];
  return { chainId: Number(chainId), address: address as Address };
});

// Odos pricing API response type
interface OdosPricingResponse {
  currencyId: string;
  tokenPrices: Record<string, number | null>;
}

// Odos `/token?query=&chainId=N` returns an array of token catalog entries.
// We only care about the address; the rest is metadata we already have.
interface OdosTokenInfo {
  address: string;
  chainId: string;
  symbol: string;
  name: string;
  decimals: number;
  isWhitelisted: boolean;
}

/**
 * Fetch Odos's swappable-token catalog for a single chain.
 *
 * Returns a Set of lowercased addresses. Throws on non-2xx so callers (e.g.
 * TanStack Query) can observe the failure and decide whether to fail open.
 * Native ETH is represented in the response as `0x0000…0000`, which matches
 * the `zeroAddress` we use internally — no special-casing required.
 */
export async function fetchOdosTokensForChain(chainId: number, signal?: AbortSignal): Promise<ReadonlySet<string>> {
  const url = new URL("https://api.odos.xyz/token");
  url.searchParams.set("query", "");
  url.searchParams.set("chainId", String(chainId));

  const response = await fetch(url.toString(), {
    headers: { accept: "application/json" },
    signal,
  });

  if (!response.ok) {
    throw new Error(`Odos /token failed for chain ${chainId}: ${response.status} ${response.statusText}`);
  }

  const data: OdosTokenInfo[] = await response.json();
  return new Set(data.map((t) => t.address.toLowerCase()));
}

/**
 * Input for {@link checkOdosRoutableToUsdc}. `unitaryPrice` is required so we
 * can normalise the probe to a $1-equivalent amount regardless of the token's
 * decimals/price — callers that don't have a price should skip the probe.
 *
 * Requests use viem `zeroAddress` as `userAddr` so routability discovery does
 * not disclose real wallet addresses to Odos (only route existence is needed).
 */
export interface RoutabilityProbe {
  chainId: number;
  token: Address;
  decimals: number;
  unitaryPrice: number;
}

const ODOS_QUOTE_V3_URL = "https://api.odos.xyz/sor/quote/v3";

/**
 * Probe whether Odos can quote a swap from `token` → USDC on the same chain.
 *
 * Used by the wallet table to re-admit tokens that aren't in Odos's `/token`
 * catalog but still have a live route through `/sor/quote/v3` (the same
 * endpoint planning uses). We send a normalised ~$1-equivalent input amount
 * derived from `unitaryPrice` so the probe is stable across token decimals
 * and price magnitudes. `userAddr` on the quote request is the zero address
 * so Odos logs do not record the viewer's wallet for this discovery-only call.
 *
 * Returns `false` (without making a request) when the chain has no mapped
 * USDC address or when the input token already *is* USDC, since neither is a
 * meaningful "swap to USDC" question. Any non-2xx response, network error,
 * or zero/missing `outAmounts` also yields `false` — failing closed is OK
 * here because the only consequence is the token staying hidden until the
 * user refreshes.
 */
export async function checkOdosRoutableToUsdc(probe: RoutabilityProbe, signal?: AbortSignal): Promise<boolean> {
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
    const response = await fetch(ODOS_QUOTE_V3_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", accept: "application/json" },
      signal,
      body: JSON.stringify({
        chainId: probe.chainId,
        inputTokens: [{ tokenAddress: probe.token, amount: amount.toString() }],
        outputTokens: [{ tokenAddress: usdc, proportion: 1 }],
        userAddr: zeroAddress,
        slippageLimitPercent: 0.3,
        referralCode: 0,
        disableRFQs: true,
        compact: false,
        simple: true,
      }),
    });

    if (!response.ok) return false;

    const data = (await response.json()) as { outAmounts?: string[] };
    const outAmountStr = data.outAmounts?.[0];
    if (outAmountStr === undefined) return false;
    try {
      return BigInt(outAmountStr) > 0n;
    } catch {
      return false;
    }
  } catch (error) {
    if (signal?.aborted) return false;
    console.warn(`[OdosRoutable] Probe failed for ${probe.chainId}:${probe.token}:`, error);
    return false;
  }
}

export type OdosPriceKey = `${number}:${string}`;
export const odosPriceKey = (chainId: number, address: Address): OdosPriceKey => `${chainId}:${address.toLowerCase()}`;

/**
 * Fetch Odos token prices for the given (chainId, token) pairs.
 *
 * - Groups by chainId, dedupes addresses, issues one fetch per chain in parallel.
 * - For native tokens (zeroAddress), we ignore Odos's `0xeeee…eEEE` sentinel
 *   entirely and ask for the chain's wrapped-native equivalent (WETH/WPOL/…)
 *   instead, because the sentinel quote is unreliable on several L2s (off by
 *   ~12% on Optimism vs the WETH spot on the same chain). Native and
 *   wrapped-native are 1:1 redeemable, so the wrapped price is the correct
 *   number for both. Results are still keyed back under `zeroAddress` so
 *   callers don't need to know about the substitution.
 * - Returned map keys are `${chainId}:${lowercase address}`. Use `odosPriceKey()`.
 * - Per-chain failures are swallowed and logged; missing keys mean "no price".
 */
export async function fetchOdosPrices(
  tokens: ReadonlyArray<Pick<TokenAmount, "chainId" | "token">>,
  signal?: AbortSignal,
): Promise<Map<OdosPriceKey, number>> {
  const prices = new Map<OdosPriceKey, number>();
  if (tokens.length === 0) return prices;

  const byChain = groupTokensByChain(tokens.map((t) => ({ chainId: t.chainId, token: t.token })));

  await Promise.all(
    Array.from(byChain.entries()).map(async ([chainId, chainTokens]) => {
      try {
        // Dedupe addresses (case-insensitive).
        const uniqueAddresses = new Set<string>();
        for (const t of chainTokens) {
          uniqueAddresses.add(t.token.toLowerCase());
        }

        // Resolve the wrapped-native address for this chain so we can quote
        // native balances against it. May be undefined for chains we haven't
        // mapped yet, in which case native tokens just won't get priced.
        const wrappedNativeLc = wrappedNative[chainId]?.toLowerCase();

        // Build the request set, substituting zeroAddress -> wrapped-native.
        // Using a Set so a caller that asks for both native AND wrapped-native
        // doesn't make us send the same address twice.
        const requestAddresses = new Set<string>();
        for (const addr of uniqueAddresses) {
          if (isAddressEqual(addr as Address, zeroAddress)) {
            if (wrappedNativeLc !== undefined) requestAddresses.add(wrappedNativeLc);
          } else {
            requestAddresses.add(addr);
          }
        }

        if (requestAddresses.size === 0) return;

        const url = new URL(`https://api.odos.xyz/pricing/token/${chainId}`);
        for (const addr of requestAddresses) {
          url.searchParams.append("token_addresses", addr);
        }

        const response = await fetch(url.toString(), {
          headers: { accept: "application/json" },
          signal,
        });

        if (!response.ok) {
          console.warn(`[OdosPrices] Failed to fetch prices for chain ${chainId}: ${response.status}`);
          return;
        }

        const data: OdosPricingResponse = await response.json();

        // Build a lowercase-keyed view of the response for case-insensitive lookup.
        const tokenPricesLc: Record<string, number | null> = {};
        for (const [k, v] of Object.entries(data.tokenPrices)) {
          tokenPricesLc[k.toLowerCase()] = v;
        }

        for (const addr of uniqueAddresses) {
          const isNative = isAddressEqual(addr as Address, zeroAddress);
          const lookup = isNative ? wrappedNativeLc : addr;
          if (lookup === undefined) continue;
          const price = tokenPricesLc[lookup];
          if (price !== null && price !== undefined) {
            prices.set(odosPriceKey(chainId, addr as Address), price);
          }
        }
      } catch (error) {
        if (signal?.aborted) return;
        console.error(`[OdosPrices] Odos pricing API failed for chain ${chainId}:`, error);
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

    // Step 5: Fetch Odos prices once, then use them in-place to drop dust
    // and order by USD value descending. We deliberately do NOT stamp the
    // price onto the returned `TokenAmount` — downstream consumers read
    // live prices from the central price context to avoid two-sources-of-
    // truth bugs (see app/context/token-price-provider.tsx).
    const prices = await fetchOdosPrices(tokenAmounts);
    const usdValue = (t: TokenAmount): number => {
      const price = prices.get(odosPriceKey(t.chainId, t.token));
      if (price === undefined) return 0;
      return Number(formatUnits(t.amount, t.decimals)) * price;
    };

    return tokenAmounts.filter((t) => !isEffectivelyZero(usdValue(t))).sort((a, b) => usdValue(b) - usdValue(a));
  } catch (error) {
    console.error("[ExtraTokens] Error fetching extra token balances:", error);
    return [];
  }
}
