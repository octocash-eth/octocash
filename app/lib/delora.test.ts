import type { Address, Hex, Log, PublicClient } from "viem";
import { encodeAbiParameters, encodeEventTopics, ethAddress, parseAbi, parseAbiParameters } from "viem";
import type { Mock } from "vitest";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ETH_ADDRESS, makeToken, WALLET } from "../../test/test-helpers";

import {
  buildDeloraCalls,
  type CrossChainDeliveryRecord,
  clearSwapQuoteCache,
  executeDeloraCrossChainSwap,
  executeDeloraSwap,
  getCrossChainSwapQuoteWithLegs,
  getSwapQuote,
  waitForCrossChainDelivery,
} from "./delora";

type SendCallsReturn = [Hex, Log[][]];
type SendCallsFn = Mock<(...args: unknown[]) => Promise<SendCallsReturn>>;

// Mock the public-client module. `retryOnRateLimit` must ride along: the
// delivery wait reads balances through tokens.ts, which wraps ERC20 reads in
// it — the mock replaces the whole module, so a missing export would make
// every balance read throw.
vi.mock("./public-client", () => ({
  getPublicClient: vi.fn(() => ({
    readContract: vi.fn().mockResolvedValue(0n), // Default: no allowance
  })),
  retryOnRateLimit: vi.fn((fn: () => unknown) => fn()),
}));

const DELORA_ENTRYPOINT = "0x0000000000000000000000000000000000000e01" as const;
const USDC_TOKEN = "0x0000000000000000000000000000000000000001" as const;
const USDT_TOKEN = "0x0000000000000000000000000000000000000003" as const;

/** Standard successful `/v1/quotes` response body. */
function makeQuoteResponse(overrides?: Record<string, unknown>) {
  return {
    inputAmount: "999000",
    outputAmount: "3000000",
    minOutputAmount: "2985000",
    adapter: "TESTADAPTER",
    calldata: {
      to: DELORA_ENTRYPOINT,
      data: "0xdeadbeef",
      value: "0x2",
    },
    approvalAddress: DELORA_ENTRYPOINT,
    warnings: [],
    ...overrides,
  };
}

function stubQuoteFetch(overrides?: Record<string, unknown>) {
  const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url.includes("/v1/quotes")) {
      return {
        ok: true,
        status: 200,
        json: async () => makeQuoteResponse(overrides),
        text: async () => "",
      } as unknown as Response;
    }
    return {
      ok: false,
      status: 404,
      json: async () => ({}),
      text: async () => "Not Found",
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function quoteParams(fetchMock: Mock, callIndex = 0): URLSearchParams {
  const [url] = fetchMock.mock.calls[callIndex];
  return new URL(url as string).searchParams;
}

const transferEventAbi = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]);

/** Minimal ERC20 Transfer log, shaped like simulateCalls/receipt logs. */
function makeTransferLog(token: Address, to: Address, value: bigint): Log {
  return {
    address: token,
    topics: encodeEventTopics({
      abi: transferEventAbi,
      eventName: "Transfer",
      args: { from: "0x000000000000000000000000000000000000dead" as Address, to },
    }),
    data: encodeAbiParameters(parseAbiParameters("uint256"), [value]),
  } as Log;
}

/** A successful entry of `simulateCalls().results` carrying the given logs. */
function makeSimResult(logs: Log[] = []) {
  return { status: "success" as const, data: "0x" as Hex, gasUsed: 0n, logs };
}

describe("delora", () => {
  beforeEach(() => {
    // The planning quote cache is module state — isolate every test.
    clearSwapQuoteCache();
  });

  const mockTokenUSDC = makeToken(USDC_TOKEN, 1000000n, 1, { walletAddress: WALLET });
  const mockTokenUSDT = makeToken(USDT_TOKEN, 2000000n, 1, { walletAddress: WALLET, symbol: "USDT" });
  const mockTokenNative = makeToken(ETH_ADDRESS, 1000000000000000000n, 1, {
    walletAddress: WALLET,
    symbol: "ETH",
    decimals: 18,
  });

  describe("buildDeloraCalls", () => {
    let mockPublicClient: { readContract: Mock };

    beforeEach(async () => {
      const { getPublicClient } = await import("./public-client");
      mockPublicClient = {
        readContract: vi.fn().mockResolvedValue(0n), // Default: no allowance
      };
      vi.mocked(getPublicClient).mockReturnValue(mockPublicClient as Partial<PublicClient> as PublicClient);

      stubQuoteFetch();
    });

    afterEach(() => {
      vi.unstubAllGlobals();
      vi.clearAllMocks();
    });

    test("returns one approve+swap pair per input token", async () => {
      const { calls } = await buildDeloraCalls([mockTokenUSDC, mockTokenUSDT], mockTokenUSDC);

      expect(calls).toEqual([
        // Approve USDC
        {
          data: expect.stringContaining("0x095ea7b3"),
          to: mockTokenUSDC.token,
        },
        // Swap USDC
        {
          to: DELORA_ENTRYPOINT,
          data: "0xdeadbeef",
          value: 2n,
        },
        // Approve USDT
        {
          data: expect.stringContaining("0x095ea7b3"),
          to: mockTokenUSDT.token,
        },
        // Swap USDT
        {
          to: DELORA_ENTRYPOINT,
          data: "0xdeadbeef",
          value: 2n,
        },
      ]);
    });

    test("always fetches fresh quotes, even when planning cached the same input", async () => {
      const fetchMock = stubQuoteFetch();
      const outputToken = {
        token: mockTokenUSDC.token,
        chainId: mockTokenUSDC.chainId,
        symbol: mockTokenUSDC.symbol,
        decimals: mockTokenUSDC.decimals,
        walletAddress: mockTokenNative.walletAddress,
      };

      // Planning caches this exact request...
      await getSwapQuote(mockTokenNative, outputToken);
      // ...but execution must send fresh calldata, never a cached quote.
      await buildDeloraCalls([mockTokenNative], mockTokenUSDC);

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    test("skips approval for native token (zero address)", async () => {
      const { calls } = await buildDeloraCalls([mockTokenNative], mockTokenUSDC);

      // Only the swap call — natives don't need approval
      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual({
        to: DELORA_ENTRYPOINT,
        data: "0xdeadbeef",
        value: 2n,
      });
    });

    test("skips tokens with zero amount entirely", async () => {
      const zeroAmountToken = { ...mockTokenUSDC, amount: 0n };
      const { calls } = await buildDeloraCalls([zeroAmountToken, mockTokenUSDT], mockTokenUSDC);

      // Only USDT's approval + swap; no quote is even requested for the
      // zero-amount token.
      expect(calls).toHaveLength(2);
      expect(calls[0].to).toBe(mockTokenUSDT.token);
      expect(calls[1].to).toBe(DELORA_ENTRYPOINT);
    });

    test("merges same-address inputs into a single approve+swap pair", async () => {
      const duplicateToken = { ...mockTokenUSDC };
      const { calls } = await buildDeloraCalls([mockTokenUSDC, duplicateToken], mockTokenUSDT);

      expect(calls).toHaveLength(2);
      expect(calls[0].to).toBe(mockTokenUSDC.token); // one approval
      expect(calls[1].to).toBe(DELORA_ENTRYPOINT); // one swap
    });

    test("prefers approvalAddress over calldata.to as the approval spender", async () => {
      const spender = "0x00000000000000000000000000000000000005e0" as Address;
      stubQuoteFetch({ approvalAddress: spender });

      const { calls } = await buildDeloraCalls([mockTokenUSDC], mockTokenUSDT);

      expect(calls).toHaveLength(2);
      // The approval call encodes the spender in its calldata.
      expect(calls[0].to).toBe(mockTokenUSDC.token);
      expect(calls[0].data).toContain(spender.slice(2).toLowerCase());
      expect(calls[1].to).toBe(DELORA_ENTRYPOINT);
    });

    test("falls back to calldata.to as spender when approvalAddress is missing", async () => {
      stubQuoteFetch({ approvalAddress: undefined });

      const { calls } = await buildDeloraCalls([mockTokenUSDC], mockTokenUSDT);

      expect(calls).toHaveLength(2);
      expect(calls[0].data).toContain(DELORA_ENTRYPOINT.slice(2).toLowerCase());
    });

    test("throws error when fetch fails", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({
          ok: false,
          status: 500,
          text: async () => "Internal Server Error",
        })),
      );

      await expect(buildDeloraCalls([mockTokenUSDC], mockTokenUSDT)).rejects.toThrow(
        "Request failed (500): Internal Server Error",
      );
    });

    test("surfaces Delora's error code and message from a JSON error body", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({
          ok: false,
          status: 500,
          text: async () => JSON.stringify({ code: "UNKNOWN", message: "No adapters available for this request" }),
        })),
      );

      await expect(buildDeloraCalls([mockTokenUSDC], mockTokenUSDT)).rejects.toThrow(
        "Request failed (500): UNKNOWN: No adapters available for this request",
      );
    });

    test("sums each quote's minOutputAmount across input tokens", async () => {
      // Two distinct input tokens -> two quotes, each with minOutputAmount
      // 2985000 (see makeQuoteResponse) -> combined delivery floor.
      const { minOutputAmount } = await buildDeloraCalls([mockTokenUSDC, mockTokenUSDT], mockTokenUSDC);

      expect(minOutputAmount).toBe(2n * 2985000n);
    });

    test("treats a quote without minOutputAmount as contributing zero to the floor", async () => {
      stubQuoteFetch({ minOutputAmount: undefined });

      const { calls, minOutputAmount } = await buildDeloraCalls([mockTokenUSDC], mockTokenUSDT);

      expect(calls).toHaveLength(2); // approval + swap still built
      expect(minOutputAmount).toBe(0n);
    });

    test("skips approval when sufficient allowance already exists", async () => {
      // Sufficient allowance for USDC, none for USDT
      mockPublicClient.readContract
        .mockResolvedValueOnce(mockTokenUSDC.amount) // USDC allowance check
        .mockResolvedValueOnce(0n); // USDT allowance check

      const { calls } = await buildDeloraCalls([mockTokenUSDC, mockTokenUSDT], mockTokenUSDC);

      // USDC: swap only; USDT: approve + swap
      expect(calls).toHaveLength(3);
      expect(calls[0].to).toBe(DELORA_ENTRYPOINT); // USDC swap, no approval
      expect(calls[1].to).toBe(mockTokenUSDT.token); // USDT approval
      expect(calls[2].to).toBe(DELORA_ENTRYPOINT); // USDT swap
      expect(mockPublicClient.readContract).toHaveBeenCalledTimes(2);
    });
  });

  describe("getSwapQuote", () => {
    beforeEach(() => {
      stubQuoteFetch();
    });

    afterEach(() => {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      vi.resetAllMocks();
    });

    test("returns quote for single input token", async () => {
      const outputToken = {
        token: mockTokenUSDT.token,
        chainId: mockTokenUSDT.chainId,
        symbol: mockTokenUSDT.symbol,
        decimals: mockTokenUSDT.decimals,
        walletAddress: mockTokenUSDC.walletAddress,
      };

      const result = await getSwapQuote(mockTokenUSDC, outputToken);

      expect(result).toEqual({
        ...outputToken,
        amount: 3000000n, // outputAmount is already net of all fees
      });
    });

    test("sums per-token quotes for an array of different input tokens", async () => {
      const fetchMock = stubQuoteFetch();
      const outputToken = {
        token: "0x0000000000000000000000000000000000000007" as Address,
        chainId: mockTokenUSDC.chainId,
        symbol: "DAI",
        decimals: 18,
        walletAddress: mockTokenUSDC.walletAddress,
      };

      const result = await getSwapQuote([mockTokenUSDC, mockTokenUSDT], outputToken);

      // Two distinct token addresses -> two quote requests, outputs summed.
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result.amount).toBe(6000000n);
    });

    test("reuses the cached quote for identical inputs within the TTL", async () => {
      const fetchMock = stubQuoteFetch();
      const outputToken = {
        token: mockTokenUSDT.token,
        chainId: mockTokenUSDT.chainId,
        symbol: mockTokenUSDT.symbol,
        decimals: mockTokenUSDT.decimals,
        walletAddress: mockTokenUSDC.walletAddress,
      };

      const first = await getSwapQuote(mockTokenUSDC, outputToken);
      const second = await getSwapQuote(mockTokenUSDC, outputToken);

      // A retried plan re-quotes the same tokens — only one request goes out.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(second).toEqual(first);
    });

    test("a different amount misses the cache", async () => {
      const fetchMock = stubQuoteFetch();
      const outputToken = {
        token: mockTokenUSDT.token,
        chainId: mockTokenUSDT.chainId,
        symbol: mockTokenUSDT.symbol,
        decimals: mockTokenUSDT.decimals,
        walletAddress: mockTokenUSDC.walletAddress,
      };

      await getSwapQuote(mockTokenUSDC, outputToken);
      await getSwapQuote({ ...mockTokenUSDC, amount: mockTokenUSDC.amount + 1n }, outputToken);

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    test("failed quotes are not cached — the retry refetches", async () => {
      const failing = vi.fn(async () => ({
        ok: false,
        status: 500,
        json: async () => ({}),
        text: async () => JSON.stringify({ code: "UNKNOWN", message: "server error" }),
      }));
      vi.stubGlobal("fetch", failing);
      const outputToken = {
        token: mockTokenUSDT.token,
        chainId: mockTokenUSDT.chainId,
        symbol: mockTokenUSDT.symbol,
        decimals: mockTokenUSDT.decimals,
        walletAddress: mockTokenUSDC.walletAddress,
      };

      await expect(getSwapQuote(mockTokenUSDC, outputToken)).rejects.toThrow();

      const fetchMock = stubQuoteFetch();
      const result = await getSwapQuote(mockTokenUSDC, outputToken);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result.amount).toBe(3000000n);
    });

    test("sends the expected query parameters", async () => {
      const fetchMock = stubQuoteFetch();
      const outputToken = {
        token: mockTokenUSDT.token,
        chainId: mockTokenUSDT.chainId,
        symbol: mockTokenUSDT.symbol,
        decimals: mockTokenUSDT.decimals,
        walletAddress: mockTokenUSDC.walletAddress,
      };

      await getSwapQuote(mockTokenUSDC, outputToken);

      const params = quoteParams(fetchMock);
      expect(params.get("senderAddress")).toBe(mockTokenUSDC.walletAddress);
      expect(params.get("originChainId")).toBe("1");
      expect(params.get("destinationChainId")).toBe("1");
      expect(params.get("amount")).toBe("1000000");
      expect(params.get("originCurrency")).toBe(mockTokenUSDC.token);
      expect(params.get("destinationCurrency")).toBe(mockTokenUSDT.token);
      expect(params.get("slippage")).toBe("0.005");
      // Integrator fee params ride along on every monetizable quote.
      expect(params.get("integrator")).toBeTruthy();
      expect(params.get("fee")).toBe("0.001");
    });

    test("sends x-api-key header only when VITE_DELORA_API_KEY is set", async () => {
      const fetchMock = stubQuoteFetch();
      const outputToken = {
        token: mockTokenUSDT.token,
        chainId: mockTokenUSDT.chainId,
        symbol: mockTokenUSDT.symbol,
        decimals: mockTokenUSDT.decimals,
        walletAddress: mockTokenUSDC.walletAddress,
      };

      vi.stubEnv("VITE_DELORA_API_KEY", "");
      await getSwapQuote(mockTokenUSDC, outputToken);
      let headers = fetchMock.mock.calls[0][1]?.headers as Record<string, string>;
      expect(headers["x-api-key"]).toBeUndefined();

      vi.stubEnv("VITE_DELORA_API_KEY", "test-key");
      // Same inputs would hit the planning cache; the header isn't part of
      // the cache key, so clear it to force a second real request.
      clearSwapQuoteCache();
      await getSwapQuote(mockTokenUSDC, outputToken);
      headers = fetchMock.mock.calls[1][1]?.headers as Record<string, string>;
      expect(headers["x-api-key"]).toBe("test-key");
    });

    test("handles quote with zero outputAmount", async () => {
      stubQuoteFetch({ outputAmount: "0" });

      const outputToken = {
        token: mockTokenUSDT.token,
        chainId: mockTokenUSDT.chainId,
        symbol: mockTokenUSDT.symbol,
        decimals: mockTokenUSDT.decimals,
        walletAddress: mockTokenUSDC.walletAddress,
      };

      const result = await getSwapQuote(mockTokenUSDC, outputToken);

      expect(result.amount).toBe(0n);
    });

    test("throws error when input and output tokens are on different chains", async () => {
      const outputTokenDifferentChain = {
        token: mockTokenUSDT.token,
        chainId: 137, // Polygon
        symbol: mockTokenUSDT.symbol,
        decimals: mockTokenUSDT.decimals,
        walletAddress: mockTokenUSDC.walletAddress,
      };

      await expect(getSwapQuote(mockTokenUSDC, outputTokenDifferentChain)).rejects.toThrow(
        "Input and output token must be on the same chain",
      );
    });

    test("throws error when input tokens are from different wallets", async () => {
      const tokenFromDifferentWallet = {
        ...mockTokenUSDT,
        walletAddress: "0x0000000000000000000000000000000000000005" as `0x${string}`,
      };

      const outputToken = {
        token: mockTokenUSDT.token,
        chainId: mockTokenUSDT.chainId,
        symbol: mockTokenUSDT.symbol,
        decimals: mockTokenUSDT.decimals,
        walletAddress: mockTokenUSDC.walletAddress,
      };

      await expect(getSwapQuote([mockTokenUSDC, tokenFromDifferentWallet], outputToken)).rejects.toThrow(
        "All input tokens must be from the same wallet",
      );
    });

    test("dedupes same-address inputs into one request, summing amounts", async () => {
      // After a CCTP claim on the destination chain, `step.inputTokens` may
      // legitimately carry two TokenAmount entries for the same token
      // (pre-existing USDC + claim output USDC) with different `provenance`.
      // Those must collapse into a single quote whose amount is the sum.
      const fetchMock = stubQuoteFetch();

      const outputToken = {
        token: mockTokenUSDT.token,
        chainId: mockTokenUSDC.chainId,
        symbol: mockTokenUSDT.symbol,
        decimals: mockTokenUSDT.decimals,
        walletAddress: mockTokenUSDC.walletAddress,
      };

      const usdcExisting = makeToken(USDC_TOKEN, 139412n, mockTokenUSDC.chainId, {
        walletAddress: mockTokenUSDC.walletAddress,
      });
      const usdcFromClaim = makeToken(USDC_TOKEN, 5979743n, mockTokenUSDC.chainId, {
        walletAddress: mockTokenUSDC.walletAddress,
        provenance: "step-claim",
      });

      await getSwapQuote([usdcExisting, usdcFromClaim], outputToken);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(quoteParams(fetchMock).get("amount")).toBe((139412n + 5979743n).toString());
    });

    test("dedupe is case-insensitive on token address (mixed-case inputs collapse)", async () => {
      // Polygon USDC (`0x3c499c…`) — same address with different casings.
      // EIP-55 checksum case differences from upstream sources must NOT
      // create separate quotes.
      const fetchMock = stubQuoteFetch();

      const outputToken = {
        token: mockTokenUSDT.token,
        chainId: mockTokenUSDC.chainId,
        symbol: mockTokenUSDT.symbol,
        decimals: mockTokenUSDT.decimals,
        walletAddress: mockTokenUSDC.walletAddress,
      };

      const lower = makeToken("0x3c499c542cef5e3811e1192ce70d8cc03d5c3359" as Address, 100n, mockTokenUSDC.chainId, {
        walletAddress: mockTokenUSDC.walletAddress,
      });
      const checksum = makeToken("0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359" as Address, 200n, mockTokenUSDC.chainId, {
        walletAddress: mockTokenUSDC.walletAddress,
        provenance: "step-claim",
      });

      await getSwapQuote([lower, checksum], outputToken);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(quoteParams(fetchMock).get("amount")).toBe("300");
    });

    test("wraps API errors with ExternalAPIError", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({
          ok: false,
          status: 500,
          text: async () => "Internal Server Error",
        })),
      );

      const outputToken = {
        token: mockTokenUSDT.token,
        chainId: mockTokenUSDT.chainId,
        symbol: mockTokenUSDT.symbol,
        decimals: mockTokenUSDT.decimals,
        walletAddress: mockTokenUSDC.walletAddress,
      };

      await expect(getSwapQuote(mockTokenUSDC, outputToken)).rejects.toThrow("ExternalAPIError:");
    });

    test("keeps Delora's no-route message visible through the ExternalAPIError wrapper", async () => {
      // planning.ts's isUnroutableTokenError matches on this text; it must
      // survive the wrapping.
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({
          ok: false,
          status: 500,
          text: async () => JSON.stringify({ code: "UNKNOWN", message: "No adapters available for this request" }),
        })),
      );

      const outputToken = {
        token: mockTokenUSDT.token,
        chainId: mockTokenUSDT.chainId,
        symbol: mockTokenUSDT.symbol,
        decimals: mockTokenUSDT.decimals,
        walletAddress: mockTokenUSDC.walletAddress,
      };

      await expect(getSwapQuote(mockTokenUSDC, outputToken)).rejects.toThrow(
        /ExternalAPIError:.*No adapters available/,
      );
    });

    test("throws RateLimitError (not ExternalAPIError) on HTTP 429 so plans don't auto-retry", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({
          ok: false,
          status: 429,
          text: async () => JSON.stringify({ code: "RATE_LIMIT", message: "Too many requests" }),
        })),
      );

      const outputToken = {
        token: mockTokenUSDT.token,
        chainId: mockTokenUSDT.chainId,
        symbol: mockTokenUSDT.symbol,
        decimals: mockTokenUSDT.decimals,
        walletAddress: mockTokenUSDC.walletAddress,
      };

      const promise = getSwapQuote(mockTokenUSDC, outputToken);
      await expect(promise).rejects.toThrow("RateLimitError:");
      await expect(promise).rejects.not.toThrow("ExternalAPIError:");
    });
  });

  describe("executeDeloraSwap", () => {
    let mockPublicClient: { readContract: Mock; simulateCalls: Mock };

    beforeEach(async () => {
      const { getPublicClient } = await import("./public-client");
      mockPublicClient = {
        readContract: vi.fn().mockResolvedValue(0n), // Default: no allowance
        // Default: RPC without eth_simulateV1 support — the pre-flight
        // delivery check fails open, leaving these tests to exercise the
        // send path undisturbed. The dedicated pre-flight describe below
        // overrides this with real simulation results.
        simulateCalls: vi.fn().mockRejectedValue(new Error("the method eth_simulateV1 does not exist")),
      };
      vi.mocked(getPublicClient).mockReturnValue(mockPublicClient as Partial<PublicClient> as PublicClient);

      stubQuoteFetch({ calldata: { to: DELORA_ENTRYPOINT, data: "0xdeadbeef", value: "0x0" } });
    });

    afterEach(() => {
      vi.unstubAllGlobals();
      vi.clearAllMocks();
    });

    test("executes swap and derives amount from ERC20 Transfer events", async () => {
      const transferAbi = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]);

      const transferTopics = encodeEventTopics({
        abi: transferAbi,
        eventName: "Transfer",
        args: { from: "0x000000000000000000000000000000000000dead" as Address, to: mockTokenUSDC.walletAddress },
      });
      const transferData = encodeAbiParameters(parseAbiParameters("uint256"), [2950000n]);

      // A second Transfer to the same user (e.g. final hop payout) — should sum.
      const transferTopics2 = encodeEventTopics({
        abi: transferAbi,
        eventName: "Transfer",
        args: { from: "0x000000000000000000000000000000000000beef" as Address, to: mockTokenUSDC.walletAddress },
      });
      const transferData2 = encodeAbiParameters(parseAbiParameters("uint256"), [50000n]);

      // A Transfer for a DIFFERENT token / DIFFERENT recipient — must be ignored.
      const irrelevantTopics = encodeEventTopics({
        abi: transferAbi,
        eventName: "Transfer",
        args: {
          from: mockTokenUSDC.walletAddress,
          to: "0x000000000000000000000000000000000000feed" as Address,
        },
      });
      const irrelevantData = encodeAbiParameters(parseAbiParameters("uint256"), [9_999_999n]);

      const mockSendCalls = vi.fn(async () => [
        "0xtxhash" as Hex,
        [
          [
            {
              address: mockTokenUSDT.token,
              topics: transferTopics as Hex[],
              data: transferData,
            } as Log,
            {
              address: mockTokenUSDT.token,
              topics: transferTopics2 as Hex[],
              data: transferData2,
            } as Log,
            {
              address: mockTokenUSDC.token, // wrong output token -> ignored
              topics: irrelevantTopics as Hex[],
              data: irrelevantData,
            } as Log,
          ],
        ],
      ]) as unknown as SendCallsFn;

      const result = await executeDeloraSwap([mockTokenUSDC], mockTokenUSDT, mockSendCalls);

      // 2950000 + 50000 = 3000000 — both Transfers to the user for USDT.
      expect(result.amount).toBe(3000000n);
      expect(result.transactionHash).toBe("0xtxhash");
      expect(mockSendCalls).toHaveBeenCalledWith(
        "swap",
        mockTokenUSDC.chainId,
        mockTokenUSDC.walletAddress,
        expect.any(Array),
        "atomic-steps",
        undefined,
      );
    });

    test("passes retry hints through to sendCalls", async () => {
      const mockSendCalls = vi.fn(async () => ["0xtxhash" as Hex, [[]]]) as unknown as SendCallsFn;
      const retryHints = { nonce: 7 } as unknown as Parameters<typeof executeDeloraSwap>[3];

      await executeDeloraSwap([mockTokenUSDC], mockTokenUSDT, mockSendCalls, retryHints);

      expect(mockSendCalls).toHaveBeenCalledWith(
        "swap",
        mockTokenUSDC.chainId,
        mockTokenUSDC.walletAddress,
        expect.any(Array),
        "atomic-steps",
        retryHints,
      );
    });

    test("throws error when tokens are from different chains", async () => {
      const tokenOnDifferentChain = { ...mockTokenUSDC, chainId: 137 };

      await expect(
        executeDeloraSwap([mockTokenUSDC, tokenOnDifferentChain], mockTokenUSDT, vi.fn() as unknown as SendCallsFn),
      ).rejects.toThrow("Tokens are not on the same chain or do not come from the same wallet");
    });

    test("throws error when tokens are from different wallets", async () => {
      const tokenFromDifferentWallet = {
        ...mockTokenUSDT,
        walletAddress: "0x0000000000000000000000000000000000000005" as `0x${string}`,
      };

      await expect(
        executeDeloraSwap([mockTokenUSDC, tokenFromDifferentWallet], mockTokenUSDT, vi.fn() as unknown as SendCallsFn),
      ).rejects.toThrow("Tokens are not on the same chain or do not come from the same wallet");
    });

    test("throws error when output token is on different chain", async () => {
      const outputOnDifferentChain = { ...mockTokenUSDT, chainId: 137 };

      await expect(
        executeDeloraSwap([mockTokenUSDC], outputOnDifferentChain, vi.fn() as unknown as SendCallsFn),
      ).rejects.toThrow("Swap destination chain must be the same as the source chain");
    });

    test("marks swap valid with quoted amount when no Transfer events are present (flaky RPC)", async () => {
      // The tx succeeded on chain (sendCalls returned with a tx hash) but the
      // receipt's logs came back empty — sometimes RPCs strip logs under load.
      // We must NOT throw: the swap actually executed; return the most recent
      // quoted amount so the step is marked success. This is also the path
      // for native-token output, which emits no ERC20 Transfer.
      const mockSendCalls = vi.fn(async () => ["0xtxhash" as Hex, [[]]]) as unknown as SendCallsFn;

      const result = await executeDeloraSwap([mockTokenUSDC], mockTokenUSDT, mockSendCalls);

      // mockTokenUSDT.amount === 2000000n (the quote pre-call)
      expect(result.amount).toBe(2000000n);
      expect(result.transactionHash).toBe("0xtxhash");
    });
  });

  describe("pre-flight delivery simulation", () => {
    let mockPublicClient: { readContract: Mock; simulateCalls: Mock };
    let mockSendCalls: SendCallsFn;

    beforeEach(async () => {
      const { getPublicClient } = await import("./public-client");
      mockPublicClient = {
        readContract: vi.fn().mockResolvedValue(0n), // No allowance -> approval + swap per input
        simulateCalls: vi.fn(),
      };
      vi.mocked(getPublicClient).mockReturnValue(mockPublicClient as Partial<PublicClient> as PublicClient);

      mockSendCalls = vi.fn(async () => ["0xtxhash" as Hex, [[]]]) as unknown as SendCallsFn;

      // Quote floor from makeQuoteResponse: minOutputAmount 2985000 per input.
      stubQuoteFetch();
    });

    afterEach(() => {
      vi.unstubAllGlobals();
      vi.clearAllMocks();
    });

    test("sends the swap when simulated delivery meets the quoted minimum", async () => {
      mockPublicClient.simulateCalls.mockResolvedValue({
        assetChanges: [],
        results: [
          makeSimResult(), // approval
          makeSimResult([makeTransferLog(mockTokenUSDT.token, WALLET, 3000000n)]), // swap
        ],
      });

      const result = await executeDeloraSwap([mockTokenUSDC], mockTokenUSDT, mockSendCalls);

      expect(mockPublicClient.simulateCalls).toHaveBeenCalledWith(
        expect.objectContaining({ account: WALLET, calls: expect.any(Array) }),
      );
      expect(mockSendCalls).toHaveBeenCalledTimes(1);
      expect(result.transactionHash).toBe("0xtxhash");
    });

    test("sums simulated delivery across multiple input swaps against the combined floor", async () => {
      // Two input tokens -> two quotes -> combined floor 2 × 2985000. The two
      // simulated swaps together deliver 5990000, which meets it even though
      // each individual transfer is below the combined floor.
      const outputToken = makeToken("0x0000000000000000000000000000000000000007" as Address, 0n, 1, {
        walletAddress: WALLET,
        symbol: "DAI",
      });
      mockPublicClient.simulateCalls.mockResolvedValue({
        assetChanges: [],
        results: [
          makeSimResult(),
          makeSimResult([makeTransferLog(outputToken.token, WALLET, 3000000n)]),
          makeSimResult(),
          makeSimResult([makeTransferLog(outputToken.token, WALLET, 2990000n)]),
        ],
      });

      await executeDeloraSwap([mockTokenUSDC, mockTokenUSDT], outputToken, mockSendCalls);

      expect(mockSendCalls).toHaveBeenCalledTimes(1);
    });

    test("aborts before the wallet prompt when simulated delivery is below the quoted minimum", async () => {
      mockPublicClient.simulateCalls.mockResolvedValue({
        assetChanges: [],
        results: [makeSimResult(), makeSimResult([makeTransferLog(mockTokenUSDT.token, WALLET, 2000000n)])],
      });

      await expect(executeDeloraSwap([mockTokenUSDC], mockTokenUSDT, mockSendCalls)).rejects.toThrow(
        /below the quoted minimum/,
      );
      expect(mockSendCalls).not.toHaveBeenCalled();
    });

    test("does not count simulated transfers to other recipients or of other tokens", async () => {
      const otherWallet = "0x000000000000000000000000000000000000feed" as Address;
      mockPublicClient.simulateCalls.mockResolvedValue({
        assetChanges: [],
        results: [
          makeSimResult(),
          makeSimResult([
            // Right token, wrong recipient — the fraud case this check exists for.
            makeTransferLog(mockTokenUSDT.token, otherWallet, 5000000n),
            // Right recipient, wrong token.
            makeTransferLog(mockTokenUSDC.token, WALLET, 5000000n),
          ]),
        ],
      });

      await expect(executeDeloraSwap([mockTokenUSDC], mockTokenUSDT, mockSendCalls)).rejects.toThrow(
        /below the quoted minimum/,
      );
      expect(mockSendCalls).not.toHaveBeenCalled();
    });

    test("aborts when any simulated call reverts", async () => {
      mockPublicClient.simulateCalls.mockResolvedValue({
        assetChanges: [],
        results: [
          makeSimResult(),
          { status: "failure" as const, error: new Error("SlippageExceeded"), data: "0x" as Hex, gasUsed: 0n },
        ],
      });

      await expect(executeDeloraSwap([mockTokenUSDC], mockTokenUSDT, mockSendCalls)).rejects.toThrow(
        "Swap simulation reverted: SlippageExceeded",
      );
      expect(mockSendCalls).not.toHaveBeenCalled();
    });

    test("fails open when the RPC lacks eth_simulateV1 support", async () => {
      mockPublicClient.simulateCalls.mockRejectedValue(new Error("the method eth_simulateV1 does not exist"));

      const result = await executeDeloraSwap([mockTokenUSDC], mockTokenUSDT, mockSendCalls);

      expect(mockSendCalls).toHaveBeenCalledTimes(1);
      expect(result.transactionHash).toBe("0xtxhash");
    });

    test("verifies native-token output via traceAssetChanges instead of Transfer logs", async () => {
      mockPublicClient.simulateCalls.mockResolvedValue({
        // viem reports the native delta under its ETH placeholder address.
        assetChanges: [
          {
            token: { address: ethAddress, decimals: 18, symbol: "ETH" },
            value: { pre: 0n, post: 3000000n, diff: 3000000n },
          },
        ],
        results: [makeSimResult(), makeSimResult()],
      });

      await executeDeloraSwap([mockTokenUSDC], mockTokenNative, mockSendCalls);

      expect(mockPublicClient.simulateCalls).toHaveBeenCalledWith(expect.objectContaining({ traceAssetChanges: true }));
      expect(mockSendCalls).toHaveBeenCalledTimes(1);
    });

    test("aborts a native-output swap when the simulated native delta is below the minimum", async () => {
      mockPublicClient.simulateCalls.mockResolvedValue({
        assetChanges: [
          {
            token: { address: ethAddress, decimals: 18, symbol: "ETH" },
            value: { pre: 0n, post: 1000000n, diff: 1000000n },
          },
        ],
        results: [makeSimResult(), makeSimResult()],
      });

      await expect(executeDeloraSwap([mockTokenUSDC], mockTokenNative, mockSendCalls)).rejects.toThrow(
        /below the quoted minimum/,
      );
      expect(mockSendCalls).not.toHaveBeenCalled();
    });

    test("fails open on native output when the simulation returns no native balance delta", async () => {
      // Balance probes failed inside simulateCalls -> no ETH entry. Delivery
      // can't be judged, so proceed and rely on the on-chain floor.
      mockPublicClient.simulateCalls.mockResolvedValue({
        assetChanges: [],
        results: [makeSimResult(), makeSimResult()],
      });

      await executeDeloraSwap([mockTokenUSDC], mockTokenNative, mockSendCalls);

      expect(mockSendCalls).toHaveBeenCalledTimes(1);
    });
  });

  describe("getCrossChainSwapQuoteWithLegs", () => {
    const RECEIVER = "0x0000000000000000000000000000000000000909" as Address;
    const outputOnPolygon = {
      token: mockTokenUSDT.token,
      chainId: 137,
      symbol: mockTokenUSDT.symbol,
      decimals: mockTokenUSDT.decimals,
      walletAddress: RECEIVER,
    };

    afterEach(() => {
      vi.unstubAllGlobals();
      vi.clearAllMocks();
    });

    test("quotes with the destination chain and receiver, returning output and floor", async () => {
      const fetchMock = stubQuoteFetch();

      const { output, legs, minOutputAmount } = await getCrossChainSwapQuoteWithLegs(
        mockTokenUSDC,
        outputOnPolygon,
        RECEIVER,
      );

      const params = quoteParams(fetchMock);
      expect(params.get("originChainId")).toBe("1");
      expect(params.get("destinationChainId")).toBe("137");
      expect(params.get("receiverAddress")).toBe(RECEIVER);
      expect(output.amount).toBe(3000000n);
      expect(output.chainId).toBe(137);
      expect(minOutputAmount).toBe(2985000n);
      expect(legs).toHaveLength(1);
    });

    test("sums outputs and floors across input tokens", async () => {
      stubQuoteFetch();

      const { output, minOutputAmount } = await getCrossChainSwapQuoteWithLegs(
        [mockTokenUSDC, mockTokenUSDT],
        { ...outputOnPolygon, token: "0x0000000000000000000000000000000000000007" as Address },
        RECEIVER,
      );

      expect(output.amount).toBe(6000000n);
      expect(minOutputAmount).toBe(2n * 2985000n);
    });

    test("caches like the planning path — identical inputs issue one request", async () => {
      const fetchMock = stubQuoteFetch();

      await getCrossChainSwapQuoteWithLegs(mockTokenUSDC, outputOnPolygon, RECEIVER);
      await getCrossChainSwapQuoteWithLegs(mockTokenUSDC, outputOnPolygon, RECEIVER);

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    test("rejects same-chain requests", async () => {
      stubQuoteFetch();

      await expect(
        getCrossChainSwapQuoteWithLegs(mockTokenUSDC, { ...outputOnPolygon, chainId: 1 }, RECEIVER),
      ).rejects.toThrow("Cross-chain swap requires different origin and destination chains");
    });

    test("wraps API errors with ExternalAPIError", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({
          ok: false,
          status: 500,
          text: async () => "Internal Server Error",
        })),
      );

      await expect(getCrossChainSwapQuoteWithLegs(mockTokenUSDC, outputOnPolygon, RECEIVER)).rejects.toThrow(
        "ExternalAPIError:",
      );
    });
  });

  describe("executeDeloraCrossChainSwap", () => {
    const RECEIVER = "0x0000000000000000000000000000000000000909" as Address;
    const outputOnPolygon = makeToken(USDT_TOKEN, 0n, 137, { walletAddress: RECEIVER, symbol: "USDT" });
    let mockPublicClient: { readContract: Mock; simulateCalls: Mock };
    let mockSendCalls: SendCallsFn;

    beforeEach(async () => {
      const { getPublicClient } = await import("./public-client");
      mockPublicClient = {
        readContract: vi.fn().mockResolvedValue(0n), // Default: no allowance
        simulateCalls: vi.fn().mockRejectedValue(new Error("the method eth_simulateV1 does not exist")),
      };
      vi.mocked(getPublicClient).mockReturnValue(mockPublicClient as Partial<PublicClient> as PublicClient);
      mockSendCalls = vi.fn(async () => ["0xtxhash" as Hex, [[]]]) as unknown as SendCallsFn;
      stubQuoteFetch();
    });

    afterEach(() => {
      vi.unstubAllGlobals();
      vi.clearAllMocks();
    });

    test("sends fresh receiver-tagged quotes and returns the quoted amounts", async () => {
      const fetchMock = stubQuoteFetch();

      const result = await executeDeloraCrossChainSwap([mockTokenUSDC], outputOnPolygon, RECEIVER, mockSendCalls);

      const params = quoteParams(fetchMock);
      expect(params.get("destinationChainId")).toBe("137");
      expect(params.get("receiverAddress")).toBe(RECEIVER);
      expect(result.expectedAmount).toBe(3000000n);
      expect(result.minDeliveredAmount).toBe(2985000n);
      expect(result.transactionHash).toBe("0xtxhash");
      expect(mockSendCalls).toHaveBeenCalledWith(
        "crosschain-swap",
        mockTokenUSDC.chainId,
        mockTokenUSDC.walletAddress,
        expect.any(Array),
        "atomic-steps",
        undefined,
      );
    });

    test("throws when the destination chain equals the source chain", async () => {
      await expect(
        executeDeloraCrossChainSwap([mockTokenUSDC], { ...outputOnPolygon, chainId: 1 }, RECEIVER, mockSendCalls),
      ).rejects.toThrow("Cross-chain swap destination chain must differ from the source chain");
      expect(mockSendCalls).not.toHaveBeenCalled();
    });

    test("pre-flight simulation is revert-check only — no delivery assertion cross-chain", async () => {
      // A same-chain swap simulating zero Transfer logs to the wallet would
      // abort "below the quoted minimum". Cross-chain, the output lands later
      // on another chain, so a successful simulation with no local delivery
      // must still send.
      mockPublicClient.simulateCalls.mockResolvedValue({
        results: [makeSimResult(), makeSimResult()],
      });

      const result = await executeDeloraCrossChainSwap([mockTokenUSDC], outputOnPolygon, RECEIVER, mockSendCalls);

      expect(mockSendCalls).toHaveBeenCalledTimes(1);
      expect(result.transactionHash).toBe("0xtxhash");
    });

    test("still aborts when the origin-side simulation reverts", async () => {
      mockPublicClient.simulateCalls.mockResolvedValue({
        results: [
          makeSimResult(),
          { status: "failure" as const, error: new Error("SlippageExceeded"), data: "0x" as Hex, gasUsed: 0n },
        ],
      });

      await expect(
        executeDeloraCrossChainSwap([mockTokenUSDC], outputOnPolygon, RECEIVER, mockSendCalls),
      ).rejects.toThrow("Swap simulation reverted: SlippageExceeded");
      expect(mockSendCalls).not.toHaveBeenCalled();
    });

    test("fails open when the RPC lacks eth_simulateV1 support", async () => {
      // beforeEach default: simulateCalls rejects with method-not-found.
      const result = await executeDeloraCrossChainSwap([mockTokenUSDC], outputOnPolygon, RECEIVER, mockSendCalls);

      expect(mockSendCalls).toHaveBeenCalledTimes(1);
      expect(result.transactionHash).toBe("0xtxhash");
    });
  });

  describe("waitForCrossChainDelivery", () => {
    const RECEIVER = "0x0000000000000000000000000000000000000909" as Address;
    let mockPublicClient: { readContract: Mock };

    const makeRecord = (overrides?: Partial<CrossChainDeliveryRecord>): CrossChainDeliveryRecord => ({
      txHash: "0xaaa",
      fromChainId: 1,
      toChainId: 137,
      toAddress: RECEIVER,
      tokenAddress: USDT_TOKEN,
      baselineUnits: "1000",
      minDeliveredUnits: "2985000",
      expectedUnits: "3000000",
      ...overrides,
    });

    beforeEach(async () => {
      const { getPublicClient } = await import("./public-client");
      mockPublicClient = { readContract: vi.fn() };
      vi.mocked(getPublicClient).mockReturnValue(mockPublicClient as Partial<PublicClient> as PublicClient);
    });

    afterEach(() => {
      vi.clearAllMocks();
    });

    test("resolves with the measured delta once the balance crosses baseline + min", async () => {
      mockPublicClient.readContract.mockResolvedValue(1000n + 2990000n);

      const delivered = await waitForCrossChainDelivery([makeRecord()], 1_000, 5);

      expect(delivered).toBe(2990000n);
    });

    test("clamps the reported delta to the expected amount (unrelated inflows discarded)", async () => {
      mockPublicClient.readContract.mockResolvedValue(1000n + 50_000_000n);

      const delivered = await waitForCrossChainDelivery([makeRecord()], 1_000, 5);

      expect(delivered).toBe(3000000n);
    });

    test("groups records on one destination balance: earliest baseline + summed thresholds", async () => {
      // Two origin legs converge on the same (chain, receiver, token). The
      // second record's baseline (5000) already contains the first delivery,
      // so the group must measure from the EARLIEST baseline (1000) — else
      // the first delivery would be double-counted into the threshold.
      const records = [
        makeRecord({ baselineUnits: "1000", minDeliveredUnits: "100", expectedUnits: "110" }),
        makeRecord({ txHash: "0xbbb", baselineUnits: "5000", minDeliveredUnits: "200", expectedUnits: "220" }),
      ];

      // Below combined threshold (1000 + 300) on the first poll, above on the second.
      mockPublicClient.readContract.mockResolvedValueOnce(1250n).mockResolvedValue(1330n);

      const delivered = await waitForCrossChainDelivery(records, 1_000, 5);

      expect(delivered).toBe(330n);
    });

    test("keeps polling through transient RPC errors", async () => {
      mockPublicClient.readContract.mockRejectedValueOnce(new Error("rpc down")).mockResolvedValue(1000n + 2985000n);

      const delivered = await waitForCrossChainDelivery([makeRecord()], 1_000, 5);

      expect(delivered).toBe(2985000n);
    });

    test("reports progress per poll and resolves instantly on a retry after delivery", async () => {
      mockPublicClient.readContract.mockResolvedValue(1000n + 3000000n);
      const onProgress = vi.fn();

      await waitForCrossChainDelivery([makeRecord()], 1_000, 5, onProgress);

      expect(onProgress).toHaveBeenCalledWith(1, 1);
    });

    test("throws CROSSCHAIN_DELIVERY_TIMEOUT when the deadline passes", async () => {
      mockPublicClient.readContract.mockResolvedValue(1000n);

      await expect(waitForCrossChainDelivery([makeRecord()], 30, 5)).rejects.toThrow("CROSSCHAIN_DELIVERY_TIMEOUT");
    });

    test("returns zero immediately for an empty record set", async () => {
      const delivered = await waitForCrossChainDelivery([], 1_000, 5);

      expect(delivered).toBe(0n);
      expect(mockPublicClient.readContract).not.toHaveBeenCalled();
    });
  });
});
