import { type Address, type PublicClient, parseUnits, type Transport } from "viem";
import { mainnet } from "viem/chains";
import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("./public-client", () => ({
  getPublicClient: vi.fn(),
  retryOnRateLimit: vi.fn((fn) => fn()),
}));

import { getNativeBalance } from "./gas";
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
});
