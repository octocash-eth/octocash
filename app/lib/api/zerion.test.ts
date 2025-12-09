import type { Address } from "viem";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ETH_ADDRESS, USDC_ETHEREUM, USDC_OPTIMISM, WALLET } from "../../../test/test-helpers";
import { fetchZerionTokenBalances } from "./zerion";

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

describe("zerion", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("VITE_ZERION_API_KEY", mockApiKey);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("fetchZerionTokenBalances", () => {
    test("returns empty array when no addresses provided", async () => {
      expect(await fetchZerionTokenBalances([])).toEqual([]);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    test("fetches token balances for single address", async () => {
      mockOk([pos()]);

      const result = await fetchZerionTokenBalances([WALLET]);

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

      const result = await fetchZerionTokenBalances([WALLET, wallet2]);

      expect(result).toHaveLength(2);
      expect(mockFetch).toHaveBeenCalled();
    });

    test("filters out tokens with USD value less than $0.01", async () => {
      mockOk([pos({ quantity: "100.0" }), pos({ symbol: "DUST", quantity: "0.000001", price: 0.001 })]);

      const result = await fetchZerionTokenBalances([WALLET]);

      expect(result).toHaveLength(1);
      expect(result[0].symbol).toBe("USDC");
    });

    test("filters out non-displayable positions", async () => {
      mockOk([pos({ displayable: true }), pos({ symbol: "HIDDEN", quantity: "1000.0", displayable: false })]);

      const result = await fetchZerionTokenBalances([WALLET]);

      expect(result).toHaveLength(1);
      expect(result[0].symbol).toBe("USDC");
    });

    test("handles positions from multiple chains", async () => {
      mockOk([
        pos({ chainId: "ethereum" }),
        pos({ chainId: "optimism", address: USDC_OPTIMISM, quantity: "50.0" }),
        pos({ chainId: "arbitrum", symbol: "ARB", quantity: "500.0", price: 0.5 }),
      ]);

      const result = await fetchZerionTokenBalances([WALLET]);

      expect(result).toHaveLength(3);
      expect(result.find((t) => t.chainId === 1)).toBeDefined();
      expect(result.find((t) => t.chainId === 10)).toBeDefined();
      expect(result.find((t) => t.chainId === 42161)).toBeDefined();
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

      const result = await fetchZerionTokenBalances([WALLET]);

      expect(result[0].token).toBe(ETH_ADDRESS);
      expect(result[0].chainId).toBe(137);
    });

    test("handles native tokens with null address", async () => {
      mockOk([pos({ symbol: "ETH", name: "Ethereum", address: null, decimals: 18, price: 2000 })]);

      const result = await fetchZerionTokenBalances([WALLET]);

      expect(result[0].token).toBe(ETH_ADDRESS);
      expect(result[0].symbol).toBe("ETH");
    });

    test("skips positions from unsupported chains", async () => {
      mockOk([pos(), pos({ chainId: "solana", symbol: "SOL", price: 100 })]);

      const result = await fetchZerionTokenBalances([WALLET]);

      expect(result).toHaveLength(1);
      expect(result[0].symbol).toBe("USDC");
    });

    test("handles API errors gracefully and returns empty array", async () => {
      mockFail(500, "Internal Server Error");
      expect(await fetchZerionTokenBalances([WALLET])).toEqual([]);
    });

    test("handles network errors gracefully", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Network error"));
      expect(await fetchZerionTokenBalances([WALLET])).toEqual([]);
    });

    test("handles partial failures across multiple addresses", async () => {
      const wallet2 = "0x2222222222222222222222222222222222222222" as Address;
      mockOk([pos()]);
      mockFail(429, "Too Many Requests");

      const result = await fetchZerionTokenBalances([WALLET, wallet2]);

      expect(result).toHaveLength(1);
      expect(result[0].walletAddress).toBe(WALLET);
    });

    test("converts token amounts correctly using decimals", async () => {
      mockOk([pos({ quantity: "1234.567890" })]);

      const result = await fetchZerionTokenBalances([WALLET]);

      expect(result[0].amount).toBe(1234567890n);
      expect(result[0].decimals).toBe(6);
    });

    test("handles tokens with 18 decimals", async () => {
      mockOk([pos({ symbol: "WETH", quantity: "1.5", decimals: 18, price: 2000 })]);

      const result = await fetchZerionTokenBalances([WALLET]);

      expect(result[0].amount).toBe(1500000000000000000n);
    });

    test("handles empty response from Zerion", async () => {
      mockOk([]);
      expect(await fetchZerionTokenBalances([WALLET])).toEqual([]);
    });

    test("sends correct authorization header", async () => {
      mockOk([]);

      await fetchZerionTokenBalances([WALLET]);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: { Authorization: `Basic ${btoa(`${mockApiKey}:`)}`, accept: "application/json" },
        }),
      );
    });

    test("includes correct query parameters in API call", async () => {
      mockOk([]);

      await fetchZerionTokenBalances([WALLET]);

      const [url] = mockFetch.mock.calls[0] as [string, unknown];
      expect(url).toContain("currency=usd");
      expect(url).toContain("filter%5Bchain_ids%5D=");
    });

    test("handles icon URL and missing icon gracefully", async () => {
      mockOk([pos({ iconUrl: "https://example.com/icon.png" }), pos({ symbol: "NO_ICON", iconUrl: null })]);

      const result = await fetchZerionTokenBalances([WALLET]);
      expect(result).toHaveLength(2);
    });

    test("handles position with zero price", async () => {
      mockOk([pos({ symbol: "UNKNOWN", quantity: "1000.0", price: 0 })]);
      expect(await fetchZerionTokenBalances([WALLET])).toHaveLength(0);
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

      const result = await fetchZerionTokenBalances([WALLET]);

      expect(result).toHaveLength(6);
      expect(result.map((t) => t.chainId).sort()).toEqual([1, 10, 137, 42161, 59144, 8453].sort());
    });

    test("correctly checksums token addresses", async () => {
      mockOk([pos({ address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" })]);

      const result = await fetchZerionTokenBalances([WALLET]);

      expect(result[0].token).toBe(USDC_ETHEREUM);
    });

    test("uses chain from relationships when available", async () => {
      const position = pos();
      // Override attributes.chain to test that relationships takes precedence
      position.attributes.chain = "different-chain";

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(res([position])),
      });

      const result = await fetchZerionTokenBalances([WALLET]);
      expect(result[0].chainId).toBe(1);
    });

    test("falls back to attributes.chain when relationships missing", async () => {
      const position = pos({ chainId: "optimism", address: USDC_OPTIMISM });
      // Remove relationships to test fallback to attributes.chain
      delete position.relationships;
      position.attributes.chain = "optimism";

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(res([position])),
      });

      const result = await fetchZerionTokenBalances([WALLET]);
      expect(result[0].chainId).toBe(10);
    });

    test("skips positions missing chain identifier or implementation", async () => {
      const validPosition = pos();
      validPosition.attributes.chain = "ethereum";

      const noChainPosition = pos({ symbol: "UNK", name: "Unknown", decimals: 18, quantity: "1000.0" });
      delete noChainPosition.relationships;
      noChainPosition.attributes.fungible_info.implementations = [];

      const wrongImplPosition = pos({
        symbol: "WEIRD",
        name: "Weird",
        decimals: 18,
        quantity: "1000.0",
        chainId: "ethereum",
        address: WALLET,
      });
      wrongImplPosition.attributes.fungible_info.implementations = [
        { chain_id: "other", address: WALLET, decimals: 18 },
      ];
      wrongImplPosition.attributes.chain = "ethereum";

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(res([validPosition, noChainPosition, wrongImplPosition])),
      });

      const result = await fetchZerionTokenBalances([WALLET]);

      expect(result).toHaveLength(1);
      expect(result[0].symbol).toBe("USDC");
    });

    test("preserves token name in result", async () => {
      mockOk([pos({ name: "USD Coin" })]);

      const result = await fetchZerionTokenBalances([WALLET]);
      expect(result[0].name).toBe("USD Coin");
    });

    test("handles very large and very small token amounts", async () => {
      mockOk([
        pos({ symbol: "SHIB", quantity: "999999999999999.123456789", decimals: 18, price: 0.00001 }),
        pos({ symbol: "BTC", quantity: "0.000001", decimals: 18, price: 50000 }),
      ]);

      const result = await fetchZerionTokenBalances([WALLET]);

      expect(result).toHaveLength(2);
      expect(result.find((t) => t.symbol === "SHIB")?.amount).toBeGreaterThan(0n);
    });
  });

  describe("error handling", () => {
    test("handles missing API key", async () => {
      vi.stubEnv("VITE_ZERION_API_KEY", "");
      await expect(fetchZerionTokenBalances([WALLET])).rejects.toThrow("VITE_ZERION_API_KEY is not set");
    });

    test("handles malformed JSON response", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.reject(new Error("Invalid JSON")) });
      expect(await fetchZerionTokenBalances([WALLET])).toEqual([]);
    });

    test("handles timeout errors", async () => {
      mockFetch.mockRejectedValueOnce(new Error("ETIMEDOUT"));
      expect(await fetchZerionTokenBalances([WALLET])).toEqual([]);
    });

    test("handles invalid token quantity gracefully", async () => {
      const validPosition = pos({ symbol: "VALID", name: "Valid Token" });
      validPosition.attributes.chain = "ethereum";

      const invalidPosition = pos({ symbol: "INVALID", name: "Invalid Token", address: WALLET });
      invalidPosition.attributes.quantity.numeric = "not_a_number";
      invalidPosition.attributes.chain = "ethereum";

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(res([validPosition, invalidPosition])),
      });

      const result = await fetchZerionTokenBalances([WALLET]);

      expect(result).toHaveLength(1);
      expect(result[0].symbol).toBe("VALID");
    });

    test("handles invalid input (null addresses)", async () => {
      // @ts-expect-error - intentionally passing null to test error handling
      await expect(fetchZerionTokenBalances(null)).rejects.toThrow();
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

      await fetchZerionTokenBalances(addresses);

      expect(mockFetch).toHaveBeenCalled();
      if (callTimes.length >= 3) {
        expect(callTimes[2] - callTimes[0]).toBeLessThan(50);
      }
    });
  });
});
