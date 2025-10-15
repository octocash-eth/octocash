import { type Address, type Chain, type PublicClient, parseUnits, type Transport } from "viem";
import { mainnet, optimism, polygon } from "viem/chains";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { TokenAmount } from "./types";

// Mock the viem module
vi.mock("viem", async () => {
  const actual = await vi.importActual("viem");
  return {
    ...actual,
    createPublicClient: vi.fn(),
  };
});

// Mock the data modules
vi.mock("~/data/gas-thresholds", () => ({
  getGasThresholdForChain: vi.fn(),
}));

vi.mock("~/data/supported-chains", () => ({
  chains: {
    1: mainnet,
    10: optimism,
    137: polygon,
  },
  transports: {},
}));

import { createPublicClient } from "viem";
import { getGasThresholdForChain } from "~/data/gas-thresholds";
import { ensureSufficientGas, getNativeBalance } from "./gas";

const mockCreatePublicClient = vi.mocked(createPublicClient);
const mockGetGasThresholdForChain = vi.mocked(getGasThresholdForChain);

describe("gas", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getNativeBalance", () => {
    test("should return the native balance using provided transport", async () => {
      const mockGetBalance = vi.fn().mockResolvedValue(parseUnits("1.5", 18));
      mockCreatePublicClient.mockReturnValue({
        getBalance: mockGetBalance,
      } as Partial<PublicClient> as PublicClient);

      const mockTransport = {} as Transport;
      const address = "0xc30b007BC349d52850207F78c63b4bd0c823F122" as Address;

      const balance = await getNativeBalance(mainnet, address, mockTransport);

      expect(balance).toBe(parseUnits("1.5", 18));
      expect(mockCreatePublicClient).toHaveBeenCalledWith({
        chain: mainnet,
        transport: mockTransport,
      });
      expect(mockGetBalance).toHaveBeenCalledWith({ address });
    });

    test("should return zero balance when address has no funds", async () => {
      const mockGetBalance = vi.fn().mockResolvedValue(0n);
      mockCreatePublicClient.mockReturnValue({
        getBalance: mockGetBalance,
      } as Partial<PublicClient> as PublicClient);

      const mockTransport = {} as Transport;
      const address = "0x0000000000000000000000000000000000000001" as Address;

      const balance = await getNativeBalance(mainnet, address, mockTransport);

      expect(balance).toBe(0n);
    });

    test("should throw an error when no transport is provided and chain not in config", async () => {
      const chain: Chain = {
        id: 999999,
        name: "Unknown Chain",
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: { default: { http: ["http://localhost"] } },
      };
      const address = "0xc30b007BC349d52850207F78c63b4bd0c823F122" as Address;

      await expect(getNativeBalance(chain, address)).rejects.toThrow("No transport configured for chain 999999");
    });

    test("should handle large balance values", async () => {
      const largeBalance = parseUnits("1000000", 18);
      const mockGetBalance = vi.fn().mockResolvedValue(largeBalance);
      mockCreatePublicClient.mockReturnValue({
        getBalance: mockGetBalance,
      } as Partial<PublicClient> as PublicClient);

      const mockTransport = {} as Transport;
      const address = "0xc30b007BC349d52850207F78c63b4bd0c823F122" as Address;

      const balance = await getNativeBalance(mainnet, address, mockTransport);

      expect(balance).toBe(largeBalance);
    });
  });

  describe("ensureSufficientGas", () => {
    test("should not throw when all wallets have sufficient gas", async () => {
      mockGetGasThresholdForChain.mockReturnValue("0.001");

      const mockGetBalance = vi.fn().mockResolvedValue(parseUnits("1", 18));
      mockCreatePublicClient.mockReturnValue({
        getBalance: mockGetBalance,
      } as Partial<PublicClient> as PublicClient);

      const tokensIn: TokenAmount[] = [
        {
          chainId: mainnet.id,
          walletAddress: "0xc30b007BC349d52850207F78c63b4bd0c823F122" as Address,
          token: "0x0000000000000000000000000000000000000000" as Address,
          amount: parseUnits("100", 18),
          symbol: "ETH",
          decimals: 18,
        },
      ];

      const tokenOut: TokenAmount = {
        chainId: optimism.id,
        walletAddress: "0x19afE793Fb51902883F68f06685aE5277aF13857" as Address,
        token: "0x0000000000000000000000000000000000000000" as Address,
        amount: parseUnits("100", 18),
        symbol: "ETH",
        decimals: 18,
      };

      const transports = {
        [mainnet.id]: {} as Transport,
        [optimism.id]: {} as Transport,
      };

      await expect(ensureSufficientGas(tokensIn, tokenOut, transports)).resolves.not.toThrow();
    });

    test("should throw when source wallet has insufficient gas", async () => {
      mockGetGasThresholdForChain.mockReturnValue("0.002");

      const mockGetBalance = vi.fn().mockResolvedValue(parseUnits("0.001", 18));
      mockCreatePublicClient.mockReturnValue({
        getBalance: mockGetBalance,
      } as Partial<PublicClient> as PublicClient);

      const tokensIn: TokenAmount[] = [
        {
          chainId: mainnet.id,
          walletAddress: "0xc30b007BC349d52850207F78c63b4bd0c823F122" as Address,
          token: "0x0000000000000000000000000000000000000000" as Address,
          amount: parseUnits("100", 18),
          symbol: "ETH",
          decimals: 18,
        },
      ];

      const tokenOut: TokenAmount = {
        chainId: mainnet.id,
        walletAddress: "0x19afE793Fb51902883F68f06685aE5277aF13857" as Address,
        token: "0x0000000000000000000000000000000000000000" as Address,
        amount: parseUnits("100", 18),
        symbol: "ETH",
        decimals: 18,
      };

      const transports = {
        [mainnet.id]: {} as Transport,
      };

      await expect(ensureSufficientGas(tokensIn, tokenOut, transports)).rejects.toThrow("Insufficient gas on");
    });

    test("should throw when destination wallet has insufficient gas", async () => {
      mockGetGasThresholdForChain
        .mockReturnValueOnce("0.001") // mainnet threshold
        .mockReturnValueOnce("0.002"); // optimism threshold

      let callCount = 0;
      const mockGetBalance = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve(parseUnits("1", 18)); // source has enough
        }
        return Promise.resolve(parseUnits("0.001", 18)); // destination doesn't
      });

      mockCreatePublicClient.mockReturnValue({
        getBalance: mockGetBalance,
      } as Partial<PublicClient> as PublicClient);

      const tokensIn: TokenAmount[] = [
        {
          chainId: mainnet.id,
          walletAddress: "0xc30b007BC349d52850207F78c63b4bd0c823F122" as Address,
          token: "0x0000000000000000000000000000000000000000" as Address,
          amount: parseUnits("100", 18),
          symbol: "ETH",
          decimals: 18,
        },
      ];

      const tokenOut: TokenAmount = {
        chainId: optimism.id,
        walletAddress: "0x19afE793Fb51902883F68f06685aE5277aF13857" as Address,
        token: "0x0000000000000000000000000000000000000000" as Address,
        amount: parseUnits("100", 18),
        symbol: "ETH",
        decimals: 18,
      };

      const transports = {
        [mainnet.id]: {} as Transport,
        [optimism.id]: {} as Transport,
      };

      await expect(ensureSufficientGas(tokensIn, tokenOut, transports)).rejects.toThrow(
        "Insufficient gas on OP Mainnet",
      );
    });

    test("should deduplicate checks for same chain and wallet", async () => {
      mockGetGasThresholdForChain.mockReturnValue("0.001");

      const mockGetBalance = vi.fn().mockResolvedValue(parseUnits("1", 18));
      mockCreatePublicClient.mockReturnValue({
        getBalance: mockGetBalance,
      } as Partial<PublicClient> as PublicClient);

      const address = "0xc30b007BC349d52850207F78c63b4bd0c823F122" as Address;

      const tokensIn: TokenAmount[] = [
        {
          chainId: mainnet.id,
          walletAddress: address,
          token: "0x0000000000000000000000000000000000000000" as Address,
          amount: parseUnits("50", 18),
          symbol: "ETH",
          decimals: 18,
        },
        {
          chainId: mainnet.id,
          walletAddress: address,
          token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address,
          amount: parseUnits("100", 6),
          symbol: "USDC",
          decimals: 6,
        },
      ];

      const tokenOut: TokenAmount = {
        chainId: optimism.id,
        walletAddress: "0x19afE793Fb51902883F68f06685aE5277aF13857" as Address,
        token: "0x0000000000000000000000000000000000000000" as Address,
        amount: parseUnits("150", 18),
        symbol: "ETH",
        decimals: 18,
      };

      const transports = {
        [mainnet.id]: {} as Transport,
        [optimism.id]: {} as Transport,
      };

      await ensureSufficientGas(tokensIn, tokenOut, transports);

      // Should only check balance twice: once for mainnet address, once for optimism address
      expect(mockGetBalance).toHaveBeenCalledTimes(2);
    });

    test("should include destination wallet even if same as source", async () => {
      mockGetGasThresholdForChain.mockReturnValue("0.001");

      const mockGetBalance = vi.fn().mockResolvedValue(parseUnits("1", 18));
      mockCreatePublicClient.mockReturnValue({
        getBalance: mockGetBalance,
      } as Partial<PublicClient> as PublicClient);

      const address = "0xc30b007BC349d52850207F78c63b4bd0c823F122" as Address;

      const tokensIn: TokenAmount[] = [
        {
          chainId: mainnet.id,
          walletAddress: address,
          token: "0x0000000000000000000000000000000000000000" as Address,
          amount: parseUnits("50", 18),
          symbol: "ETH",
          decimals: 18,
        },
      ];

      const tokenOut: TokenAmount = {
        chainId: mainnet.id,
        walletAddress: address,
        token: "0x0000000000000000000000000000000000000000" as Address,
        amount: parseUnits("50", 18),
        symbol: "ETH",
        decimals: 18,
      };

      const transports = {
        [mainnet.id]: {} as Transport,
      };

      await ensureSufficientGas(tokensIn, tokenOut, transports);

      // Should only check once since same chain+address
      expect(mockGetBalance).toHaveBeenCalledTimes(1);
    });

    test("should report multiple insufficient gas errors", async () => {
      mockGetGasThresholdForChain.mockReturnValue("0.002");

      const mockGetBalance = vi.fn().mockResolvedValue(parseUnits("0.001", 18));
      mockCreatePublicClient.mockReturnValue({
        getBalance: mockGetBalance,
      } as Partial<PublicClient> as PublicClient);

      const tokensIn: TokenAmount[] = [
        {
          chainId: mainnet.id,
          walletAddress: "0xc30b007BC349d52850207F78c63b4bd0c823F122" as Address,
          token: "0x0000000000000000000000000000000000000000" as Address,
          amount: parseUnits("50", 18),
          symbol: "ETH",
          decimals: 18,
        },
        {
          chainId: optimism.id,
          walletAddress: "0x19afE793Fb51902883F68f06685aE5277aF13857" as Address,
          token: "0x0000000000000000000000000000000000000000" as Address,
          amount: parseUnits("50", 18),
          symbol: "ETH",
          decimals: 18,
        },
      ];

      const tokenOut: TokenAmount = {
        chainId: polygon.id,
        walletAddress: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e" as Address,
        token: "0x0000000000000000000000000000000000000000" as Address,
        amount: parseUnits("100", 18),
        symbol: "MATIC",
        decimals: 18,
      };

      const transports = {
        [mainnet.id]: {} as Transport,
        [optimism.id]: {} as Transport,
        [polygon.id]: {} as Transport,
      };

      try {
        await ensureSufficientGas(tokensIn, tokenOut, transports);
        expect.fail("Should have thrown an error");
      } catch (error) {
        const errorMessage = (error as Error).message;
        expect(errorMessage).toContain("Insufficient gas");
        expect(errorMessage).toContain("Ethereum");
        expect(errorMessage).toContain("OP Mainnet");
        expect(errorMessage).toContain("Polygon");
        expect(errorMessage).toContain("gas.zip");
      }
    });

    test("should format balance values correctly in error messages", async () => {
      mockGetGasThresholdForChain.mockReturnValue("0.002");

      const mockGetBalance = vi.fn().mockResolvedValue(parseUnits("0.00123", 18));
      mockCreatePublicClient.mockReturnValue({
        getBalance: mockGetBalance,
      } as Partial<PublicClient> as PublicClient);

      const tokensIn: TokenAmount[] = [
        {
          chainId: mainnet.id,
          walletAddress: "0xc30b007BC349d52850207F78c63b4bd0c823F122" as Address,
          token: "0x0000000000000000000000000000000000000000" as Address,
          amount: parseUnits("100", 18),
          symbol: "ETH",
          decimals: 18,
        },
      ];

      const tokenOut: TokenAmount = {
        chainId: mainnet.id,
        walletAddress: "0x19afE793Fb51902883F68f06685aE5277aF13857" as Address,
        token: "0x0000000000000000000000000000000000000000" as Address,
        amount: parseUnits("100", 18),
        symbol: "ETH",
        decimals: 18,
      };

      const transports = {
        [mainnet.id]: {} as Transport,
      };

      try {
        await ensureSufficientGas(tokensIn, tokenOut, transports);
        expect.fail("Should have thrown an error");
      } catch (error) {
        const errorMessage = (error as Error).message;
        expect(errorMessage).toContain("0.00123 ETH");
        expect(errorMessage).toContain("0.002 ETH");
      }
    });

    test("should handle addresses with different casing", async () => {
      mockGetGasThresholdForChain.mockReturnValue("0.001");

      const mockGetBalance = vi.fn().mockResolvedValue(parseUnits("1", 18));
      mockCreatePublicClient.mockReturnValue({
        getBalance: mockGetBalance,
      } as Partial<PublicClient> as PublicClient);

      const tokensIn: TokenAmount[] = [
        {
          chainId: mainnet.id,
          walletAddress: "0xC30B007BC349D52850207F78C63B4BD0C823F122" as Address, // uppercase
          token: "0x0000000000000000000000000000000000000000" as Address,
          amount: parseUnits("50", 18),
          symbol: "ETH",
          decimals: 18,
        },
        {
          chainId: mainnet.id,
          walletAddress: "0xc30b007bc349d52850207f78c63b4bd0c823f122" as Address, // lowercase
          token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address,
          amount: parseUnits("100", 6),
          symbol: "USDC",
          decimals: 6,
        },
      ];

      const tokenOut: TokenAmount = {
        chainId: optimism.id,
        walletAddress: "0x19afE793Fb51902883F68f06685aE5277aF13857" as Address,
        token: "0x0000000000000000000000000000000000000000" as Address,
        amount: parseUnits("150", 18),
        symbol: "ETH",
        decimals: 18,
      };

      const transports = {
        [mainnet.id]: {} as Transport,
        [optimism.id]: {} as Transport,
      };

      await ensureSufficientGas(tokensIn, tokenOut, transports);

      // Should deduplicate by lowercase address
      expect(mockGetBalance).toHaveBeenCalledTimes(2);
    });
  });
});
