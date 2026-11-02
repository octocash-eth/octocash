import { type Address, parseUnits, zeroAddress } from "viem";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { USDC } from "../../data/token-contracts";
import {
  checkDeloraRoutableToUsdc,
  deloraPriceKey,
  EXTRA_TOKENS,
  fetchDeloraPrices,
  fetchDeloraTokensForChain,
} from "./delora";

/** Delora `/v1/prices` response for the given (chainId, token, price) rows. */
function pricesResponse(rows: Array<[number, string, string]>) {
  return {
    prices: rows.map(([chainId, token, priceUSD]) => ({ chainId, token, priceUSD })),
  };
}

const mockFetch = vi.fn();
global.fetch = mockFetch;

describe("delora", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("EXTRA_TOKENS", () => {
    test("is defined and contains token entries", () => {
      expect(EXTRA_TOKENS).toBeDefined();
      expect(Array.isArray(EXTRA_TOKENS)).toBe(true);
      expect(EXTRA_TOKENS.length).toBeGreaterThan(0);
    });

    test("each token has chainId and address", () => {
      for (const token of EXTRA_TOKENS) {
        expect(token).toHaveProperty("chainId");
        expect(token).toHaveProperty("address");
        expect(typeof token.chainId).toBe("number");
        expect(typeof token.address).toBe("string");
      }
    });

    test("includes sUSDS token on Ethereum", () => {
      const susds = EXTRA_TOKENS.find(
        (t) => t.address.toLowerCase() === "0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD".toLowerCase(),
      );
      expect(susds).toBeDefined();
      expect(susds?.chainId).toBe(1);
    });
  });

  describe("fetchDeloraPrices", () => {
    const ADDR_1 = "0x1111111111111111111111111111111111111111" as Address;
    const ADDR_2 = "0x2222222222222222222222222222222222222222" as Address;

    test("returns empty map when no tokens are passed", async () => {
      const result = await fetchDeloraPrices([]);
      expect(result.size).toBe(0);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    test("batches tokens across chains into a single request", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve(
            pricesResponse([
              [1, ADDR_1, "2.5"],
              [10, ADDR_2, "7.0"],
            ]),
          ),
      });

      const result = await fetchDeloraPrices([
        { chainId: 1, token: ADDR_1 },
        { chainId: 10, token: ADDR_2 },
      ]);

      expect(result.get(deloraPriceKey(1, ADDR_1))).toBe(2.5);
      expect(result.get(deloraPriceKey(10, ADDR_2))).toBe(7.0);
      // ONE fetch for both chains
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const tokensParam = new URL(mockFetch.mock.calls[0][0] as string).searchParams.get("tokens");
      expect(tokensParam).toBe(`1:${ADDR_1},10:${ADDR_2}`);
    });

    test("dedupes (chainId, address) pairs in the request", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(pricesResponse([[1, ADDR_1, "1.23"]])),
      });

      await fetchDeloraPrices([
        { chainId: 1, token: ADDR_1 },
        { chainId: 1, token: ADDR_1 },
        { chainId: 1, token: ADDR_1 },
      ]);

      const tokensParam = new URL(mockFetch.mock.calls[0][0] as string).searchParams.get("tokens") ?? "";
      expect(tokensParam.split(",")).toHaveLength(1);
    });

    test("returns prices keyed by lowercase address", async () => {
      const UPPER = "0xAaaaAaaaAaAaAaaaAAAAAAaaAAaaaaAAaaAaAaAa" as Address;
      mockFetch.mockResolvedValueOnce({
        ok: true,
        // Delora echoes mixed case
        json: () => Promise.resolve(pricesResponse([[1, UPPER, "9.99"]])),
      });

      const result = await fetchDeloraPrices([{ chainId: 1, token: UPPER }]);

      expect(result.get(deloraPriceKey(1, UPPER))).toBe(9.99);
      // Key must always be lowercase
      expect([...result.keys()][0]).toBe(`1:${UPPER.toLowerCase()}`);
    });

    test("omits entries whose priceUSD is not a finite number", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve(
            pricesResponse([
              [1, ADDR_1, "not-a-number"],
              [1, ADDR_2, "4.2"],
            ]),
          ),
      });

      const result = await fetchDeloraPrices([
        { chainId: 1, token: ADDR_1 },
        { chainId: 1, token: ADDR_2 },
      ]);

      expect(result.has(deloraPriceKey(1, ADDR_1))).toBe(false);
      expect(result.get(deloraPriceKey(1, ADDR_2))).toBe(4.2);
    });

    test("returns empty map on non-2xx response", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

      const result = await fetchDeloraPrices([{ chainId: 1, token: ADDR_1 }]);

      expect(result.size).toBe(0);
    });

    test("swallows network errors and returns empty map", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Network error"));

      const result = await fetchDeloraPrices([{ chainId: 1, token: ADDR_1 }]);

      expect(result.size).toBe(0);
    });

    test("requests native tokens with zeroAddress directly (no substitution)", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(pricesResponse([[1, zeroAddress, "2286.97"]])),
      });

      const result = await fetchDeloraPrices([{ chainId: 1, token: zeroAddress }]);

      const tokensParam = new URL(mockFetch.mock.calls[0][0] as string).searchParams.get("tokens");
      expect(tokensParam).toBe(`1:${zeroAddress}`);
      expect(result.get(deloraPriceKey(1, zeroAddress))).toBe(2286.97);
    });

    test("never requests more than Delora's 50-pair limit per call", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(pricesResponse([])),
      });

      // 150 unique addresses -> 3 requests at the 50-pair API limit; a
      // larger chunk gets the whole request rejected with 400
      // VALIDATION_ERROR "Too many token price requests. Max is 50."
      const tokens = Array.from({ length: 150 }, (_, i) => ({
        chainId: 1,
        token: `0x${(i + 1).toString(16).padStart(40, "0")}` as Address,
      }));

      await fetchDeloraPrices(tokens);

      expect(mockFetch).toHaveBeenCalledTimes(3);
      for (const call of mockFetch.mock.calls) {
        const tokensParam = new URL(call[0] as string).searchParams.get("tokens") ?? "";
        expect(tokensParam.split(",").length).toBeLessThanOrEqual(50);
      }
    });

    test("forwards AbortSignal to fetch", async () => {
      mockFetch.mockImplementation((_url: string, init: RequestInit) => {
        if (init.signal?.aborted) {
          return Promise.reject(new DOMException("aborted", "AbortError"));
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(pricesResponse([[1, ADDR_1, "1.0"]])),
        });
      });

      const controller = new AbortController();
      controller.abort();

      const result = await fetchDeloraPrices([{ chainId: 1, token: ADDR_1 }], controller.signal);

      // Aborted before fetch resolved → no price recorded
      expect(result.has(deloraPriceKey(1, ADDR_1))).toBe(false);
    });
  });

  describe("fetchDeloraTokensForChain", () => {
    const LOWER_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const LOWER_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    test("returns a Map keyed by lowercased address on success", async () => {
      // Mix a checksum-cased address, an already-lowercase one, and native ETH
      // (which Delora returns as `0x00…00`) so we lock in both the lowercase
      // normalisation and the native-token handling the UI relies on.
      const CHECKSUM = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
      const LOWER = "0xdac17f958d2ee523a2206206994597c13d831ec7";
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            "1": [
              { address: CHECKSUM, chainId: 1, symbol: "USDC", name: "USD Coin", decimals: 6 },
              { address: LOWER, chainId: 1, symbol: "USDT", name: "Tether", decimals: 6 },
              { address: zeroAddress, chainId: 1, symbol: "ETH", name: "Ether", decimals: 18 },
            ],
          }),
      });

      const catalog = await fetchDeloraTokensForChain(1);

      expect(catalog).toBeInstanceOf(Map);
      expect(catalog.size).toBe(3);
      expect(catalog.has(CHECKSUM.toLowerCase())).toBe(true);
      expect(catalog.has(LOWER)).toBe(true);
      expect(catalog.has(zeroAddress)).toBe(true);
      // The checksum form must NOT remain — UI looks up by `.toLowerCase()`.
      expect(catalog.has(CHECKSUM)).toBe(false);
      // Values carry checksummed addresses and metadata for the balance scan.
      expect(catalog.get(LOWER)).toEqual({
        address: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
        symbol: "USDT",
        name: "Tether",
        decimals: 6,
      });
    });

    test("keeps positive catalog prices and drops null or zero ones", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            "1": [
              { address: zeroAddress, chainId: 1, symbol: "ETH", name: "Ether", decimals: 18, priceUSD: "2271.6" },
              { address: LOWER_A, chainId: 1, symbol: "A", name: "A", decimals: 18, priceUSD: null },
              { address: LOWER_B, chainId: 1, symbol: "B", name: "B", decimals: 18, priceUSD: "0" },
            ],
          }),
      });

      const catalog = await fetchDeloraTokensForChain(1);

      expect(catalog.get(zeroAddress)?.priceUSD).toBe(2271.6);
      expect(catalog.get(LOWER_A)).not.toHaveProperty("priceUSD");
      expect(catalog.get(LOWER_B)).not.toHaveProperty("priceUSD");
    });

    test("drops entries that are not EVM addresses", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            "1": [
              {
                address: "facet_0x26231ad975456d53682e1b6364e9e005886281e7",
                chainId: 1,
                symbol: "F",
                name: "F",
                decimals: 18,
              },
              { address: LOWER_A, chainId: 1, symbol: "A", name: "A", decimals: 18 },
            ],
          }),
      });

      const catalog = await fetchDeloraTokensForChain(1);

      expect([...catalog.keys()]).toEqual([LOWER_A]);
    });

    test("builds the documented URL: /v1/tokens?chains=N", async () => {
      let capturedUrl = "";
      mockFetch.mockImplementation((url: string) => {
        capturedUrl = url;
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      });

      await fetchDeloraTokensForChain(42161);

      const parsed = new URL(capturedUrl);
      expect(parsed.origin + parsed.pathname).toBe("https://api.delora.build/v1/tokens");
      expect(parsed.searchParams.get("chains")).toBe("42161");
    });

    test("returns an empty set when the chain key is missing from the response", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) });

      const catalog = await fetchDeloraTokensForChain(1);

      expect(catalog.size).toBe(0);
    });

    test("throws on non-2xx so callers can observe the failure", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 503, statusText: "Service Unavailable" });

      await expect(fetchDeloraTokensForChain(1)).rejects.toThrow(/Delora \/v1\/tokens failed for chain 1/);
    });

    test("forwards AbortSignal to fetch", async () => {
      mockFetch.mockImplementation((_url: string, init: RequestInit) => {
        if (init.signal?.aborted) {
          return Promise.reject(new DOMException("aborted", "AbortError"));
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      });

      const controller = new AbortController();
      controller.abort();

      await expect(fetchDeloraTokensForChain(1, controller.signal)).rejects.toThrow();
    });
  });

  describe("checkDeloraRoutableToUsdc", () => {
    // A random ERC20 on mainnet — not USDC, so the probe is meaningful.
    const HIDDEN_TOKEN = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Address;

    test("returns true when Delora returns a non-zero outputAmount", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ outputAmount: "1000000" }),
      });

      const result = await checkDeloraRoutableToUsdc({
        chainId: 1,
        token: HIDDEN_TOKEN,
        decimals: 18,
        unitaryPrice: 1,
      });

      expect(result).toBe(true);
      // Routes to /v1/quotes with the USDC mainnet address as the output and
      // the zero address as the sender (privacy: discovery-only call).
      const [url] = mockFetch.mock.calls[0];
      const parsed = new URL(url as string);
      expect(parsed.origin + parsed.pathname).toBe("https://api.delora.build/v1/quotes");
      expect(parsed.searchParams.get("senderAddress")).toBe(zeroAddress);
      expect(parsed.searchParams.get("originChainId")).toBe("1");
      expect(parsed.searchParams.get("destinationChainId")).toBe("1");
      expect(parsed.searchParams.get("originCurrency")).toBe(HIDDEN_TOKEN);
      expect(parsed.searchParams.get("destinationCurrency")?.toLowerCase()).toBe(USDC[1].toLowerCase());
      // Discovery probes are not monetized.
      expect(parsed.searchParams.get("integrator")).toBeNull();
      expect(parsed.searchParams.get("fee")).toBeNull();
    });

    test("returns false on non-2xx response (including the no-adapters 500)", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

      const result = await checkDeloraRoutableToUsdc({
        chainId: 1,
        token: HIDDEN_TOKEN,
        decimals: 18,
        unitaryPrice: 1,
      });

      expect(result).toBe(false);
    });

    test("returns false on thrown network error", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Network error"));

      const result = await checkDeloraRoutableToUsdc({
        chainId: 1,
        token: HIDDEN_TOKEN,
        decimals: 18,
        unitaryPrice: 1,
      });

      expect(result).toBe(false);
    });

    test("returns false when outputAmount is missing", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({}),
      });

      const result = await checkDeloraRoutableToUsdc({
        chainId: 1,
        token: HIDDEN_TOKEN,
        decimals: 18,
        unitaryPrice: 1,
      });

      expect(result).toBe(false);
    });

    test("returns false when outputAmount is zero", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ outputAmount: "0" }),
      });

      const result = await checkDeloraRoutableToUsdc({
        chainId: 1,
        token: HIDDEN_TOKEN,
        decimals: 18,
        unitaryPrice: 1,
      });

      expect(result).toBe(false);
    });

    test("returns false (and doesn't fetch) when token is already USDC on that chain", async () => {
      const result = await checkDeloraRoutableToUsdc({
        chainId: 1,
        token: USDC[1],
        decimals: 6,
        unitaryPrice: 1,
      });

      expect(result).toBe(false);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    test("returns false (and doesn't fetch) when chain has no USDC mapping", async () => {
      const result = await checkDeloraRoutableToUsdc({
        chainId: 999_999,
        token: HIDDEN_TOKEN,
        decimals: 18,
        unitaryPrice: 1,
      });

      expect(result).toBe(false);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    test("returns false (and doesn't fetch) when unitaryPrice is non-positive", async () => {
      const zeroPrice = await checkDeloraRoutableToUsdc({
        chainId: 1,
        token: HIDDEN_TOKEN,
        decimals: 18,
        unitaryPrice: 0,
      });
      const negativePrice = await checkDeloraRoutableToUsdc({
        chainId: 1,
        token: HIDDEN_TOKEN,
        decimals: 18,
        unitaryPrice: -1,
      });

      expect(zeroPrice).toBe(false);
      expect(negativePrice).toBe(false);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    test("normalises input to a ~$1-equivalent amount derived from unitaryPrice", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ outputAmount: "1" }),
      });

      await checkDeloraRoutableToUsdc({
        chainId: 1,
        token: HIDDEN_TOKEN,
        decimals: 18,
        unitaryPrice: 2,
      });

      const parsed = new URL(mockFetch.mock.calls[0][0] as string);
      // $1 of a $2 token → 0.5 tokens with 18 decimals.
      expect(parsed.searchParams.get("amount")).toBe(parseUnits("0.5", 18).toString());
    });

    test("clamps the amount to 1n when the $1-equivalent rounds to zero", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ outputAmount: "1" }),
      });

      // A 0-decimal token priced at $1,000,000 truncates to 0 — that's the
      // clamp case we want to verify.
      await checkDeloraRoutableToUsdc({
        chainId: 1,
        token: HIDDEN_TOKEN,
        decimals: 0,
        unitaryPrice: 1_000_000,
      });

      const parsed = new URL(mockFetch.mock.calls[0][0] as string);
      expect(parsed.searchParams.get("amount")).toBe("1");
    });

    test("forwards AbortSignal to fetch and returns false when aborted", async () => {
      mockFetch.mockImplementation((_url: string, init: RequestInit) => {
        if (init.signal?.aborted) {
          return Promise.reject(new DOMException("aborted", "AbortError"));
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ outputAmount: "1" }),
        });
      });

      const controller = new AbortController();
      controller.abort();

      const result = await checkDeloraRoutableToUsdc(
        {
          chainId: 1,
          token: HIDDEN_TOKEN,
          decimals: 18,
          unitaryPrice: 1,
        },
        controller.signal,
      );

      expect(result).toBe(false);
    });
  });
});
