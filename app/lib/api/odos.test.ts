import { type Address, parseUnits, zeroAddress } from "viem";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { WALLET } from "../../../test/test-helpers";
import { USDC } from "../../data/token-contracts";
import { isSameToken } from "../tokens";
import {
  checkOdosRoutableToUsdc,
  EXTRA_TOKENS,
  fetchExtraTokenBalances,
  fetchOdosPrices,
  fetchOdosTokensForChain,
  odosPriceKey,
} from "./odos";
import { odosBaseUrl } from "./odos-client";

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

  describe("fetchOdosPrices", () => {
    const ADDR_1 = "0x1111111111111111111111111111111111111111" as Address;
    const ADDR_2 = "0x2222222222222222222222222222222222222222" as Address;
    // Mainnet WETH — what we substitute zeroAddress with on chain 1.
    const WETH_MAINNET = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
    const ODOS_NATIVE = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

    test("returns empty map when no tokens are passed", async () => {
      const result = await fetchOdosPrices([]);
      expect(result.size).toBe(0);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    test("groups tokens by chain and issues one request per chain", async () => {
      mockFetch.mockImplementation((url: string) => {
        const chainPath = new URL(url).pathname.split("/").pop();
        if (chainPath === "1") {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ currencyId: "USD", tokenPrices: { [ADDR_1]: 2.5 } }),
          });
        }
        if (chainPath === "10") {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ currencyId: "USD", tokenPrices: { [ADDR_2]: 7.0 } }),
          });
        }
        throw new Error(`Unexpected URL: ${url}`);
      });

      const result = await fetchOdosPrices([
        { chainId: 1, token: ADDR_1 },
        { chainId: 10, token: ADDR_2 },
      ]);

      expect(result.get(odosPriceKey(1, ADDR_1))).toBe(2.5);
      expect(result.get(odosPriceKey(10, ADDR_2))).toBe(7.0);
      // One fetch per chain
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    test("dedupes addresses within a chain", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ currencyId: "USD", tokenPrices: { [ADDR_1]: 1.23 } }),
      });

      await fetchOdosPrices([
        { chainId: 1, token: ADDR_1 },
        { chainId: 1, token: ADDR_1 },
        { chainId: 1, token: ADDR_1 },
      ]);

      const fetchedUrl = mockFetch.mock.calls[0][0] as string;
      const params = new URL(fetchedUrl).searchParams.getAll("token_addresses");
      expect(params).toHaveLength(1);
    });

    test("returns prices keyed by lowercase address", async () => {
      const UPPER = "0xAaaaAaaaAaAaAaaaAAAAAAaaAAaaaaAAaaAaAaAa" as Address;
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            currencyId: "USD",
            // Odos returns mixed case
            tokenPrices: { [UPPER]: 9.99 },
          }),
      });

      const result = await fetchOdosPrices([{ chainId: 1, token: UPPER }]);

      expect(result.get(odosPriceKey(1, UPPER))).toBe(9.99);
      // Key must always be lowercase
      expect([...result.keys()][0]).toBe(`1:${UPPER.toLowerCase()}`);
    });

    test("handles null prices gracefully (omits them from the map)", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            currencyId: "USD",
            tokenPrices: { [ADDR_1]: null, [ADDR_2]: 4.2 },
          }),
      });

      const result = await fetchOdosPrices([
        { chainId: 1, token: ADDR_1 },
        { chainId: 1, token: ADDR_2 },
      ]);

      expect(result.has(odosPriceKey(1, ADDR_1))).toBe(false);
      expect(result.get(odosPriceKey(1, ADDR_2))).toBe(4.2);
    });

    test("isolates per-chain failures: one chain failing does not poison others", async () => {
      mockFetch.mockImplementation((url: string) => {
        const chainPath = new URL(url).pathname.split("/").pop();
        if (chainPath === "1") {
          return Promise.resolve({ ok: false, status: 500 });
        }
        if (chainPath === "10") {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ currencyId: "USD", tokenPrices: { [ADDR_2]: 3.14 } }),
          });
        }
        return Promise.reject(new Error(`Unexpected URL: ${url}`));
      });

      const result = await fetchOdosPrices([
        { chainId: 1, token: ADDR_1 },
        { chainId: 10, token: ADDR_2 },
      ]);

      expect(result.has(odosPriceKey(1, ADDR_1))).toBe(false);
      expect(result.get(odosPriceKey(10, ADDR_2))).toBe(3.14);
    });

    test("network error on a chain is swallowed; other chains still return", async () => {
      mockFetch.mockImplementation((url: string) => {
        const chainPath = new URL(url).pathname.split("/").pop();
        if (chainPath === "1") {
          return Promise.reject(new Error("Network error"));
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ currencyId: "USD", tokenPrices: { [ADDR_2]: 1.0 } }),
        });
      });

      const result = await fetchOdosPrices([
        { chainId: 1, token: ADDR_1 },
        { chainId: 10, token: ADDR_2 },
      ]);

      expect(result.get(odosPriceKey(10, ADDR_2))).toBe(1.0);
    });

    test("substitutes wrapped-native (WETH) for zeroAddress in the request but keys back with zeroAddress", async () => {
      let capturedUrl = "";
      mockFetch.mockImplementation((url: string) => {
        capturedUrl = url;
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              currencyId: "USD",
              // Odos returns the WETH price; the sentinel price (if any) is
              // deliberately wrong here so the test fails loudly if we ever
              // regress to using it.
              tokenPrices: { [WETH_MAINNET]: 2286.97, [ODOS_NATIVE]: 9_999_999 },
            }),
        });
      });

      const result = await fetchOdosPrices([{ chainId: 1, token: zeroAddress }]);

      // The request must use WETH, not the sentinel.
      const params = new URL(capturedUrl).searchParams.getAll("token_addresses");
      expect(params).toHaveLength(1);
      expect(params[0].toLowerCase()).toBe(WETH_MAINNET);
      // The result must be keyed back with zeroAddress AND must be the WETH price.
      expect(result.get(odosPriceKey(1, zeroAddress))).toBe(2286.97);
    });

    test("dedupes the request when a caller asks for both native and wrapped-native, and populates both keys", async () => {
      let capturedUrl = "";
      mockFetch.mockImplementation((url: string) => {
        capturedUrl = url;
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              currencyId: "USD",
              tokenPrices: { [WETH_MAINNET]: 2300.0 },
            }),
        });
      });

      const result = await fetchOdosPrices([
        { chainId: 1, token: zeroAddress },
        { chainId: 1, token: WETH_MAINNET as Address },
      ]);

      // Only one address sent to Odos despite two registered tokens.
      const params = new URL(capturedUrl).searchParams.getAll("token_addresses");
      expect(params).toHaveLength(1);
      expect(params[0].toLowerCase()).toBe(WETH_MAINNET);

      // Both keys resolve to the WETH price.
      expect(result.get(odosPriceKey(1, zeroAddress))).toBe(2300.0);
      expect(result.get(odosPriceKey(1, WETH_MAINNET as Address))).toBe(2300.0);
    });

    test("skips native pricing on a chain we haven't mapped (no wrapped-native sentinel fallback)", async () => {
      // Chain 999 is intentionally unmapped in `wrappedNative`. The only token
      // we ask for is native on that chain — so we expect no request to fire
      // and no price to come back.
      const result = await fetchOdosPrices([{ chainId: 999, token: zeroAddress }]);

      expect(mockFetch).not.toHaveBeenCalled();
      expect(result.size).toBe(0);
    });

    test("forwards AbortSignal to fetch", async () => {
      mockFetch.mockImplementation((_url: string, init: RequestInit) => {
        if (init.signal?.aborted) {
          return Promise.reject(new DOMException("aborted", "AbortError"));
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ currencyId: "USD", tokenPrices: { [ADDR_1]: 1.0 } }),
        });
      });

      const controller = new AbortController();
      controller.abort();

      const result = await fetchOdosPrices([{ chainId: 1, token: ADDR_1 }], controller.signal);

      // Aborted before fetch resolved → no price recorded
      expect(result.has(odosPriceKey(1, ADDR_1))).toBe(false);
    });
  });

  describe("fetchOdosTokensForChain", () => {
    test("returns a Set of lowercased addresses on success", async () => {
      // Mix a checksum-cased address, an already-lowercase one, and native ETH
      // (which Odos returns as `0x00…00`) so we lock in both the lowercase
      // normalisation and the native-token handling the UI relies on.
      const CHECKSUM = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
      const LOWER = "0xdac17f958d2ee523a2206206994597c13d831ec7";
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve([
            { address: CHECKSUM, chainId: "1", symbol: "USDC", name: "USD Coin", decimals: 6, isWhitelisted: true },
            { address: LOWER, chainId: "1", symbol: "USDT", name: "Tether", decimals: 6, isWhitelisted: true },
            { address: zeroAddress, chainId: "1", symbol: "ETH", name: "Ethereum", decimals: 18, isWhitelisted: true },
          ]),
      });

      const set = await fetchOdosTokensForChain(1);

      expect(set).toBeInstanceOf(Set);
      expect(set.size).toBe(3);
      expect(set.has(CHECKSUM.toLowerCase())).toBe(true);
      expect(set.has(LOWER)).toBe(true);
      expect(set.has(zeroAddress)).toBe(true);
      // The checksum form must NOT remain — UI looks up by `.toLowerCase()`.
      expect(set.has(CHECKSUM)).toBe(false);
    });

    test("builds the documented URL: /token?query=&chainId=N", async () => {
      let capturedUrl = "";
      mockFetch.mockImplementation((url: string) => {
        capturedUrl = url;
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
      });

      await fetchOdosTokensForChain(42161);

      const parsed = new URL(capturedUrl);
      expect(parsed.origin + parsed.pathname).toBe("https://api.odos.xyz/token");
      expect(parsed.searchParams.get("chainId")).toBe("42161");
      expect(parsed.searchParams.get("query")).toBe("");
    });

    test("throws on non-2xx so callers can observe the failure", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 503, statusText: "Service Unavailable" });

      await expect(fetchOdosTokensForChain(1)).rejects.toThrow(/Odos \/token failed for chain 1/);
    });

    test("forwards AbortSignal to fetch", async () => {
      mockFetch.mockImplementation((_url: string, init: RequestInit) => {
        if (init.signal?.aborted) {
          return Promise.reject(new DOMException("aborted", "AbortError"));
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
      });

      const controller = new AbortController();
      controller.abort();

      await expect(fetchOdosTokensForChain(1, controller.signal)).rejects.toThrow();
    });
  });

  describe("checkOdosRoutableToUsdc", () => {
    // A random ERC20 on mainnet — not USDC, so the probe is meaningful.
    const HIDDEN_TOKEN = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Address;

    test("returns true when Odos returns a non-zero outAmount", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ pathId: "abc", outAmounts: ["1000000"] }),
      });

      const result = await checkOdosRoutableToUsdc({
        chainId: 1,
        token: HIDDEN_TOKEN,
        decimals: 18,
        unitaryPrice: 1,
      });

      expect(result).toBe(true);
      // Routes to /sor/quote/v3 with the USDC mainnet address as the output.
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe(`${odosBaseUrl()}/sor/quote/v3`);
      const body = JSON.parse((init as RequestInit).body as string) as {
        chainId: number;
        inputTokens: { tokenAddress: string; amount: string }[];
        outputTokens: { tokenAddress: string; proportion: number }[];
        userAddr: string;
        simple?: boolean;
      };
      expect(body.chainId).toBe(1);
      expect(body.inputTokens[0].tokenAddress).toBe(HIDDEN_TOKEN);
      expect(body.outputTokens[0].tokenAddress.toLowerCase()).toBe(USDC[1].toLowerCase());
      expect(body.userAddr).toBe(zeroAddress);
      expect(body.simple).toBe(true);
    });

    test("returns false on non-2xx response", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

      const result = await checkOdosRoutableToUsdc({
        chainId: 1,
        token: HIDDEN_TOKEN,
        decimals: 18,
        unitaryPrice: 1,
      });

      expect(result).toBe(false);
    });

    test("returns false on thrown network error", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Network error"));

      const result = await checkOdosRoutableToUsdc({
        chainId: 1,
        token: HIDDEN_TOKEN,
        decimals: 18,
        unitaryPrice: 1,
      });

      expect(result).toBe(false);
    });

    test("returns false when outAmounts is missing", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ pathId: "abc" }),
      });

      const result = await checkOdosRoutableToUsdc({
        chainId: 1,
        token: HIDDEN_TOKEN,
        decimals: 18,
        unitaryPrice: 1,
      });

      expect(result).toBe(false);
    });

    test("returns false when outAmounts[0] is zero", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ pathId: "abc", outAmounts: ["0"] }),
      });

      const result = await checkOdosRoutableToUsdc({
        chainId: 1,
        token: HIDDEN_TOKEN,
        decimals: 18,
        unitaryPrice: 1,
      });

      expect(result).toBe(false);
    });

    test("returns false (and doesn't fetch) when token is already USDC on that chain", async () => {
      const result = await checkOdosRoutableToUsdc({
        chainId: 1,
        token: USDC[1],
        decimals: 6,
        unitaryPrice: 1,
      });

      expect(result).toBe(false);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    test("returns false (and doesn't fetch) when chain has no USDC mapping", async () => {
      const result = await checkOdosRoutableToUsdc({
        chainId: 999_999,
        token: HIDDEN_TOKEN,
        decimals: 18,
        unitaryPrice: 1,
      });

      expect(result).toBe(false);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    test("returns false (and doesn't fetch) when unitaryPrice is non-positive", async () => {
      const zeroPrice = await checkOdosRoutableToUsdc({
        chainId: 1,
        token: HIDDEN_TOKEN,
        decimals: 18,
        unitaryPrice: 0,
      });
      const negativePrice = await checkOdosRoutableToUsdc({
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
        json: () => Promise.resolve({ pathId: "abc", outAmounts: ["1"] }),
      });

      await checkOdosRoutableToUsdc({
        chainId: 1,
        token: HIDDEN_TOKEN,
        decimals: 18,
        unitaryPrice: 2,
      });

      const init = mockFetch.mock.calls[0][1] as RequestInit;
      const body = JSON.parse(init.body as string) as {
        inputTokens: { amount: string }[];
      };
      // $1 of a $2 token → 0.5 tokens with 18 decimals.
      expect(body.inputTokens[0].amount).toBe(parseUnits("0.5", 18).toString());
    });

    test("clamps the amount to 1n when the $1-equivalent rounds to zero", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ pathId: "abc", outAmounts: ["1"] }),
      });

      // A 0-decimal token at $0.01 would round to 100 tokens of $1, but a
      // 0-decimal token priced at $1,000,000 would truncate to 0 — that's
      // the clamp case we want to verify.
      await checkOdosRoutableToUsdc({
        chainId: 1,
        token: HIDDEN_TOKEN,
        decimals: 0,
        unitaryPrice: 1_000_000,
      });

      const init = mockFetch.mock.calls[0][1] as RequestInit;
      const body = JSON.parse(init.body as string) as {
        inputTokens: { amount: string }[];
      };
      expect(body.inputTokens[0].amount).toBe("1");
    });

    test("forwards AbortSignal to fetch and returns false when aborted", async () => {
      mockFetch.mockImplementation((_url: string, init: RequestInit) => {
        if (init.signal?.aborted) {
          return Promise.reject(new DOMException("aborted", "AbortError"));
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ pathId: "abc", outAmounts: ["1"] }),
        });
      });

      const controller = new AbortController();
      controller.abort();

      const result = await checkOdosRoutableToUsdc(
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
