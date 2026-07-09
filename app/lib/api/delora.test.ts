import { type Address, parseUnits, zeroAddress } from "viem";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { WALLET } from "../../../test/test-helpers";
import { USDC } from "../../data/token-contracts";
import { isSameToken } from "../tokens";
import {
  checkDeloraRoutableToUsdc,
  deloraPriceKey,
  EXTRA_TOKENS,
  fetchDeloraPrices,
  fetchDeloraTokensForChain,
  fetchExtraTokenBalances,
} from "./delora";

// biome-ignore lint/suspicious/noExplicitAny: Test mocks require any types for flexibility
type MockContract = any;

/** Delora `/v1/prices` response for the given (chainId, token, price) rows. */
function pricesResponse(rows: Array<[number, string, string]>) {
  return {
    prices: rows.map(([chainId, token, priceUSD]) => ({ chainId, token, priceUSD })),
  };
}

/**
 * Helper to create a multicall mock that returns balances and metadata
 */
function createMulticallMock(
  config: {
    balances?: Record<string, bigint>;
    metadata?: Record<string, { name: string; symbol: string; decimals: number }>;
  } = {},
) {
  return vi.fn().mockImplementation(async ({ contracts }: { contracts: MockContract[] }) => {
    const results = [];
    const isBalanceCall = contracts.every((c: MockContract) => c.functionName === "balanceOf");

    if (isBalanceCall) {
      // Balance call
      for (const contract of contracts) {
        const addr = contract.address?.toLowerCase();
        const balance = config.balances?.[addr] ?? 0n;
        results.push({ status: "success", result: balance });
      }
    } else {
      // Metadata call
      for (const contract of contracts) {
        const fn = contract.functionName;
        const addr = contract.address?.toLowerCase();
        const metadata = config.metadata?.[addr] ?? {
          name: "Mock Token",
          symbol: "MOCK",
          decimals: 18,
        };

        if (fn === "name") {
          results.push({ status: "success", result: metadata.name });
        } else if (fn === "symbol") {
          results.push({ status: "success", result: metadata.symbol });
        } else if (fn === "decimals") {
          results.push({ status: "success", result: metadata.decimals });
        }
      }
    }
    return results;
  });
}

/**
 * Helper to create a multicall mock that fails for certain operations
 */
function createFailingMulticallMock(config: {
  balanceFailure?: boolean;
  metadataFailure?: boolean;
  partialMetadataFailure?: "name" | "symbol" | "decimals";
}) {
  return vi.fn().mockImplementation(async ({ contracts }: { contracts: MockContract[] }) => {
    const results = [];
    const isBalanceCall = contracts.every((c: MockContract) => c.functionName === "balanceOf");

    if (isBalanceCall) {
      if (config.balanceFailure) {
        for (let i = 0; i < contracts.length; i++) {
          results.push({ status: "failure", error: new Error("Balance fetch failed") });
        }
      } else {
        for (let i = 0; i < contracts.length; i++) {
          results.push({ status: "success", result: 0n });
        }
      }
    } else {
      if (config.metadataFailure) {
        throw new Error("Metadata fetch failed");
      }

      for (const contract of contracts) {
        const fn = contract.functionName;
        if (fn === config.partialMetadataFailure) {
          results.push({ status: "failure", error: new Error(`${fn} fetch failed`) });
        } else if (fn === "name") {
          results.push({ status: "success", result: "Mock Token" });
        } else if (fn === "symbol") {
          results.push({ status: "success", result: "MOCK" });
        } else if (fn === "decimals") {
          results.push({ status: "success", result: 18 });
        }
      }
    }
    return results;
  });
}

// Mock getPublicClient for RPC calls
vi.mock("../public-client", () => ({
  getPublicClient: vi.fn((_chainId: number) => ({
    multicall: createMulticallMock(),
  })),
}));

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

  describe("fetchExtraTokenBalances", () => {
    test("returns empty array when no addresses provided", async () => {
      const result = await fetchExtraTokenBalances([]);
      expect(result).toEqual([]);
    });

    test("returns empty array when all balances are zero", async () => {
      const { getPublicClient } = await import("../public-client");

      vi.mocked(getPublicClient).mockImplementation(
        (_chainId: number) =>
          ({
            multicall: createMulticallMock(), // All balances default to 0
          }) as never,
      );

      const result = await fetchExtraTokenBalances([WALLET]);
      expect(result).toHaveLength(0);
    });

    test("fetches token with non-zero balance and price from Delora", async () => {
      const { getPublicClient } = await import("../public-client");
      const sUSDS_ADDRESS = "0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD".toLowerCase();

      vi.mocked(getPublicClient).mockImplementation((chainId: number) => {
        if (chainId === 1) {
          return {
            multicall: createMulticallMock({
              balances: { [sUSDS_ADDRESS]: 1000000000000000000n },
              metadata: {
                [sUSDS_ADDRESS]: { name: "Sky Savings USDS", symbol: "sUSDS", decimals: 18 },
              },
            }),
          } as never;
        }
        return { multicall: createMulticallMock() } as never;
      });

      // Mock Delora pricing API response
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(pricesResponse([[1, sUSDS_ADDRESS, "1.05"]])),
      });

      const result = await fetchExtraTokenBalances([WALLET]);

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        symbol: "sUSDS",
        chainId: 1,
        walletAddress: WALLET,
        decimals: 18,
        amount: 1000000000000000000n,
      });
    });

    test("handles multiple tokens with balances on different chains", async () => {
      const { getPublicClient } = await import("../public-client");
      const TOKEN1_ADDRESS = "0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD".toLowerCase();
      const TOKEN2_ADDRESS = "0x1111111111111111111111111111111111111111".toLowerCase();

      vi.mocked(getPublicClient).mockImplementation((chainId: number) => {
        const balances: Record<string, bigint> = {};
        const metadata: Record<string, { name: string; symbol: string; decimals: number }> = {};

        if (chainId === 1) {
          balances[TOKEN1_ADDRESS] = 1000000000000000000n;
          metadata[TOKEN1_ADDRESS] = { name: "Token 1", symbol: "TKN1", decimals: 18 };
        } else if (chainId === 10) {
          balances[TOKEN2_ADDRESS] = 1000000000000000000n;
          metadata[TOKEN2_ADDRESS] = { name: "Token 2", symbol: "TKN2", decimals: 18 };
        }

        return { multicall: createMulticallMock({ balances, metadata }) } as never;
      });

      // One batched Delora pricing call covers both chains.
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve(
            pricesResponse([
              [1, TOKEN1_ADDRESS, "1.0"],
              [10, TOKEN2_ADDRESS, "2.0"],
            ]),
          ),
      });

      const result = await fetchExtraTokenBalances([WALLET]);

      expect(result.length).toBeGreaterThan(0);
    });

    test("filters out tokens with value less than $0.01", async () => {
      const { getPublicClient } = await import("../public-client");
      const TOKEN_ADDRESS = "0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD".toLowerCase();

      vi.mocked(getPublicClient).mockImplementation((chainId: number) => {
        if (chainId === 1) {
          return {
            multicall: createMulticallMock({
              balances: { [TOKEN_ADDRESS]: 1000000000000000n }, // 0.001 tokens
              metadata: {
                [TOKEN_ADDRESS]: { name: "Dust Token", symbol: "DUST", decimals: 18 },
              },
            }),
          } as never;
        }
        return { multicall: createMulticallMock() } as never;
      });

      // Very low price (0.001 tokens * $0.001 = $0.000001 < $0.01)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(pricesResponse([[1, TOKEN_ADDRESS, "0.001"]])),
      });

      const result = await fetchExtraTokenBalances([WALLET]);

      // Should be filtered out due to low value
      expect(result).toHaveLength(0);
    });

    test("handles Delora API errors gracefully", async () => {
      const { getPublicClient } = await import("../public-client");
      const TOKEN_ADDRESS = "0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD".toLowerCase();

      vi.mocked(getPublicClient).mockImplementation((chainId: number) => {
        if (chainId === 1) {
          return {
            multicall: createMulticallMock({
              balances: { [TOKEN_ADDRESS]: 1000000000000000000n },
              metadata: {
                [TOKEN_ADDRESS]: { name: "Token", symbol: "TKN", decimals: 18 },
              },
            }),
          } as never;
        }
        return { multicall: vi.fn().mockResolvedValue([]) } as never;
      });

      // Mock Delora API failure
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
      });

      const result = await fetchExtraTokenBalances([WALLET]);

      // Should still return tokens, just without prices
      expect(result).toBeDefined();
    });

    test("handles multicall balance fetch errors gracefully", async () => {
      const { getPublicClient } = await import("../public-client");

      vi.mocked(getPublicClient).mockReturnValue({
        multicall: vi.fn().mockRejectedValue(new Error("RPC error")),
      } as never);

      const result = await fetchExtraTokenBalances([WALLET]);

      // Should return empty array on error
      expect(result).toHaveLength(0);
    });

    test("handles multicall metadata fetch errors gracefully", async () => {
      const { getPublicClient } = await import("../public-client");
      const TOKEN_ADDRESS = "0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD".toLowerCase();

      vi.mocked(getPublicClient).mockImplementation((chainId: number) => {
        if (chainId === 1) {
          return {
            multicall: vi.fn().mockImplementation(async ({ contracts }: { contracts: MockContract[] }) => {
              const isBalanceCall = contracts.every((c: MockContract) => c.functionName === "balanceOf");

              if (isBalanceCall) {
                // Balance call succeeds
                return contracts.map((contract) => ({
                  status: "success",
                  result: contract.address?.toLowerCase() === TOKEN_ADDRESS ? 1000000000000000000n : 0n,
                }));
              }

              // Metadata call fails
              throw new Error("Metadata fetch failed");
            }),
          } as never;
        }
        return { multicall: vi.fn().mockResolvedValue([]) } as never;
      });

      const result = await fetchExtraTokenBalances([WALLET]);

      // Should return empty array if metadata fetch fails
      expect(result).toHaveLength(0);
    });

    test("handles failed balance results in multicall", async () => {
      const { getPublicClient } = await import("../public-client");

      vi.mocked(getPublicClient).mockImplementation(
        (_chainId: number) =>
          ({
            multicall: createFailingMulticallMock({ balanceFailure: true }),
          }) as never,
      );

      const result = await fetchExtraTokenBalances([WALLET]);
      expect(result).toHaveLength(0);
    });

    test("handles partial success in metadata multicall", async () => {
      const { getPublicClient } = await import("../public-client");
      const TOKEN_ADDRESS = "0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD".toLowerCase();

      vi.mocked(getPublicClient).mockImplementation((chainId: number) => {
        if (chainId === 1) {
          return {
            multicall: vi.fn().mockImplementation(async ({ contracts }: { contracts: MockContract[] }) => {
              const results = [];
              const isBalanceCall = contracts.every((c: MockContract) => c.functionName === "balanceOf");

              if (isBalanceCall) {
                for (const contract of contracts) {
                  const isTarget = contract.address?.toLowerCase() === TOKEN_ADDRESS;
                  results.push({
                    status: "success",
                    result: isTarget ? 1000000000000000000n : 0n,
                  });
                }
              } else {
                // Metadata: name fails, symbol and decimals succeed
                for (const contract of contracts) {
                  const fn = contract.functionName;
                  if (fn === "name") {
                    results.push({ status: "failure", error: new Error("Name fetch failed") });
                  } else if (fn === "symbol") {
                    results.push({ status: "success", result: "TKN" });
                  } else if (fn === "decimals") {
                    results.push({ status: "success", result: 18 });
                  }
                }
              }

              return results;
            }),
          } as never;
        }
        return { multicall: vi.fn().mockResolvedValue([]) } as never;
      });

      const result = await fetchExtraTokenBalances([WALLET]);

      // Should skip tokens with failed metadata
      expect(result).toHaveLength(0);
    });

    test("handles Delora omitting a token's price from the response", async () => {
      const { getPublicClient } = await import("../public-client");
      const TOKEN_ADDRESS = "0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD".toLowerCase();

      vi.mocked(getPublicClient).mockImplementation((chainId: number) => {
        if (chainId === 1) {
          return {
            multicall: createMulticallMock({
              balances: { [TOKEN_ADDRESS]: 1000000000000000000n },
              metadata: {
                [TOKEN_ADDRESS]: { name: "Token", symbol: "TKN", decimals: 18 },
              },
            }),
          } as never;
        }
        return { multicall: vi.fn().mockResolvedValue([]) } as never;
      });

      // Delora has no price for the token: empty prices array.
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(pricesResponse([])),
      });

      const result = await fetchExtraTokenBalances([WALLET]);

      // Token without price should be filtered out (no USD value)
      expect(result).toHaveLength(0);
    });

    test("handles case-insensitive token address matching in Delora response", async () => {
      const { getPublicClient } = await import("../public-client");
      const TOKEN_ADDRESS = "0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD".toLowerCase();

      vi.mocked(getPublicClient).mockImplementation((chainId: number) => {
        if (chainId === 1) {
          return {
            multicall: createMulticallMock({
              balances: { [TOKEN_ADDRESS]: 1000000000000000000n },
              metadata: {
                [TOKEN_ADDRESS]: { name: "Token", symbol: "TKN", decimals: 18 },
              },
            }),
          } as never;
        }
        return { multicall: vi.fn().mockResolvedValue([]) } as never;
      });

      // Delora echoes the checksum-cased address
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(pricesResponse([[1, "0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD", "1.0"]])),
      });

      const result = await fetchExtraTokenBalances([WALLET]);

      // Surviving the dust filter implies the price lookup matched
      // case-insensitively — without the match, USD would be 0 and the
      // token would be filtered out.
      expect(result).toHaveLength(1);
      expect(result[0].token.toLowerCase()).toBe(TOKEN_ADDRESS);
    });

    test("handles multiple wallets correctly", async () => {
      const { getPublicClient } = await import("../public-client");
      const WALLET2 = "0x2222222222222222222222222222222222222222" as Address;
      const TOKEN_ADDRESS = "0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD".toLowerCase();

      vi.mocked(getPublicClient).mockImplementation((chainId: number) => {
        if (chainId === 1) {
          return {
            multicall: createMulticallMock({
              balances: { [TOKEN_ADDRESS]: 1000000000000000000n },
              metadata: {
                [TOKEN_ADDRESS]: { name: "Token", symbol: "TKN", decimals: 18 },
              },
            }),
          } as never;
        }
        return { multicall: vi.fn().mockResolvedValue([]) } as never;
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(pricesResponse([[1, TOKEN_ADDRESS, "1.0"]])),
      });

      const result = await fetchExtraTokenBalances([WALLET, WALLET2]);

      // Should return tokens for both wallets
      expect(result.length).toBeGreaterThan(0);
      const wallets = new Set(result.map((t) => t.walletAddress));
      expect(wallets.size).toBeGreaterThan(0);
    });

    test("issues a single batched pricing request regardless of wallet count", async () => {
      const { getPublicClient } = await import("../public-client");
      const WALLET2 = "0x2222222222222222222222222222222222222222" as Address;
      const TOKEN_ADDRESS = "0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD".toLowerCase();

      vi.mocked(getPublicClient).mockImplementation((chainId: number) => {
        if (chainId === 1) {
          return {
            multicall: createMulticallMock({
              balances: { [TOKEN_ADDRESS]: 1000000000000000000n },
              metadata: {
                [TOKEN_ADDRESS]: { name: "Token", symbol: "TKN", decimals: 18 },
              },
            }),
          } as never;
        }
        return { multicall: vi.fn().mockResolvedValue([]) } as never;
      });

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(pricesResponse([[1, TOKEN_ADDRESS, "1.0"]])),
      });

      await fetchExtraTokenBalances([WALLET, WALLET2]);

      const priceCalls = mockFetch.mock.calls.filter(
        (call: unknown[]) => typeof call[0] === "string" && call[0].includes("/v1/prices"),
      );
      expect(priceCalls).toHaveLength(1);
      // The same (chainId, token) pair appears once despite two wallets.
      const tokensParam = new URL(priceCalls[0][0] as string).searchParams.get("tokens") ?? "";
      const occurrences = tokensParam.split(",").filter((p) => p === `1:${TOKEN_ADDRESS}`);
      expect(occurrences).toHaveLength(1);
    });

    test("can be used with isSameToken for deduplication", async () => {
      const { getPublicClient } = await import("../public-client");
      const TOKEN_ADDRESS = "0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD".toLowerCase();

      vi.mocked(getPublicClient).mockImplementation((chainId: number) => {
        if (chainId === 1) {
          return {
            multicall: createMulticallMock({
              balances: { [TOKEN_ADDRESS]: 1000000000000000000n },
              metadata: {
                [TOKEN_ADDRESS]: { name: "Token", symbol: "TKN", decimals: 18 },
              },
            }),
          } as never;
        }
        return { multicall: vi.fn().mockResolvedValue([]) } as never;
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(pricesResponse([[1, TOKEN_ADDRESS, "1.0"]])),
      });

      const result = await fetchExtraTokenBalances([WALLET]);

      if (result.length > 0) {
        // Same token should match itself
        expect(isSameToken(result[0], result[0])).toBe(true);
      }
    });

    test("handles fetch rejection in Delora API call", async () => {
      const { getPublicClient } = await import("../public-client");
      const TOKEN_ADDRESS = "0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD".toLowerCase();

      vi.mocked(getPublicClient).mockImplementation((chainId: number) => {
        if (chainId === 1) {
          return {
            multicall: createMulticallMock({
              balances: { [TOKEN_ADDRESS]: 1000000000000000000n },
              metadata: {
                [TOKEN_ADDRESS]: { name: "Token", symbol: "TKN", decimals: 18 },
              },
            }),
          } as never;
        }
        return { multicall: vi.fn().mockResolvedValue([]) } as never;
      });

      // Network error
      mockFetch.mockRejectedValueOnce(new Error("Network error"));

      const result = await fetchExtraTokenBalances([WALLET]);

      // Should still return tokens, just without prices
      expect(result).toBeDefined();
    });

    test("handles overall function error gracefully", async () => {
      const { getPublicClient } = await import("../public-client");

      // Simulate an unexpected error
      vi.mocked(getPublicClient).mockImplementation(() => {
        throw new Error("Unexpected error");
      });

      const result = await fetchExtraTokenBalances([WALLET]);

      // Should return empty array
      expect(result).toEqual([]);
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

    test("chunks very large requests to bound URL length", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(pricesResponse([])),
      });

      // 150 unique addresses -> 2 requests at a 100-pair chunk size.
      const tokens = Array.from({ length: 150 }, (_, i) => ({
        chainId: 1,
        token: `0x${(i + 1).toString(16).padStart(40, "0")}` as Address,
      }));

      await fetchDeloraPrices(tokens);

      expect(mockFetch).toHaveBeenCalledTimes(2);
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
    test("returns a Set of lowercased addresses on success", async () => {
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

      const set = await fetchDeloraTokensForChain(1);

      expect(set).toBeInstanceOf(Set);
      expect(set.size).toBe(3);
      expect(set.has(CHECKSUM.toLowerCase())).toBe(true);
      expect(set.has(LOWER)).toBe(true);
      expect(set.has(zeroAddress)).toBe(true);
      // The checksum form must NOT remain — UI looks up by `.toLowerCase()`.
      expect(set.has(CHECKSUM)).toBe(false);
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

      const set = await fetchDeloraTokensForChain(1);

      expect(set.size).toBe(0);
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
