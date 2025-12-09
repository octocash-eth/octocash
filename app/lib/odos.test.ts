import type { Address, Hex, Log, PublicClient } from "viem";
import {
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  parseAbi,
  parseAbiParameters,
  zeroAddress,
} from "viem";
import type { Mock } from "vitest";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ETH_ADDRESS, makeToken, WALLET } from "../../test/test-helpers";

import { buildOdosCalls, executeOdosSwap, getSwapQuote } from "./odos";
import type { TokenAmount } from "./types";

type SendCallsReturn = [Hex, Log[][]];
type SendCallsFn = Mock<(...args: unknown[]) => Promise<SendCallsReturn>>;

// Mock the public-client module
vi.mock("./public-client", () => ({
  getPublicClient: vi.fn(() => ({
    readContract: vi.fn().mockResolvedValue(0n), // Default: no allowance
  })),
}));

// Helper ABI for encoding swap function calls in tests
const odosRouterV3Abi = parseAbi([
  "function swap((address inputToken, uint256 inputAmount, address inputReceiver, address outputToken, uint256 outputQuote, uint256 outputMin, address outputReceiver) tokenInfo, bytes pathDefinition, address executor, (uint64 code, uint64 fee, address feeRecipient) referralInfo) payable returns (uint256 amountOut)",
]);

// Helper function to create valid encoded swap data for tests
function createMockSwapData(): Hex {
  return encodeFunctionData({
    abi: odosRouterV3Abi,
    functionName: "swap",
    args: [
      {
        inputToken: zeroAddress,
        inputAmount: 1000000n,
        inputReceiver: zeroAddress,
        outputToken: zeroAddress,
        outputQuote: 1000000n,
        outputMin: 950000n,
        outputReceiver: zeroAddress,
      },
      "0x00" as Hex, // pathDefinition
      zeroAddress, // executor
      {
        code: 0n,
        fee: 0n,
        feeRecipient: zeroAddress,
      },
    ],
  });
}

const USDC_TOKEN = "0x0000000000000000000000000000000000000001" as const;
const USDT_TOKEN = "0x0000000000000000000000000000000000000003" as const;

describe("odos", () => {
  const mockTokenUSDC = makeToken(USDC_TOKEN, 1000000n, 1, { walletAddress: WALLET });
  const mockTokenUSDT = makeToken(USDT_TOKEN, 2000000n, 1, { walletAddress: WALLET, symbol: "USDT" });
  const mockTokenNative = makeToken(ETH_ADDRESS, 1000000000000000000n, 1, {
    walletAddress: WALLET,
    symbol: "ETH",
    decimals: 18,
  });

  describe("buildOdosCalls", () => {
    let mockPublicClient: { readContract: Mock };

    beforeEach(async () => {
      const { getPublicClient } = await import("./public-client");
      mockPublicClient = {
        readContract: vi.fn().mockResolvedValue(0n), // Default: no allowance
      };
      vi.mocked(getPublicClient).mockReturnValue(mockPublicClient as Partial<PublicClient> as PublicClient);

      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          if (url.includes("/sor/quote")) {
            return {
              ok: true,
              status: 200,
              json: async () => ({ pathId: "test-path-id", outAmounts: ["3000000"] }),
              text: async () => "",
            } as unknown as Response;
          }
          if (url.includes("/sor/assemble")) {
            return {
              ok: true,
              status: 200,
              json: async () => ({
                transaction: {
                  to: "0x0000000000000000000000000000000000000001",
                  data: createMockSwapData(),
                  value: "0x2",
                },
              }),
              text: async () => "",
            } as unknown as Response;
          }
          return {
            ok: false,
            status: 404,
            json: async () => ({}),
            text: async () => "Not Found",
          } as unknown as Response;
        }),
      );
    });

    afterEach(() => {
      vi.unstubAllGlobals();
      vi.clearAllMocks();
    });

    test("returns the correct approve calls and swap call", async () => {
      const calls = await buildOdosCalls([mockTokenUSDC, mockTokenUSDT], mockTokenUSDC);

      expect(calls).toEqual([
        // Approve USDC
        {
          data: expect.stringContaining("0x095ea7b3"),
          to: mockTokenUSDC.token,
        },
        // Approve USDT
        {
          data: expect.stringContaining("0x095ea7b3"),
          to: mockTokenUSDT.token,
        },
        // Swap
        {
          to: "0x0000000000000000000000000000000000000001",
          data: expect.any(String),
          value: 2n,
        },
      ]);
    });

    test("skips approval for native token (zero address)", async () => {
      const calls = await buildOdosCalls([mockTokenNative, mockTokenUSDC], mockTokenUSDC);

      // Should only have one approval (for USDC) and the swap call
      expect(calls).toHaveLength(2);
      expect(calls[0].to).toBe(mockTokenUSDC.token);
      expect(calls[1]).toEqual({
        to: "0x0000000000000000000000000000000000000001",
        data: expect.any(String),
        value: 2n,
      });
    });

    test("skips approval for tokens with zero amount", async () => {
      const zeroAmountToken = { ...mockTokenUSDC, amount: 0n };
      const calls = await buildOdosCalls([zeroAmountToken, mockTokenUSDT], mockTokenUSDC);

      // Should only have one approval (for USDT) and the swap call
      expect(calls).toHaveLength(2);
      expect(calls[0].to).toBe(mockTokenUSDT.token);
    });

    test("deduplicates approval calls for same token from same wallet", async () => {
      const duplicateToken = { ...mockTokenUSDC };
      const calls = await buildOdosCalls([mockTokenUSDC, duplicateToken], mockTokenUSDT);

      // Should only have one approval for USDC and the swap call
      expect(calls).toHaveLength(2);
      expect(calls[0].to).toBe(mockTokenUSDC.token);
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

      await expect(buildOdosCalls([mockTokenUSDC], mockTokenUSDT)).rejects.toThrow(
        "Request failed (500): Internal Server Error",
      );
    });

    test("skips approval when sufficient allowance already exists", async () => {
      // Mock sufficient allowance for USDC, insufficient for USDT
      mockPublicClient.readContract
        .mockResolvedValueOnce(mockTokenUSDC.amount) // USDC has sufficient allowance
        .mockResolvedValueOnce(0n); // USDT has no allowance

      const calls = await buildOdosCalls([mockTokenUSDC, mockTokenUSDT], mockTokenUSDC);

      // Should only have one approval (for USDT) and the swap call
      expect(calls).toHaveLength(2);
      expect(calls[0].to).toBe(mockTokenUSDT.token); // Only USDT approval
      expect(calls[1]).toEqual({
        to: "0x0000000000000000000000000000000000000001",
        data: expect.any(String),
        value: 2n,
      });

      // Verify allowance was checked for both tokens
      expect(mockPublicClient.readContract).toHaveBeenCalledTimes(2);
    });

    test("skips all approvals when all tokens have sufficient allowance", async () => {
      // Mock sufficient allowance for all tokens
      mockPublicClient.readContract.mockResolvedValue(mockTokenUSDC.amount * 2n);

      const calls = await buildOdosCalls([mockTokenUSDC, mockTokenUSDT], mockTokenUSDC);

      // Should only have the swap call, no approvals
      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual({
        to: "0x0000000000000000000000000000000000000001",
        data: expect.any(String),
        value: 2n,
      });
    });
  });

  describe("getSwapQuote", () => {
    beforeEach(() => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          if (url.includes("/sor/quote")) {
            return {
              ok: true,
              status: 200,
              json: async () => ({ pathId: "test-path-id", outAmounts: ["3000000"] }),
              text: async () => "",
            } as unknown as Response;
          }
          return {
            ok: false,
            status: 404,
            json: async () => ({}),
            text: async () => "Not Found",
          } as unknown as Response;
        }),
      );
    });

    afterEach(() => {
      vi.unstubAllGlobals();
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
        amount: 2997000n, // 3000000n - 0.1% referral fee
      });
    });

    test("returns quote for array of input tokens", async () => {
      const outputToken = {
        token: mockTokenUSDT.token,
        chainId: mockTokenUSDT.chainId,
        symbol: mockTokenUSDT.symbol,
        decimals: mockTokenUSDT.decimals,
        walletAddress: mockTokenUSDC.walletAddress,
      };

      const result = await getSwapQuote([mockTokenUSDC, mockTokenUSDT], outputToken);

      expect(result).toEqual({
        ...outputToken,
        amount: 2997000n, // 3000000n - 0.1% referral fee
      });
    });

    test("handles quote with no outAmounts", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({
          ok: true,
          status: 200,
          json: async () => ({ pathId: "test-path-id" }),
          text: async () => "",
        })),
      );

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
  });

  describe("executeOdosSwap", () => {
    let mockPublicClient: { readContract: Mock };

    beforeEach(async () => {
      const { getPublicClient } = await import("./public-client");
      mockPublicClient = {
        readContract: vi.fn().mockResolvedValue(0n), // Default: no allowance
      };
      vi.mocked(getPublicClient).mockReturnValue(mockPublicClient as Partial<PublicClient> as PublicClient);

      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          if (url.includes("/sor/quote")) {
            return {
              ok: true,
              status: 200,
              json: async () => ({ pathId: "test-path-id", outAmounts: ["3000000"] }),
              text: async () => "",
            } as unknown as Response;
          }
          if (url.includes("/sor/assemble")) {
            return {
              ok: true,
              status: 200,
              json: async () => ({
                transaction: {
                  to: "0x0000000000000000000000000000000000000001",
                  data: createMockSwapData(),
                  value: "0x0",
                },
              }),
              text: async () => "",
            } as unknown as Response;
          }
          return {
            ok: false,
            status: 404,
            json: async () => ({}),
            text: async () => "Not Found",
          } as unknown as Response;
        }),
      );
    });

    afterEach(() => {
      vi.unstubAllGlobals();
      vi.clearAllMocks();
    });

    test("executes swap and returns amount from Swap event", async () => {
      const swapAbi = parseAbi([
        "event Swap(address sender, uint256 inputAmount, address inputToken, uint256 amountOut, address outputToken, int256 slippage, uint64 referralCode, uint64 referralFee, address referralFeeRecipient)",
      ]);

      const topics = encodeEventTopics({
        abi: swapAbi,
        eventName: "Swap",
      });

      // Encode event data properly
      const data = encodeAbiParameters(
        parseAbiParameters(
          "address sender, uint256 inputAmount, address inputToken, uint256 amountOut, address outputToken, int256 slippage, uint64 referralCode, uint64 referralFee, address referralFeeRecipient",
        ),
        [
          mockTokenUSDC.walletAddress, // sender
          1000000n, // inputAmount
          mockTokenUSDC.token, // inputToken
          3000000n, // amountOut - this is what we're testing for
          mockTokenUSDT.token, // outputToken
          0n, // slippage
          0n, // referralCode
          0n, // referralFee
          zeroAddress, // referralFeeRecipient
        ],
      );

      const mockSendCalls = vi.fn(async () => [
        "0xtxhash" as Hex,
        [
          [
            {
              address: "0xSwapRouter" as Address,
              topics: topics as Hex[],
              data: data,
            } as Log,
          ],
        ],
      ]) as unknown as SendCallsFn;

      const result = await executeOdosSwap([mockTokenUSDC], mockTokenUSDT, mockSendCalls);

      expect(result.amount).toBe(3000000n);
      expect(result.transactionHash).toBe("0xtxhash");
      expect(mockSendCalls).toHaveBeenCalledWith(
        "swap",
        mockTokenUSDC.chainId,
        mockTokenUSDC.walletAddress,
        expect.any(Array),
        "atomic-steps",
      );
    });

    test("executes swap and returns amount from SwapMulti event", async () => {
      const swapMultiAbi = parseAbi([
        "event SwapMulti(address sender, uint256[] amountsIn, address[] tokensIn, uint256[] amountsOut, address[] tokensOut, int256[] slippage, uint64 referralCode, uint64 referralFee, address referralFeeRecipient)",
      ]);

      const topics = encodeEventTopics({
        abi: swapMultiAbi,
        eventName: "SwapMulti",
      });

      // Create a third token (DAI) for multi-token swap
      const mockTokenDAI: TokenAmount = {
        token: "0x6B175474E89094C44Da98b954EedeAC495271d0F" as Address,
        amount: 2000000n,
        chainId: 1,
        walletAddress: mockTokenUSDC.walletAddress,
        symbol: "DAI",
        decimals: 18,
      };

      // Encode event data properly
      const data = encodeAbiParameters(
        parseAbiParameters(
          "address sender, uint256[] amountsIn, address[] tokensIn, uint256[] amountsOut, address[] tokensOut, int256[] slippage, uint64 referralCode, uint64 referralFee, address referralFeeRecipient",
        ),
        [
          mockTokenUSDC.walletAddress, // sender
          [1000000n, 2000000n], // amountsIn
          [mockTokenUSDC.token, mockTokenDAI.token], // tokensIn
          [5000000n], // amountsOut - swapping USDC+DAI to USDT
          [mockTokenUSDT.token], // tokensOut
          [0n], // slippage
          0n, // referralCode
          0n, // referralFee
          zeroAddress, // referralFeeRecipient
        ],
      );

      const mockSendCalls = vi.fn(async () => [
        "0xtxhash" as Hex,
        [
          [
            {
              address: "0xSwapRouter" as Address,
              topics: topics as Hex[],
              data: data,
            } as Log,
          ],
        ],
      ]) as unknown as SendCallsFn;

      const result = await executeOdosSwap([mockTokenUSDC, mockTokenDAI], mockTokenUSDT, mockSendCalls);

      // Should return the swap output from the event
      expect(result.amount).toBe(5000000n);
      expect(result.transactionHash).toBe("0xtxhash");
    });

    test("throws error when tokens are from different chains", async () => {
      const tokenOnDifferentChain = { ...mockTokenUSDC, chainId: 137 };

      await expect(
        executeOdosSwap([mockTokenUSDC, tokenOnDifferentChain], mockTokenUSDT, vi.fn() as unknown as SendCallsFn),
      ).rejects.toThrow("Tokens are not on the same chain or do not come from the same wallet");
    });

    test("throws error when tokens are from different wallets", async () => {
      const tokenFromDifferentWallet = {
        ...mockTokenUSDT,
        walletAddress: "0x0000000000000000000000000000000000000005" as `0x${string}`,
      };

      await expect(
        executeOdosSwap([mockTokenUSDC, tokenFromDifferentWallet], mockTokenUSDT, vi.fn() as unknown as SendCallsFn),
      ).rejects.toThrow("Tokens are not on the same chain or do not come from the same wallet");
    });

    test("throws error when output token is on different chain", async () => {
      const outputOnDifferentChain = { ...mockTokenUSDT, chainId: 137 };

      await expect(
        executeOdosSwap([mockTokenUSDC], outputOnDifferentChain, vi.fn() as unknown as SendCallsFn),
      ).rejects.toThrow("Swap destination chain must be the same as the source chain");
    });

    test("throws error when no output amount found in logs", async () => {
      const mockSendCalls = vi.fn(async () => ["0xtxhash" as Hex, [[]]]) as unknown as SendCallsFn;

      await expect(executeOdosSwap([mockTokenUSDC], mockTokenUSDT, mockSendCalls)).rejects.toThrow(
        "No output token amount found",
      );
    });
  });
});
