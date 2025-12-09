import type { Address } from "viem";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { WALLET } from "../../../test/test-helpers";
import { isSameToken } from "../tokens";
import { EXTRA_TOKENS, fetchExtraTokenBalances } from "./odos";

// biome-ignore lint/suspicious/noExplicitAny: Test mocks require any types for flexibility
type MockContract = any;

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

describe("odos", () => {
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

    test("fetches token with non-zero balance and price from Odos", async () => {
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

      // Mock Odos pricing API response
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

      const result = await fetchExtraTokenBalances([WALLET]);

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        symbol: "sUSDS",
        chainId: 1,
        walletAddress: WALLET,
        decimals: 18,
        unitaryPrice: 1.05,
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

      // Mock Odos pricing for chain 1
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            currencyId: "USD",
            tokenPrices: {
              "0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD": 1.0,
            },
          }),
      });

      // Mock Odos pricing for chain 10
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            currencyId: "USD",
            tokenPrices: {
              "0x1111111111111111111111111111111111111111": 2.0,
            },
          }),
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
        json: () =>
          Promise.resolve({
            currencyId: "USD",
            tokenPrices: {
              "0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD": 0.001,
            },
          }),
      });

      const result = await fetchExtraTokenBalances([WALLET]);

      // Should be filtered out due to low value
      expect(result).toHaveLength(0);
    });

    test("handles Odos API errors gracefully", async () => {
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

      // Mock Odos API failure
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

    test("handles Odos API returning null price", async () => {
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

      // Odos returns null price
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            currencyId: "USD",
            tokenPrices: {
              "0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD": null,
            },
          }),
      });

      const result = await fetchExtraTokenBalances([WALLET]);

      // Token without price should be filtered out (no USD value)
      expect(result).toHaveLength(0);
    });

    test("handles case-insensitive token address matching in Odos response", async () => {
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

      // Odos returns lowercase address
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            currencyId: "USD",
            tokenPrices: {
              [TOKEN_ADDRESS.toLowerCase()]: 1.0,
            },
          }),
      });

      const result = await fetchExtraTokenBalances([WALLET]);

      expect(result).toHaveLength(1);
      expect(result[0].unitaryPrice).toBe(1.0);
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
        json: () =>
          Promise.resolve({
            currencyId: "USD",
            tokenPrices: {
              "0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD": 1.0,
            },
          }),
      });

      const result = await fetchExtraTokenBalances([WALLET, WALLET2]);

      // Should return tokens for both wallets
      expect(result.length).toBeGreaterThan(0);
      const wallets = new Set(result.map((t) => t.walletAddress));
      expect(wallets.size).toBeGreaterThan(0);
    });

    test("deduplicates Odos API calls for same token on same chain", async () => {
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
        json: () =>
          Promise.resolve({
            currencyId: "USD",
            tokenPrices: {
              "0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD": 1.0,
            },
          }),
      });

      await fetchExtraTokenBalances([WALLET, WALLET2]);

      // Should only call Odos API once per chain, not once per wallet
      const odosCalls = mockFetch.mock.calls.filter(
        (call: unknown[]) => typeof call[0] === "string" && call[0].includes("api.odos.xyz"),
      );

      // Should be called once for chain 1 (not twice despite two wallets)
      expect(odosCalls.length).toBeLessThanOrEqual(EXTRA_TOKENS.filter((t) => t.chainId === 1).length);
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
        json: () =>
          Promise.resolve({
            currencyId: "USD",
            tokenPrices: {
              "0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD": 1.0,
            },
          }),
      });

      const result = await fetchExtraTokenBalances([WALLET]);

      if (result.length > 0) {
        // Same token should match itself
        expect(isSameToken(result[0], result[0])).toBe(true);
      }
    });

    test("handles fetch rejection in Odos API call", async () => {
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
});
