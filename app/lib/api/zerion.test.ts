import { type Address, zeroAddress } from "viem";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { USDC_ETHEREUM, USDC_OPTIMISM, WALLET } from "../../../test/test-helpers";
import { DISCOVERY_TTL_MS, discoverZerionTokens, resetZerionRateLimiter, ZERION_TIMEOUT_MS } from "./zerion";

const mockApiKey = "test-api-key";
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Helper to create Zerion position
function pos({
  chainId = "ethereum",
  symbol = "USDC",
  name = "USD Coin",
  address = USDC_ETHEREUM as string | null,
  decimals = 6,
  quantity = "100.0",
  price = 1.0,
  displayable = true,
  iconUrl = "https://example.com/icon.png" as string | null,
} = {}) {
  return {
    type: "positions" as const,
    id: `${chainId}-${symbol.toLowerCase()}-${Math.random().toString(36).slice(2, 7)}`,
    attributes: {
      parent: null,
      protocol: null,
      name: `${symbol} on ${chainId}`,
      position_type: "wallet" as const,
      quantity: { decimals, numeric: quantity },
      value: Number(quantity) * price,
      price,
      fungible_info: {
        name,
        symbol,
        icon: iconUrl ? { url: iconUrl } : null,
        implementations: [{ chain_id: chainId, address, decimals }],
      },
      flags: { displayable },
      chain: undefined as string | undefined,
    },
    relationships: { chain: { data: { id: chainId, type: "chains" as const } } } as
      | { chain: { data: { id: string; type: "chains" } } }
      | undefined,
  };
}

// Helper to create Zerion API response
const res = (positions: ReturnType<typeof pos>[]) => ({ data: positions, links: {} });

// Helper to mock successful fetch
const mockOk = (positions: ReturnType<typeof pos>[]) =>
  mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(res(positions)) });

// Helper to mock failed fetch
const mockFail = (status: number, statusText: string) =>
  mockFetch.mockResolvedValueOnce({ ok: false, status, statusText });

describe("zerion discovery", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    resetZerionRateLimiter();
    localStorage.clear();
    vi.stubEnv("VITE_ZERION_API_KEY", mockApiKey);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  describe("discoverZerionTokens", () => {
    test("returns held tokens with metadata and no amounts", async () => {
      mockOk([pos(), pos({ chainId: "optimism", address: USDC_OPTIMISM })]);

      const result = await discoverZerionTokens(WALLET);

      expect(result).toEqual([
        { chainId: 1, token: USDC_ETHEREUM, symbol: "USDC", name: "USD Coin", decimals: 6 },
        { chainId: 10, token: USDC_OPTIMISM, symbol: "USDC", name: "USD Coin", decimals: 6 },
      ]);
    });

    test("queries one wallet, all supported chains, simple positions only", async () => {
      mockOk([]);

      await discoverZerionTokens(WALLET);

      const url = new URL(mockFetch.mock.calls[0][0]);
      expect(url.pathname).toContain(`/v1/wallets/${WALLET}/positions/`);
      expect(url.searchParams.get("filter[chain_ids]")?.split(",")).toEqual(
        expect.arrayContaining(["ethereum", "optimism", "arbitrum", "base", "polygon", "unichain", "linea", "xdai"]),
      );
      expect(url.searchParams.get("filter[positions]")).toBe("only_simple");
      expect(mockFetch.mock.calls[0][1].headers.Authorization).toBe(`Basic ${btoa(`${mockApiKey}:`)}`);
    });

    test("maps native coins to zeroAddress, including Polygon's 0x…1010", async () => {
      mockOk([
        pos({ symbol: "ETH", address: null, decimals: 18, quantity: "1", price: 2000 }),
        pos({
          chainId: "polygon",
          symbol: "POL",
          address: "0x0000000000000000000000000000000000001010",
          decimals: 18,
          quantity: "10",
          price: 0.5,
        }),
      ]);

      const result = await discoverZerionTokens(WALLET);

      expect(result.map((t) => [t.chainId, t.token])).toEqual([
        [1, zeroAddress],
        [137, zeroAddress],
      ]);
    });

    test("skips dust, non-displayable and unsupported-chain positions", async () => {
      mockOk([
        pos({ quantity: "0.001", price: 1 }),
        pos({ displayable: false }),
        pos({ chainId: "solana" }),
        pos({ chainId: "optimism", address: USDC_OPTIMISM }),
      ]);

      const result = await discoverZerionTokens(WALLET);

      expect(result.map((t) => t.chainId)).toEqual([10]);
    });

    test("dedupes the same token reported twice", async () => {
      mockOk([pos(), pos()]);
      expect(await discoverZerionTokens(WALLET)).toHaveLength(1);
    });

    test("returns [] without a request when no API key is set", async () => {
      vi.stubEnv("VITE_ZERION_API_KEY", "");
      expect(await discoverZerionTokens(WALLET)).toEqual([]);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    test("throws on HTTP errors so the caller can retry", async () => {
      mockFail(500, "Internal Server Error");
      await expect(discoverZerionTokens(WALLET)).rejects.toThrow(/Zerion API error: 500/);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("unresponsive Zerion", () => {
    /** A fetch that never answers, but honours its abort signal like the real one. */
    const hang = (_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });

    test("a hung request fails after the timeout instead of pending forever", async () => {
      vi.useFakeTimers();
      mockFetch.mockImplementation(hang);

      const promise = discoverZerionTokens(WALLET);
      const assertion = expect(promise).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(ZERION_TIMEOUT_MS);
      await assertion;
    });

    test("a timed-out attempt isn't cached, so the next one asks again", async () => {
      vi.useFakeTimers();
      mockFetch.mockImplementationOnce(hang);
      const first = discoverZerionTokens(WALLET);
      const assertion = expect(first).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(ZERION_TIMEOUT_MS);
      await assertion;

      mockOk([pos()]);
      const second = discoverZerionTokens(WALLET);
      await vi.runAllTimersAsync();
      expect(await second).toHaveLength(1);
    });

    test("time spent waiting for a rate-limit slot doesn't count against the timeout", async () => {
      vi.useFakeTimers();
      // Two fast wallets take this second's slots; the third waits ~1s for its slot.
      mockOk([]);
      mockOk([]);
      let sentAt = 0;
      mockFetch.mockImplementationOnce((_url: string, init: RequestInit) => {
        sentAt = Date.now();
        return new Promise((resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
          // Answers 9.5s after being sent: within the budget only if the wait isn't counted.
          setTimeout(() => resolve({ ok: true, json: () => Promise.resolve(res([pos()])) }), ZERION_TIMEOUT_MS - 500);
        });
      });

      const start = Date.now();
      const done = Promise.all(
        ["0x1111111111111111111111111111111111111111", "0x2222222222222222222222222222222222222222", WALLET].map((a) =>
          discoverZerionTokens(a),
        ),
      );
      await vi.runAllTimersAsync();

      expect((await done)[2]).toHaveLength(1);
      expect(sentAt - start).toBeGreaterThanOrEqual(1_000);
    });
  });

  describe("cache", () => {
    test("asks Zerion once per wallet, then serves from storage", async () => {
      mockOk([pos()]);

      const first = await discoverZerionTokens(WALLET);
      const second = await discoverZerionTokens(WALLET);

      expect(second).toEqual(first);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    test("cache is per address, case-insensitive", async () => {
      mockOk([pos()]);
      await discoverZerionTokens(WALLET);
      await discoverZerionTokens(WALLET.toLowerCase());
      expect(mockFetch).toHaveBeenCalledTimes(1);

      mockOk([]);
      await discoverZerionTokens("0x1111111111111111111111111111111111111111");
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    test("refetches once the entry is older than the TTL", async () => {
      vi.useFakeTimers();
      mockOk([pos()]);
      await discoverZerionTokens(WALLET);

      vi.setSystemTime(Date.now() + DISCOVERY_TTL_MS + 1);
      mockOk([]);
      expect(await discoverZerionTokens(WALLET)).toEqual([]);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    test("does not cache failures", async () => {
      mockFail(503, "Service Unavailable");
      await expect(discoverZerionTokens(WALLET)).rejects.toThrow();

      mockOk([pos()]);
      expect(await discoverZerionTokens(WALLET)).toHaveLength(1);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    test("ignores a corrupt cache entry", async () => {
      localStorage.setItem(`octocash:zerion-discovery:v1:${WALLET.toLowerCase()}`, "{not json");
      mockOk([pos()]);
      expect(await discoverZerionTokens(WALLET)).toHaveLength(1);
    });
  });

  describe("rate limiting", () => {
    const addresses = [
      "0x1111111111111111111111111111111111111111" as Address,
      "0x2222222222222222222222222222222222222222" as Address,
      "0x3333333333333333333333333333333333333333" as Address,
      "0x4444444444444444444444444444444444444444" as Address,
      "0x5555555555555555555555555555555555555555" as Address,
    ];

    test("never sends more than 2 requests in any rolling second", async () => {
      vi.useFakeTimers();
      const callTimes: number[] = [];
      mockFetch.mockImplementation(() => {
        callTimes.push(Date.now());
        return Promise.resolve({ ok: true, json: () => Promise.resolve(res([pos()])) });
      });

      const promise = Promise.all(addresses.map((a) => discoverZerionTokens(a)));
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.flat()).toHaveLength(5);
      expect(callTimes).toHaveLength(5);
      // First two go out immediately, then pairs once per second.
      expect(callTimes[1] - callTimes[0]).toBe(0);
      for (let i = 2; i < callTimes.length; i++) {
        expect(callTimes[i] - callTimes[i - 2]).toBeGreaterThanOrEqual(1_000);
      }
    });

    test("retries on 429 honoring Retry-After", async () => {
      vi.useFakeTimers();
      const callTimes: number[] = [];
      mockFetch.mockImplementationOnce(() => {
        callTimes.push(Date.now());
        return Promise.resolve({
          ok: false,
          status: 429,
          statusText: "Too Many Requests",
          headers: new Headers({ "Retry-After": "3" }),
        });
      });
      mockFetch.mockImplementationOnce(() => {
        callTimes.push(Date.now());
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(res([pos()])) });
      });

      const promise = discoverZerionTokens(WALLET);
      await vi.runAllTimersAsync();

      expect(await promise).toHaveLength(1);
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(callTimes[1] - callTimes[0]).toBeGreaterThanOrEqual(3_000);
    });

    test("retries on 429 with exponential backoff when Retry-After is absent", async () => {
      vi.useFakeTimers();
      const callTimes: number[] = [];
      const tooMany = () => {
        callTimes.push(Date.now());
        return Promise.resolve({ ok: false, status: 429, statusText: "Too Many Requests", headers: new Headers() });
      };
      mockFetch.mockImplementationOnce(tooMany).mockImplementationOnce(tooMany);
      mockFetch.mockImplementationOnce(() => {
        callTimes.push(Date.now());
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(res([pos()])) });
      });

      const promise = discoverZerionTokens(WALLET);
      await vi.runAllTimersAsync();

      expect(await promise).toHaveLength(1);
      expect(callTimes[1] - callTimes[0]).toBeGreaterThanOrEqual(1_000);
      expect(callTimes[2] - callTimes[1]).toBeGreaterThanOrEqual(2_000);
    });

    test("gives up after max retries", async () => {
      vi.useFakeTimers();
      mockFetch.mockResolvedValue({ ok: false, status: 429, statusText: "Too Many Requests", headers: new Headers() });

      const promise = discoverZerionTokens(WALLET);
      const assertion = expect(promise).rejects.toThrow(/429/);
      await vi.runAllTimersAsync();
      await assertion;
      expect(mockFetch).toHaveBeenCalledTimes(5); // 1 attempt + 4 retries
    });
  });
});
