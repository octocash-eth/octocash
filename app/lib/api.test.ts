import type { Address } from "viem";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ETH_ADDRESS, USDC_ETHEREUM, USDC_OPTIMISM, WALLET } from "../../test/helpers";
import { EXTRA_TOKENS, fetchTokenBalances } from "./api";

// Mock getPublicClient for extra tokens RPC calls (using multicall)
// Each token now requires 4 calls: balanceOf, name, symbol, decimals
vi.mock("./public-client", () => ({
  getPublicClient: vi.fn((_chainId: number) => ({
    multicall: vi.fn().mockImplementation(async ({ contracts }: { contracts: any[] }) => {
      // Generate results for all tokens (all with zero balance by default)
      const results = [];
      for (let i = 0; i < contracts.length; i += 4) {
        results.push(
          { status: "success", result: 0n }, // balanceOf
          { status: "success", result: "Mock Token" }, // name
          { status: "success", result: "MOCK" }, // symbol
          { status: "success", result: 18 }, // decimals
        );
      }
      return results;
    }),
  })),
}));

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
    type: "positions",
    id: `${chainId}-${symbol.toLowerCase()}-${Math.random().toString(36).slice(2, 7)}`,
    attributes: {
      parent: null,
      protocol: null,
      name: `${symbol} on ${chainId}`,
      position_type: "wallet",
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
    },
    relationships: { chain: { data: { id: chainId, type: "chains" } } },
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

describe("api", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("VITE_ZERION_API_KEY", mockApiKey);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("fetchTokenBalances", () => {
    test("returns empty array when no addresses provided", async () => {
      expect(await fetchTokenBalances([])).toEqual([]);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    test("fetches token balances for single address", async () => {
      mockOk([pos()]);

      const result = await fetchTokenBalances([WALLET]);

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        symbol: "USDC",
        chainId: 1,
        walletAddress: WALLET,
        decimals: 6,
        unitaryPrice: 1.0,
      });
    });

    test("fetches token balances for multiple addresses", async () => {
      const wallet2 = "0x2222222222222222222222222222222222222222" as Address;
      mockOk([pos()]);
      mockOk([pos({ chainId: "base", symbol: "WETH", decimals: 18, price: 2000 })]);

      const result = await fetchTokenBalances([WALLET, wallet2]);

      expect(result).toHaveLength(2);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    test("filters out tokens with USD value less than $0.01", async () => {
      mockOk([pos({ quantity: "100.0" }), pos({ symbol: "DUST", quantity: "0.000001", price: 0.001 })]);

      const result = await fetchTokenBalances([WALLET]);

      expect(result).toHaveLength(1);
      expect(result[0].symbol).toBe("USDC");
    });

    test("filters out non-displayable positions", async () => {
      mockOk([pos({ displayable: true }), pos({ symbol: "HIDDEN", quantity: "1000.0", displayable: false })]);

      const result = await fetchTokenBalances([WALLET]);

      expect(result).toHaveLength(1);
      expect(result[0].symbol).toBe("USDC");
    });

    test("handles positions from multiple chains", async () => {
      mockOk([
        pos({ chainId: "ethereum" }),
        pos({ chainId: "optimism", address: USDC_OPTIMISM, quantity: "50.0" }),
        pos({ chainId: "arbitrum", symbol: "ARB", quantity: "500.0", price: 0.5 }),
      ]);

      const result = await fetchTokenBalances([WALLET]);

      expect(result).toHaveLength(3);
      expect(result.find((t) => t.chainId === 1)).toBeDefined();
      expect(result.find((t) => t.chainId === 10)).toBeDefined();
      expect(result.find((t) => t.chainId === 42161)).toBeDefined();
    });

    test("sorts tokens by USD value in descending order", async () => {
      mockOk([
        pos({ symbol: "SMALL", quantity: "10.0" }),
        pos({ symbol: "LARGE", quantity: "1000.0" }),
        pos({ symbol: "MEDIUM", quantity: "100.0" }),
      ]);

      const result = await fetchTokenBalances([WALLET]);

      expect(result.map((t) => t.symbol)).toEqual(["LARGE", "MEDIUM", "SMALL"]);
    });

    test("normalizes Polygon native token address to zeroAddress", async () => {
      mockOk([
        pos({
          chainId: "polygon",
          symbol: "POL",
          name: "POL",
          address: "0x0000000000000000000000000000000000001010",
          decimals: 18,
          price: 0.5,
        }),
      ]);

      const result = await fetchTokenBalances([WALLET]);

      expect(result[0].token).toBe(ETH_ADDRESS);
      expect(result[0].chainId).toBe(137);
    });

    test("handles native tokens with null address", async () => {
      mockOk([pos({ symbol: "ETH", name: "Ethereum", address: null, decimals: 18, price: 2000 })]);

      const result = await fetchTokenBalances([WALLET]);

      expect(result[0].token).toBe(ETH_ADDRESS);
      expect(result[0].symbol).toBe("ETH");
    });

    test("skips positions from unsupported chains", async () => {
      mockOk([pos(), pos({ chainId: "solana", symbol: "SOL", price: 100 })]);

      const result = await fetchTokenBalances([WALLET]);

      expect(result).toHaveLength(1);
      expect(result[0].symbol).toBe("USDC");
    });

    test("handles API errors gracefully and returns empty array", async () => {
      mockFail(500, "Internal Server Error");
      expect(await fetchTokenBalances([WALLET])).toEqual([]);
    });

    test("handles network errors gracefully", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Network error"));
      expect(await fetchTokenBalances([WALLET])).toEqual([]);
    });

    test("handles partial failures across multiple addresses", async () => {
      const wallet2 = "0x2222222222222222222222222222222222222222" as Address;
      mockOk([pos()]);
      mockFail(429, "Too Many Requests");

      const result = await fetchTokenBalances([WALLET, wallet2]);

      expect(result).toHaveLength(1);
      expect(result[0].walletAddress).toBe(WALLET);
    });

    test("converts token amounts correctly using decimals", async () => {
      mockOk([pos({ quantity: "1234.567890" })]);

      const result = await fetchTokenBalances([WALLET]);

      expect(result[0].amount).toBe(1234567890n);
      expect(result[0].decimals).toBe(6);
    });

    test("handles tokens with 18 decimals", async () => {
      mockOk([pos({ symbol: "WETH", quantity: "1.5", decimals: 18, price: 2000 })]);

      const result = await fetchTokenBalances([WALLET]);

      expect(result[0].amount).toBe(1500000000000000000n);
    });

    test("handles empty response from Zerion", async () => {
      mockOk([]);
      expect(await fetchTokenBalances([WALLET])).toEqual([]);
    });

    test("sends correct authorization header", async () => {
      mockOk([]);

      await fetchTokenBalances([WALLET]);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: { Authorization: `Basic ${btoa(`${mockApiKey}:`)}`, accept: "application/json" },
        }),
      );
    });

    test("includes correct query parameters in API call", async () => {
      mockOk([]);

      await fetchTokenBalances([WALLET]);

      const [url] = mockFetch.mock.calls[0] as [string, unknown];
      expect(url).toContain("currency=usd");
      expect(url).toContain("filter%5Bchain_ids%5D=");
    });

    test("handles icon URL and missing icon gracefully", async () => {
      mockOk([pos({ iconUrl: "https://example.com/icon.png" }), pos({ symbol: "NO_ICON", iconUrl: null })]);

      const result = await fetchTokenBalances([WALLET]);
      expect(result).toHaveLength(2);
    });

    test("handles position with zero price", async () => {
      mockOk([pos({ symbol: "UNKNOWN", quantity: "1000.0", price: 0 })]);
      expect(await fetchTokenBalances([WALLET])).toHaveLength(0);
    });

    test("handles all supported chains", async () => {
      mockOk([
        pos({ chainId: "ethereum", symbol: "ETH", price: 2000 }),
        pos({ chainId: "optimism", symbol: "OP" }),
        pos({ chainId: "arbitrum", symbol: "ARB", price: 0.5 }),
        pos({ chainId: "base", symbol: "BASE" }),
        pos({ chainId: "polygon", symbol: "POL", price: 0.3 }),
        pos({ chainId: "linea", symbol: "LNX", price: 5 }),
      ]);

      const result = await fetchTokenBalances([WALLET]);

      expect(result).toHaveLength(6);
      expect(result.map((t) => t.chainId).sort()).toEqual([1, 10, 137, 42161, 59144, 8453].sort());
    });

    test("correctly checksums token addresses", async () => {
      mockOk([pos({ address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" })]);

      const result = await fetchTokenBalances([WALLET]);

      expect(result[0].token).toBe(USDC_ETHEREUM);
    });

    test("uses chain from relationships when available", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [
              {
                type: "positions",
                id: "test",
                attributes: {
                  parent: null,
                  protocol: null,
                  name: "USDC",
                  position_type: "wallet",
                  quantity: { decimals: 6, numeric: "100.0" },
                  value: 100,
                  price: 1.0,
                  fungible_info: {
                    name: "USD Coin",
                    symbol: "USDC",
                    icon: null,
                    implementations: [{ chain_id: "ethereum", address: USDC_ETHEREUM, decimals: 6 }],
                  },
                  flags: { displayable: true },
                  chain: "different-chain",
                },
                relationships: { chain: { data: { id: "ethereum", type: "chains" } } },
              },
            ],
            links: {},
          }),
      });

      const result = await fetchTokenBalances([WALLET]);
      expect(result[0].chainId).toBe(1);
    });

    test("falls back to attributes.chain when relationships missing", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [
              {
                type: "positions",
                id: "test",
                attributes: {
                  parent: null,
                  protocol: null,
                  name: "USDC",
                  position_type: "wallet",
                  quantity: { decimals: 6, numeric: "100.0" },
                  value: 100,
                  price: 1.0,
                  fungible_info: {
                    name: "USD Coin",
                    symbol: "USDC",
                    icon: null,
                    implementations: [{ chain_id: "optimism", address: USDC_OPTIMISM, decimals: 6 }],
                  },
                  flags: { displayable: true },
                  chain: "optimism",
                },
              },
            ],
            links: {},
          }),
      });

      const result = await fetchTokenBalances([WALLET]);
      expect(result[0].chainId).toBe(10);
    });

    test("skips positions missing chain identifier or implementation", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [
              {
                type: "positions",
                id: "valid",
                attributes: {
                  parent: null,
                  protocol: null,
                  name: "USDC",
                  position_type: "wallet",
                  quantity: { decimals: 6, numeric: "100.0" },
                  value: 100,
                  price: 1.0,
                  fungible_info: {
                    name: "USD Coin",
                    symbol: "USDC",
                    icon: null,
                    implementations: [{ chain_id: "ethereum", address: USDC_ETHEREUM, decimals: 6 }],
                  },
                  flags: { displayable: true },
                  chain: "ethereum",
                },
              },
              {
                type: "positions",
                id: "no-chain",
                attributes: {
                  parent: null,
                  protocol: null,
                  name: "Unknown",
                  position_type: "wallet",
                  quantity: { decimals: 18, numeric: "1000.0" },
                  value: 1000,
                  price: 1.0,
                  fungible_info: { name: "Unknown", symbol: "UNK", icon: null, implementations: [] },
                  flags: { displayable: true },
                },
              },
              {
                type: "positions",
                id: "wrong-impl",
                attributes: {
                  parent: null,
                  protocol: null,
                  name: "Weird",
                  position_type: "wallet",
                  quantity: { decimals: 18, numeric: "1000.0" },
                  value: 1000,
                  price: 1.0,
                  fungible_info: {
                    name: "Weird",
                    symbol: "WEIRD",
                    icon: null,
                    implementations: [{ chain_id: "other", address: WALLET, decimals: 18 }],
                  },
                  flags: { displayable: true },
                  chain: "ethereum",
                },
              },
            ],
            links: {},
          }),
      });

      const result = await fetchTokenBalances([WALLET]);

      expect(result).toHaveLength(1);
      expect(result[0].symbol).toBe("USDC");
    });

    test("preserves token name in result", async () => {
      mockOk([pos({ name: "USD Coin" })]);

      const result = await fetchTokenBalances([WALLET]);
      expect(result[0].name).toBe("USD Coin");
    });

    test("handles very large and very small token amounts", async () => {
      mockOk([
        pos({ symbol: "SHIB", quantity: "999999999999999.123456789", decimals: 18, price: 0.00001 }),
        pos({ symbol: "BTC", quantity: "0.000001", decimals: 18, price: 50000 }),
      ]);

      const result = await fetchTokenBalances([WALLET]);

      expect(result).toHaveLength(2);
      expect(result.find((t) => t.symbol === "SHIB")?.amount).toBeGreaterThan(0n);
    });
  });

  describe("error handling", () => {
    test("handles missing API key", async () => {
      vi.stubEnv("VITE_ZERION_API_KEY", "");
      expect(await fetchTokenBalances([WALLET])).toEqual([]);
    });

    test("handles malformed JSON response", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.reject(new Error("Invalid JSON")) });
      expect(await fetchTokenBalances([WALLET])).toEqual([]);
    });

    test("handles timeout errors", async () => {
      mockFetch.mockRejectedValueOnce(new Error("ETIMEDOUT"));
      expect(await fetchTokenBalances([WALLET])).toEqual([]);
    });

    test("handles invalid token quantity gracefully (buildTokenAmountsFromBalances error)", async () => {
      // This tests the catch block in buildTokenAmountsFromBalances - invalid quantity triggers parseUnits error
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [
              {
                type: "positions",
                id: "valid-token",
                attributes: {
                  parent: null,
                  protocol: null,
                  name: "Valid",
                  position_type: "wallet",
                  quantity: { decimals: 6, numeric: "100.0" },
                  value: 100,
                  price: 1.0,
                  fungible_info: {
                    name: "Valid Token",
                    symbol: "VALID",
                    icon: null,
                    implementations: [{ chain_id: "ethereum", address: USDC_ETHEREUM, decimals: 6 }],
                  },
                  flags: { displayable: true },
                  chain: "ethereum",
                },
              },
              {
                type: "positions",
                id: "invalid-token",
                attributes: {
                  parent: null,
                  protocol: null,
                  name: "Invalid",
                  position_type: "wallet",
                  // Invalid quantity - too many decimals for the token's decimal places
                  quantity: { decimals: 6, numeric: "not_a_number" },
                  value: 100,
                  price: 1.0,
                  fungible_info: {
                    name: "Invalid Token",
                    symbol: "INVALID",
                    icon: null,
                    implementations: [{ chain_id: "ethereum", address: WALLET, decimals: 6 }],
                  },
                  flags: { displayable: true },
                  chain: "ethereum",
                },
              },
            ],
            links: {},
          }),
      });

      const result = await fetchTokenBalances([WALLET]);

      // Should only return the valid token, skipping the invalid one
      expect(result).toHaveLength(1);
      expect(result[0].symbol).toBe("VALID");
    });

    test("handles rejection without address property (fallback error logging)", async () => {
      // Test the else branch when result.reason doesn't have an address property
      // This can happen if the promise rejection is structured differently

      // Provide a default mock to handle any background fetch calls
      mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve(res([])) });

      // Mock Promise.allSettled to return a rejection without the address property
      const allSettledSpy = vi.spyOn(Promise, "allSettled").mockResolvedValueOnce([
        {
          status: "rejected",
          reason: new Error("Unexpected error without address context"),
        },
      ]);

      const result = await fetchTokenBalances([WALLET]);

      expect(result).toEqual([]);

      // Restore original
      allSettledSpy.mockRestore();
    });

    test("handles error in outer try-catch (addresses being null)", async () => {
      // This tests the outer catch block in fetchTokenBalances
      // by passing invalid input that causes an error before Promise.allSettled
      // @ts-expect-error - intentionally passing null to test error handling
      const result = await fetchTokenBalances(null);

      expect(result).toEqual([]);
    });
  });

  describe("concurrent fetching", () => {
    test("fetches all addresses concurrently", async () => {
      const addresses = [
        "0x1111111111111111111111111111111111111111" as Address,
        "0x2222222222222222222222222222222222222222" as Address,
        "0x3333333333333333333333333333333333333333" as Address,
      ];

      const callTimes: number[] = [];
      mockFetch.mockImplementation(() => {
        callTimes.push(Date.now());
        return Promise.resolve({ ok: true, json: () => Promise.resolve(res([pos()])) });
      });

      await fetchTokenBalances(addresses);

      // Each address triggers 1 Zerion positions call + potential extra token calls
      expect(mockFetch).toHaveBeenCalled();
      if (callTimes.length >= 3) {
        expect(callTimes[2] - callTimes[0]).toBeLessThan(50);
      }
    });
  });

  describe("extra tokens", () => {
    test("EXTRA_TOKENS list is defined and contains sUSDS", () => {
      expect(EXTRA_TOKENS).toBeDefined();
      expect(EXTRA_TOKENS.length).toBeGreaterThan(0);

      const susds = EXTRA_TOKENS.find(
        (t) => t.address.toLowerCase() === "0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD".toLowerCase(),
      );
      expect(susds).toBeDefined();
      expect(susds?.chainId).toBe(1);
    });

    test("fetches extra token balance via multicall and price from Odos", async () => {
      const { getPublicClient } = await import("./public-client");
      const sUSDS_ADDRESS = "0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD";

      const mockMulticall = vi.fn().mockImplementation(async ({ contracts }: { contracts: any[] }) => {
        // Generate results based on the contracts array
        const results = [];
        for (let i = 0; i < contracts.length; i += 4) {
          const tokenAddress = contracts[i]?.address;
          const isSUSDS = tokenAddress?.toLowerCase() === sUSDS_ADDRESS.toLowerCase();

          // balanceOf
          results.push({
            status: "success",
            result: isSUSDS ? 1000000000000000000n : 0n,
          });
          // name
          results.push({
            status: "success",
            result: isSUSDS ? "Sky Savings USDS" : "Mock Token",
          });
          // symbol
          results.push({
            status: "success",
            result: isSUSDS ? "sUSDS" : "MOCK",
          });
          // decimals
          results.push({
            status: "success",
            result: 18,
          });
        }
        return results;
      });

      vi.mocked(getPublicClient).mockImplementation((chainId: number) => {
        if (chainId === 1) {
          return { multicall: mockMulticall } as never;
        }
        // Other chains - return zero balances for all tokens
        return {
          multicall: vi.fn().mockImplementation(async ({ contracts }: { contracts: any[] }) => {
            const results = [];
            for (let i = 0; i < contracts.length; i += 4) {
              results.push(
                { status: "success", result: 0n },
                { status: "success", result: "Mock Token" },
                { status: "success", result: "MOCK" },
                { status: "success", result: 6 },
              );
            }
            return results;
          }),
        } as never;
      });

      // Mock Zerion positions response (empty)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: [], links: {} }),
      });

      // Mock Odos pricing API response for sUSDS
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            currencyId: "USD",
            tokenPrices: {
              "0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD": 1.05,
            },
          }),
      });

      const result = await fetchTokenBalances([WALLET]);

      // Verify multicall was called for Ethereum chain with balanceOf, name, symbol, decimals
      expect(mockMulticall).toHaveBeenCalledWith({
        contracts: expect.arrayContaining([
          expect.objectContaining({
            address: "0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD",
            functionName: "balanceOf",
          }),
          expect.objectContaining({
            address: "0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD",
            functionName: "name",
          }),
          expect.objectContaining({
            address: "0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD",
            functionName: "symbol",
          }),
          expect.objectContaining({
            address: "0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD",
            functionName: "decimals",
          }),
        ]),
        allowFailure: true,
      });

      expect(result).toHaveLength(1);
      expect(result[0].symbol).toBe("sUSDS");
      expect(result[0].unitaryPrice).toBe(1.05);
      expect(result[0].chainId).toBe(1);
    });

    test("skips extra token when balance is zero", async () => {
      const { getPublicClient } = await import("./public-client");
      vi.mocked(getPublicClient).mockImplementation(
        (chainId: number) =>
          ({
            multicall: vi.fn().mockResolvedValue(
              chainId === 1
                ? [
                    // Token 1: balanceOf=0, name, symbol, decimals
                    { status: "success", result: 0n },
                    { status: "success", result: "Token 1" },
                    { status: "success", result: "TK1" },
                    { status: "success", result: 18 },
                    // Token 2: balanceOf=0, name, symbol, decimals
                    { status: "success", result: 0n },
                    { status: "success", result: "Token 2" },
                    { status: "success", result: "TK2" },
                    { status: "success", result: 18 },
                  ]
                : [
                    // Token 3: balanceOf=0, name, symbol, decimals
                    { status: "success", result: 0n },
                    { status: "success", result: "Token 3" },
                    { status: "success", result: "TK3" },
                    { status: "success", result: 6 },
                  ],
            ),
          }) as never,
      );

      mockOk([pos()]);

      const result = await fetchTokenBalances([WALLET]);

      // Should only have the regular token, not the extra token with zero balance
      expect(result).toHaveLength(1);
      expect(result[0].symbol).toBe("USDC");
    });

    test("deduplicates tokens if Zerion returns same token as extra tokens", async () => {
      const { getPublicClient } = await import("./public-client");
      vi.mocked(getPublicClient).mockImplementation((chainId: number) => {
        if (chainId === 1) {
          return {
            multicall: vi.fn().mockResolvedValue([
              // sUSDS: balanceOf, name, symbol, decimals
              { status: "success", result: 1000000000000000000n },
              { status: "success", result: "Sky Savings USDS" },
              { status: "success", result: "sUSDS" },
              { status: "success", result: 18 },
              // sUSDC: balanceOf=0, name, symbol, decimals
              { status: "success", result: 0n },
              { status: "success", result: "Spark USDC Vault" },
              { status: "success", result: "sUSDC" },
              { status: "success", result: 6 },
            ]),
          } as never;
        }
        return {
          multicall: vi.fn().mockResolvedValue([
            // aOptUSDCn: balanceOf=0, name, symbol, decimals
            { status: "success", result: 0n },
            { status: "success", result: "Aave Optimism USDC" },
            { status: "success", result: "aOptUSDCn" },
            { status: "success", result: 6 },
          ]),
        } as never;
      });

      // Mock Zerion positions returning sUSDS
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [
              {
                type: "positions",
                id: "susds-position",
                attributes: {
                  parent: null,
                  protocol: null,
                  name: "sUSDS",
                  position_type: "wallet",
                  quantity: { decimals: 18, numeric: "2.0" },
                  value: 2.1,
                  price: 1.05,
                  fungible_info: {
                    name: "Sky Savings USDS",
                    symbol: "sUSDS",
                    icon: { url: "https://cdn.zerion.io/susds.png" },
                    implementations: [
                      { chain_id: "ethereum", address: "0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD", decimals: 18 },
                    ],
                  },
                  flags: { displayable: true },
                },
                relationships: { chain: { data: { id: "ethereum", type: "chains" } } },
              },
            ],
            links: {},
          }),
      });

      // Mock Odos pricing response for extra token
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            currencyId: "USD",
            tokenPrices: {
              "0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD": 1.05,
            },
          }),
      });

      const result = await fetchTokenBalances([WALLET]);

      // Should only have one sUSDS entry (from Zerion positions, as it comes first)
      const susdsTokens = result.filter((t) => t.symbol === "sUSDS");
      expect(susdsTokens).toHaveLength(1);
    });

    test("handles extra token fetch errors gracefully", async () => {
      const { getPublicClient } = await import("./public-client");
      vi.mocked(getPublicClient).mockReturnValue({
        multicall: vi.fn().mockRejectedValue(new Error("RPC error")),
      } as never);

      mockOk([pos()]);

      const result = await fetchTokenBalances([WALLET]);

      // Should still return regular tokens even if extra token fetch fails
      expect(result).toHaveLength(1);
      expect(result[0].symbol).toBe("USDC");
    });
  });
});
