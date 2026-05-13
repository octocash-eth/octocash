import type { Address, PublicClient } from "viem";
import type { Mock } from "vitest";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ETH_ADDRESS, makeToken, USDC_ETHEREUM, WALLET } from "../../test/test-helpers";
import {
  buildERC20ApprovalCalls,
  consolidateTokenAmounts,
  formatFiat,
  formatTokenAmount,
  formatUsd,
  getChainName,
  getTokenIconUrl,
  getTokenId,
  groupTokensByChainAndWallet,
  isSameToken,
} from "./tokens";

// Mock the public-client module
vi.mock("./public-client", () => ({
  getPublicClient: vi.fn(() => ({
    readContract: vi.fn().mockResolvedValue(0n), // Default: no allowance
  })),
}));

const USDC_TOKEN = "0x0000000000000000000000000000000000000001" as const;
const USDT_TOKEN = "0x0000000000000000000000000000000000000003" as const;

describe("tokens", () => {
  describe("getTokenId", () => {
    test("generates unique ID from wallet, token, and chainId", () => {
      const token = makeToken(USDC_ETHEREUM, 1000000n, 1);
      const id = getTokenId(token);

      expect(id).toBe(`${WALLET}-${USDC_ETHEREUM}-1`);
    });

    test("generates different IDs for different chains", () => {
      const token1 = makeToken(USDC_ETHEREUM, 1000000n, 1);
      const token2 = makeToken(USDC_ETHEREUM, 1000000n, 10);

      expect(getTokenId(token1)).not.toBe(getTokenId(token2));
    });

    test("generates different IDs for different wallets", () => {
      const wallet2 = "0x2222222222222222222222222222222222222222" as Address;
      const token1 = makeToken(USDC_ETHEREUM, 1000000n, 1, { walletAddress: WALLET });
      const token2 = makeToken(USDC_ETHEREUM, 1000000n, 1, { walletAddress: wallet2 });

      expect(getTokenId(token1)).not.toBe(getTokenId(token2));
    });
  });

  describe("getTokenIconUrl", () => {
    test("generates correct icon URL", () => {
      const url = getTokenIconUrl(1, USDC_ETHEREUM);
      expect(url).toBe(`https://assets.octo.cash/token/1/${USDC_ETHEREUM}`);
    });

    test("works with different chain IDs", () => {
      const url = getTokenIconUrl(137, USDC_ETHEREUM);
      expect(url).toBe(`https://assets.octo.cash/token/137/${USDC_ETHEREUM}`);
    });
  });

  describe("isSameToken", () => {
    const wallet2 = "0x2222222222222222222222222222222222222222" as Address;

    test("returns true for identical tokens", () => {
      const token1 = { token: USDC_ETHEREUM, chainId: 1, walletAddress: WALLET };
      const token2 = { token: USDC_ETHEREUM, chainId: 1, walletAddress: WALLET };

      expect(isSameToken(token1, token2)).toBe(true);
    });

    test("returns false for different token addresses", () => {
      const token1 = { token: USDC_ETHEREUM, chainId: 1, walletAddress: WALLET };
      const token2 = { token: ETH_ADDRESS, chainId: 1, walletAddress: WALLET };

      expect(isSameToken(token1, token2)).toBe(false);
    });

    test("returns false for different chainIds", () => {
      const token1 = { token: USDC_ETHEREUM, chainId: 1, walletAddress: WALLET };
      const token2 = { token: USDC_ETHEREUM, chainId: 10, walletAddress: WALLET };

      expect(isSameToken(token1, token2)).toBe(false);
    });

    test("returns false for different wallet addresses", () => {
      const token1 = { token: USDC_ETHEREUM, chainId: 1, walletAddress: WALLET };
      const token2 = { token: USDC_ETHEREUM, chainId: 1, walletAddress: wallet2 };

      expect(isSameToken(token1, token2)).toBe(false);
    });

    test("returns true when wallet addresses differ but ignoreWallet is true", () => {
      const token1 = { token: USDC_ETHEREUM, chainId: 1, walletAddress: WALLET };
      const token2 = { token: USDC_ETHEREUM, chainId: 1, walletAddress: wallet2 };

      expect(isSameToken(token1, token2, true)).toBe(true);
    });

    test("handles case-insensitive address comparison", () => {
      const lowercaseAddress = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" as Address;
      const token1 = { token: USDC_ETHEREUM, chainId: 1, walletAddress: WALLET };
      const token2 = { token: lowercaseAddress, chainId: 1, walletAddress: WALLET };

      expect(isSameToken(token1, token2)).toBe(true);
    });

    test("treats undefined wallet addresses as zero address", () => {
      const token1 = { token: USDC_ETHEREUM, chainId: 1 };
      const token2 = { token: USDC_ETHEREUM, chainId: 1 };

      expect(isSameToken(token1, token2)).toBe(true);
    });

    test("returns false when one wallet is undefined and other has value", () => {
      const token1 = { token: USDC_ETHEREUM, chainId: 1 };
      const token2 = { token: USDC_ETHEREUM, chainId: 1, walletAddress: WALLET };

      expect(isSameToken(token1, token2)).toBe(false);
    });

    test("works with TokenAmount objects", () => {
      const token1 = makeToken(USDC_ETHEREUM, 100n, 1);
      const token2 = makeToken(USDC_ETHEREUM, 200n, 1);

      expect(isSameToken(token1, token2)).toBe(true);
    });

    test("ignores amount differences when comparing tokens", () => {
      const token1 = makeToken(USDC_ETHEREUM, 1000000n, 1);
      const token2 = makeToken(USDC_ETHEREUM, 9999999n, 1);

      expect(isSameToken(token1, token2)).toBe(true);
    });
  });

  describe("getChainName", () => {
    test("returns correct name for Ethereum mainnet", () => {
      expect(getChainName(1)).toBe("Ethereum");
    });

    test("returns correct name for Optimism", () => {
      expect(getChainName(10)).toBe("OP Mainnet");
    });

    test("returns correct name for Arbitrum", () => {
      expect(getChainName(42161)).toBe("Arbitrum One");
    });

    test("returns correct name for Base", () => {
      expect(getChainName(8453)).toBe("Base");
    });

    test("returns correct name for Polygon", () => {
      expect(getChainName(137)).toBe("Polygon");
    });

    test("returns fallback for unknown chain ID", () => {
      expect(getChainName(999999)).toBe("Chain-999999");
    });
  });

  describe("formatTokenAmount", () => {
    test("formats 6 decimal token correctly", () => {
      const token = makeToken(USDC_ETHEREUM, 1234567n, 1, { decimals: 6 });
      expect(formatTokenAmount(token)).toBe("1.234567");
    });

    test("formats 18 decimal token correctly", () => {
      const token = makeToken(ETH_ADDRESS, 1500000000000000000n, 1, { decimals: 18 });
      expect(formatTokenAmount(token)).toBe("1.5");
    });

    test("formats zero amount", () => {
      const token = makeToken(USDC_ETHEREUM, 0n, 1, { decimals: 6 });
      expect(formatTokenAmount(token)).toBe("0");
    });

    test("formats large amounts", () => {
      const token = makeToken(USDC_ETHEREUM, 1000000000000n, 1, { decimals: 6 });
      expect(formatTokenAmount(token)).toBe("1000000");
    });
  });

  describe("formatUsd", () => {
    test("formats positive amount with default decimals", () => {
      expect(formatUsd(1234.56)).toBe("$1,234.56");
    });

    test("formats zero", () => {
      expect(formatUsd(0)).toBe("$0.00");
    });

    test("formats with custom decimals", () => {
      expect(formatUsd(1234.5678, 4)).toBe("$1,234.5678");
    });

    test("formats large numbers with commas", () => {
      expect(formatUsd(1234567.89)).toBe("$1,234,567.89");
    });

    test("formats small amounts", () => {
      expect(formatUsd(0.01)).toBe("$0.01");
    });

    test("rounds to specified decimals", () => {
      expect(formatUsd(1.999, 2)).toBe("$2.00");
    });
  });

  describe("formatFiat", () => {
    test("defaults to USD and natural decimals for the currency", () => {
      expect(formatFiat(1234.56)).toBe("$1,234.56");
    });

    test("formats EUR with the euro symbol", () => {
      expect(formatFiat(1234.56, "EUR")).toMatch(/€/);
      expect(formatFiat(1234.56, "EUR")).toMatch(/1,234\.56/);
    });

    test("respects an explicit decimals override", () => {
      expect(formatFiat(1234.5678, "USD", 4)).toBe("$1,234.5678");
    });

    test("uses natural fraction digits for JPY (zero) when decimals omitted", () => {
      expect(formatFiat(1234.5, "JPY")).toBe("¥1,235");
    });

    test("falls back to USD formatting when currency code is invalid", () => {
      expect(formatFiat(10, "NOT_A_CURRENCY")).toBe("$10.00");
    });
  });

  describe("groupTokensByChainAndWallet", () => {
    test("groups tokens by chain and wallet", () => {
      const wallet2 = "0x2222222222222222222222222222222222222222" as Address;
      const tokens = [
        makeToken(USDC_ETHEREUM, 100n, 1, { walletAddress: WALLET }),
        makeToken(USDC_ETHEREUM, 200n, 1, { walletAddress: WALLET }),
        makeToken(USDC_ETHEREUM, 300n, 10, { walletAddress: WALLET }),
        makeToken(USDC_ETHEREUM, 400n, 1, { walletAddress: wallet2 }),
      ];

      const groups = groupTokensByChainAndWallet(tokens);

      expect(groups).toHaveLength(3);
      // Find group for chain 1, wallet1
      const chain1Wallet1 = groups.find((g) => g[0].chainId === 1 && g[0].walletAddress === WALLET);
      expect(chain1Wallet1).toHaveLength(2);
    });

    test("returns empty array for empty input", () => {
      expect(groupTokensByChainAndWallet([])).toEqual([]);
    });

    test("single token returns single group", () => {
      const tokens = [makeToken(USDC_ETHEREUM, 100n, 1)];
      const groups = groupTokensByChainAndWallet(tokens);

      expect(groups).toHaveLength(1);
      expect(groups[0]).toHaveLength(1);
    });
  });

  describe("consolidateTokenAmounts", () => {
    test("consolidates duplicate tokens by summing amounts", () => {
      const tokens = [
        makeToken(USDC_ETHEREUM, 100n, 1),
        makeToken(USDC_ETHEREUM, 200n, 1),
        makeToken(USDC_ETHEREUM, 300n, 1),
      ];

      const consolidated = consolidateTokenAmounts(tokens);

      expect(consolidated).toHaveLength(1);
      expect(consolidated[0].amount).toBe(600n);
    });

    test("keeps different tokens separate", () => {
      const token2 = "0x2222222222222222222222222222222222222222" as Address;
      const tokens = [makeToken(USDC_ETHEREUM, 100n, 1), makeToken(token2, 200n, 1)];

      const consolidated = consolidateTokenAmounts(tokens);

      expect(consolidated).toHaveLength(2);
    });

    test("keeps same token on different chains separate", () => {
      const tokens = [makeToken(USDC_ETHEREUM, 100n, 1), makeToken(USDC_ETHEREUM, 200n, 10)];

      const consolidated = consolidateTokenAmounts(tokens);

      expect(consolidated).toHaveLength(2);
    });

    test("keeps same token from different wallets separate", () => {
      const wallet2 = "0x2222222222222222222222222222222222222222" as Address;
      const tokens = [
        makeToken(USDC_ETHEREUM, 100n, 1, { walletAddress: WALLET }),
        makeToken(USDC_ETHEREUM, 200n, 1, { walletAddress: wallet2 }),
      ];

      const consolidated = consolidateTokenAmounts(tokens);

      expect(consolidated).toHaveLength(2);
    });

    test("returns empty array for empty input", () => {
      expect(consolidateTokenAmounts([])).toEqual([]);
    });

    test("normalizes token addresses to checksum format", () => {
      const lowercaseAddress = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" as Address;
      const tokens = [makeToken(lowercaseAddress, 100n, 1)];

      const consolidated = consolidateTokenAmounts(tokens);

      expect(consolidated[0].token).toBe("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
    });
  });

  describe("buildERC20ApprovalCalls", () => {
    let mockPublicClient: { readContract: Mock };

    const mockTokenUSDC = makeToken(USDC_TOKEN, 1000000n, 1, { walletAddress: WALLET });
    const mockTokenUSDT = makeToken(USDT_TOKEN, 2000000n, 1, { walletAddress: WALLET, symbol: "USDT" });
    const mockTokenNative = makeToken(ETH_ADDRESS, 1000000000000000000n, 1, {
      walletAddress: WALLET,
      symbol: "ETH",
      decimals: 18,
    });

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
