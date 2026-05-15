import { type Address, type PublicClient, parseUnits, type Transport } from "viem";
import { arbitrum, base, mainnet, optimism, polygon } from "viem/chains";
import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("./public-client", () => ({
  getPublicClient: vi.fn(),
  retryOnRateLimit: vi.fn((fn) => fn()),
}));

import { findRichestSource, getNativeBalance } from "./gas";
import { getPublicClient } from "./public-client";

const mockGetPublicClient = vi.mocked(getPublicClient);

describe("gas", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getNativeBalance", () => {
    test("should return the native balance using provided transport", async () => {
      const mockGetBalance = vi.fn().mockResolvedValue(parseUnits("1.5", 18));
      mockGetPublicClient.mockReturnValue({
        getBalance: mockGetBalance,
      } as Partial<PublicClient> as PublicClient);

      const mockTransport = {} as Transport;
      const address = "0xc30b007BC349d52850207F78c63b4bd0c823F122" as Address;

      const balance = await getNativeBalance(mainnet, address, mockTransport);

      expect(balance).toBe(parseUnits("1.5", 18));
      expect(mockGetPublicClient).toHaveBeenCalledWith(mainnet.id, mockTransport);
      expect(mockGetBalance).toHaveBeenCalledWith({ address });
    });

    test("should return zero balance when address has no funds", async () => {
      const mockGetBalance = vi.fn().mockResolvedValue(0n);
      mockGetPublicClient.mockReturnValue({
        getBalance: mockGetBalance,
      } as Partial<PublicClient> as PublicClient);

      const mockTransport = {} as Transport;
      const address = "0x0000000000000000000000000000000000000001" as Address;

      const balance = await getNativeBalance(mainnet, address, mockTransport);

      expect(balance).toBe(0n);
    });

    test("should handle large balance values", async () => {
      const largeBalance = parseUnits("1000000", 18);
      const mockGetBalance = vi.fn().mockResolvedValue(largeBalance);
      mockGetPublicClient.mockReturnValue({
        getBalance: mockGetBalance,
      } as Partial<PublicClient> as PublicClient);

      const mockTransport = {} as Transport;
      const address = "0xc30b007BC349d52850207F78c63b4bd0c823F122" as Address;

      const balance = await getNativeBalance(mainnet, address, mockTransport);

      expect(balance).toBe(largeBalance);
    });
  });

  describe("findRichestSource", () => {
    const ADDR_A = "0x1111111111111111111111111111111111111111" as Address;
    const ADDR_B = "0x2222222222222222222222222222222222222222" as Address;

    function setupBalances(balances: Record<string, bigint>) {
      const mockGetBalance = vi.fn(async ({ address }: { address: Address }) => balances[address] ?? 0n);
      mockGetPublicClient.mockReturnValue({
        getBalance: mockGetBalance,
      } as Partial<PublicClient> as PublicClient);
    }

    test("returns the (chainId, address) pair with the highest balance", async () => {
      setupBalances({
        [ADDR_A]: parseUnits("1", 18),
        [ADDR_B]: parseUnits("5", 18),
      });

      const richest = await findRichestSource([
        [mainnet.id, ADDR_A],
        [optimism.id, ADDR_A],
        [base.id, ADDR_B],
      ]);

      expect(richest).toEqual({ chainId: base.id, address: ADDR_B, balance: parseUnits("5", 18) });
    });

    test("dedupes (chainId, address) pairs (case-insensitive address normalization)", async () => {
      const mockGetBalance = vi.fn().mockResolvedValue(parseUnits("3", 18));
      mockGetPublicClient.mockReturnValue({
        getBalance: mockGetBalance,
      } as Partial<PublicClient> as PublicClient);

      const richest = await findRichestSource([
        [mainnet.id, ADDR_A],
        [mainnet.id, ADDR_A.toLowerCase() as Address],
      ]);

      expect(richest).not.toBeNull();
      // getBalance should only have been called once thanks to dedup
      expect(mockGetBalance).toHaveBeenCalledTimes(1);
    });

    test("returns null when no candidates are on supported chains", async () => {
      const UNSUPPORTED = 999_999;
      const richest = await findRichestSource([[UNSUPPORTED, ADDR_A]]);
      expect(richest).toBeNull();
    });

    test("returns null for empty input", async () => {
      const richest = await findRichestSource([]);
      expect(richest).toBeNull();
    });

    test("works across all supported chains", async () => {
      setupBalances({
        [ADDR_A]: parseUnits("0.1", 18),
        [ADDR_B]: parseUnits("0.2", 18),
      });
      const richest = await findRichestSource([
        [mainnet.id, ADDR_A],
        [polygon.id, ADDR_A],
        [arbitrum.id, ADDR_B],
        [optimism.id, ADDR_B],
        [base.id, ADDR_B],
      ]);
      expect(richest?.address).toBe(ADDR_B);
    });
  });
});
