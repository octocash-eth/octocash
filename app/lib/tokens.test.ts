import type { PublicClient } from "viem";
import { zeroAddress } from "viem";
import type { Mock } from "vitest";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { buildERC20ApprovalCalls } from "./tokens";
import type { TokenAmount } from "./types";

// Mock the public-client module
vi.mock("./public-client", () => ({
  getPublicClient: vi.fn(() => ({
    readContract: vi.fn().mockResolvedValue(0n), // Default: no allowance
  })),
}));

describe("tokens", () => {
  describe("buildERC20ApprovalCalls", () => {
    let mockPublicClient: { readContract: Mock };

    const mockTokenUSDC: TokenAmount = {
      token: "0x0000000000000000000000000000000000000001" as `0x${string}`,
      amount: 1000000n,
      chainId: 1,
      walletAddress: "0x0000000000000000000000000000000000000002" as `0x${string}`,
      symbol: "USDC",
      decimals: 6,
    };

    const mockTokenUSDT: TokenAmount = {
      token: "0x0000000000000000000000000000000000000003" as `0x${string}`,
      amount: 2000000n,
      chainId: 1,
      walletAddress: "0x0000000000000000000000000000000000000002" as `0x${string}`,
      symbol: "USDT",
      decimals: 6,
    };

    const mockTokenNative: TokenAmount = {
      token: zeroAddress,
      amount: 1000000000000000000n,
      chainId: 1,
      walletAddress: "0x0000000000000000000000000000000000000002" as `0x${string}`,
      symbol: "ETH",
      decimals: 18,
    };

    const spender = "0x0000000000000000000000000000000000000099" as `0x${string}`;

    beforeEach(async () => {
      const { getPublicClient } = await import("./public-client");
      mockPublicClient = {
        readContract: vi.fn().mockResolvedValue(0n), // Default: no allowance
      };
      vi.mocked(getPublicClient).mockReturnValue(mockPublicClient as Partial<PublicClient> as PublicClient);
    });

    afterEach(() => {
      vi.clearAllMocks();
    });

    test("builds approval call for single token", async () => {
      const calls = await buildERC20ApprovalCalls(mockTokenUSDC, spender);

      expect(calls).toHaveLength(1);
      expect(calls[0].to).toBe(mockTokenUSDC.token);
      expect(calls[0].data).toContain("0x095ea7b3"); // approve function selector
    });

    test("builds approval calls for multiple tokens", async () => {
      const calls = await buildERC20ApprovalCalls([mockTokenUSDC, mockTokenUSDT], spender);

      expect(calls).toHaveLength(2);
      expect(calls[0].to).toBe(mockTokenUSDC.token);
      expect(calls[1].to).toBe(mockTokenUSDT.token);
    });

    test("skips approval for native token (zero address)", async () => {
      const calls = await buildERC20ApprovalCalls([mockTokenNative, mockTokenUSDC], spender);

      expect(calls).toHaveLength(1);
      expect(calls[0].to).toBe(mockTokenUSDC.token);
    });

    test("skips approval for tokens with zero amount", async () => {
      const zeroAmountToken = { ...mockTokenUSDC, amount: 0n };
      const calls = await buildERC20ApprovalCalls([zeroAmountToken, mockTokenUSDT], spender);

      expect(calls).toHaveLength(1);
      expect(calls[0].to).toBe(mockTokenUSDT.token);
    });

    test("deduplicates and sums amounts for same token from same wallet", async () => {
      const token1 = { ...mockTokenUSDC, amount: 1000000n };
      const token2 = { ...mockTokenUSDC, amount: 500000n };
      const token3 = { ...mockTokenUSDC, amount: 250000n };

      const calls = await buildERC20ApprovalCalls([token1, token2, token3], spender);

      expect(calls).toHaveLength(1);
      expect(calls[0].to).toBe(mockTokenUSDC.token);
      expect(calls[0].data).toContain("0x095ea7b3"); // approve function selector

      // Verify allowance was checked once (deduplicated)
      expect(mockPublicClient.readContract).toHaveBeenCalledTimes(1);

      // Verify the approval is for the summed amount (1000000n + 500000n + 250000n = 1750000n)
      expect(mockPublicClient.readContract).toHaveBeenCalledWith({
        address: mockTokenUSDC.token,
        abi: expect.any(Array),
        functionName: "allowance",
        args: [mockTokenUSDC.walletAddress, spender],
      });
    });

    test("does not mutate original token objects", async () => {
      const token1 = { ...mockTokenUSDC, amount: 1000000n };
      const token2 = { ...mockTokenUSDC, amount: 500000n };
      const originalAmount1 = token1.amount;
      const originalAmount2 = token2.amount;

      await buildERC20ApprovalCalls([token1, token2], spender);

      // Original objects should not be mutated
      expect(token1.amount).toBe(originalAmount1);
      expect(token2.amount).toBe(originalAmount2);
    });

    test("creates separate approvals for same token from different wallets", async () => {
      const tokenFromDifferentWallet = {
        ...mockTokenUSDC,
        walletAddress: "0x0000000000000000000000000000000000000099" as `0x${string}`,
      };
      const calls = await buildERC20ApprovalCalls([mockTokenUSDC, tokenFromDifferentWallet], spender);

      // Should create two approval calls (different wallets)
      expect(calls).toHaveLength(2);
    });

    test("skips approval when sufficient allowance exists", async () => {
      mockPublicClient.readContract.mockResolvedValueOnce(mockTokenUSDC.amount); // Sufficient allowance

      const calls = await buildERC20ApprovalCalls(mockTokenUSDC, spender);

      expect(calls).toHaveLength(0);
      expect(mockPublicClient.readContract).toHaveBeenCalledTimes(1);
    });

    test("creates approval when allowance is insufficient", async () => {
      mockPublicClient.readContract.mockResolvedValueOnce(mockTokenUSDC.amount - 1n); // Insufficient allowance

      const calls = await buildERC20ApprovalCalls(mockTokenUSDC, spender);

      expect(calls).toHaveLength(1);
      expect(calls[0].to).toBe(mockTokenUSDC.token);
    });

    test("handles allowance check errors gracefully", async () => {
      mockPublicClient.readContract.mockRejectedValueOnce(new Error("RPC error"));

      const calls = await buildERC20ApprovalCalls(mockTokenUSDC, spender);

      // Should create approval call when error occurs (treats as 0 allowance)
      expect(calls).toHaveLength(1);
      expect(calls[0].to).toBe(mockTokenUSDC.token);
    });

    test("returns empty array for empty token array", async () => {
      const calls = await buildERC20ApprovalCalls([], spender);

      expect(calls).toHaveLength(0);
    });
  });
});
