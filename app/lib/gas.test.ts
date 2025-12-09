import { type Address, type PublicClient, parseUnits, type Transport } from "viem";
import { mainnet, optimism, polygon } from "viem/chains";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { ETH_ADDRESS, makeToken } from "../../test/test-helpers";

// Mock the public-client module
vi.mock("./public-client", () => ({
  getPublicClient: vi.fn(),
  retryOnRateLimit: vi.fn((fn) => fn()),
}));

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

import { getGasThresholdForChain } from "~/data/gas-thresholds";
import { ensureSufficientGas, getNativeBalance } from "./gas";
import { getPublicClient } from "./public-client";

const mockGetPublicClient = vi.mocked(getPublicClient);
const mockGetGasThresholdForChain = vi.mocked(getGasThresholdForChain);

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

  const WALLET_1 = "0xc30b007BC349d52850207F78c63b4bd0c823F122" as Address;
  const WALLET_2 = "0x19afE793Fb51902883F68f06685aE5277aF13857" as Address;
  const WALLET_3 = "0x742d35Cc6634C0532925a3b844Bc454e4438f44e" as Address;

  describe("ensureSufficientGas", () => {
    test("should not throw when all wallets have sufficient gas", async () => {
      mockGetGasThresholdForChain.mockReturnValue("0.001");

      const mockGetBalance = vi.fn().mockResolvedValue(parseUnits("1", 18));
      mockGetPublicClient.mockReturnValue({
        getBalance: mockGetBalance,
      } as Partial<PublicClient> as PublicClient);

      const tokensIn = [
        makeToken(ETH_ADDRESS, parseUnits("100", 18), mainnet.id, {
          walletAddress: WALLET_1,
          symbol: "ETH",
          decimals: 18,
        }),
      ];

      const tokenOut = makeToken(ETH_ADDRESS, parseUnits("100", 18), optimism.id, {
        walletAddress: WALLET_2,
        symbol: "ETH",
        decimals: 18,
      });

      const chainAddresses = [
        ...tokensIn.map((token) => [token.chainId, token.walletAddress]),
        [tokenOut.chainId, tokenOut.walletAddress],
      ] as [number, Address][];

      const transports = {
        [mainnet.id]: {} as Transport,
        [optimism.id]: {} as Transport,
      };

      await expect(ensureSufficientGas(chainAddresses, transports)).resolves.not.toThrow();
    });

    test("should throw when source wallet has insufficient gas", async () => {
      mockGetGasThresholdForChain.mockReturnValue("0.002");

      const mockGetBalance = vi.fn().mockResolvedValue(parseUnits("0.001", 18));
      mockGetPublicClient.mockReturnValue({
        getBalance: mockGetBalance,
      } as Partial<PublicClient> as PublicClient);

      const tokensIn = [
        makeToken(ETH_ADDRESS, parseUnits("100", 18), mainnet.id, {
          walletAddress: WALLET_1,
          symbol: "ETH",
          decimals: 18,
        }),
      ];

      const tokenOut = makeToken(ETH_ADDRESS, parseUnits("100", 18), mainnet.id, {
        walletAddress: WALLET_2,
        symbol: "ETH",
        decimals: 18,
      });

      const chainAddresses = [
        ...tokensIn.map((token) => [token.chainId, token.walletAddress]),
        [tokenOut.chainId, tokenOut.walletAddress],
      ] as [number, Address][];

      const transports = {
        [mainnet.id]: {} as Transport,
      };

      await expect(ensureSufficientGas(chainAddresses, transports)).rejects.toThrow("Insufficient gas on");
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

      mockGetPublicClient.mockReturnValue({
        getBalance: mockGetBalance,
      } as Partial<PublicClient> as PublicClient);

      const tokensIn = [
        makeToken(ETH_ADDRESS, parseUnits("100", 18), mainnet.id, {
          walletAddress: WALLET_1,
          symbol: "ETH",
          decimals: 18,
        }),
      ];

      const tokenOut = makeToken(ETH_ADDRESS, parseUnits("100", 18), optimism.id, {
        walletAddress: WALLET_2,
        symbol: "ETH",
        decimals: 18,
      });

      const chainAddresses = [
        ...tokensIn.map((token) => [token.chainId, token.walletAddress]),
        [tokenOut.chainId, tokenOut.walletAddress],
      ] as [number, Address][];

      const transports = {
        [mainnet.id]: {} as Transport,
        [optimism.id]: {} as Transport,
      };

      await expect(ensureSufficientGas(chainAddresses, transports)).rejects.toThrow("Insufficient gas on OP Mainnet");
    });

    test("should return failing chains and wallets when requested", async () => {
      mockGetGasThresholdForChain.mockReturnValue("0.5");

      let invocation = 0;
      const mockGetBalance = vi.fn().mockImplementation(() => {
        invocation++;
        if (invocation === 1) {
          return Promise.resolve(parseUnits("1", 18));
        }
        return Promise.resolve(parseUnits("0.1", 18));
      });

      mockGetPublicClient.mockReturnValue({
        getBalance: mockGetBalance,
      } as Partial<PublicClient> as PublicClient);

      const tokensIn = [
        makeToken(ETH_ADDRESS, parseUnits("100", 18), mainnet.id, {
          walletAddress: WALLET_1,
          symbol: "ETH",
          decimals: 18,
        }),
      ];

      const tokenOut = makeToken(ETH_ADDRESS, parseUnits("100", 18), optimism.id, {
        walletAddress: WALLET_2,
        symbol: "ETH",
        decimals: 18,
      });

      const chainAddresses = [
        ...tokensIn.map((token) => [token.chainId, token.walletAddress]),
        [tokenOut.chainId, tokenOut.walletAddress],
      ] as [number, Address][];

      const transports = {
        [mainnet.id]: {} as Transport,
        [optimism.id]: {} as Transport,
      };

      const insufficient = await ensureSufficientGas(chainAddresses, transports, false);

      expect(insufficient).toEqual([[tokenOut.chainId, tokenOut.walletAddress]]);
    });

    test("should deduplicate checks for same chain and wallet", async () => {
      mockGetGasThresholdForChain.mockReturnValue("0.001");

      const mockGetBalance = vi.fn().mockResolvedValue(parseUnits("1", 18));
      mockGetPublicClient.mockReturnValue({
        getBalance: mockGetBalance,
      } as Partial<PublicClient> as PublicClient);

      const USDC_TOKEN = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address;

      const tokensIn = [
        makeToken(ETH_ADDRESS, parseUnits("50", 18), mainnet.id, {
          walletAddress: WALLET_1,
          symbol: "ETH",
          decimals: 18,
        }),
        makeToken(USDC_TOKEN, parseUnits("100", 6), mainnet.id, {
          walletAddress: WALLET_1,
        }),
      ];

      const tokenOut = makeToken(ETH_ADDRESS, parseUnits("150", 18), optimism.id, {
        walletAddress: WALLET_2,
        symbol: "ETH",
        decimals: 18,
      });

      const chainAddresses = [
        ...tokensIn.map((token) => [token.chainId, token.walletAddress]),
        [tokenOut.chainId, tokenOut.walletAddress],
      ] as [number, Address][];

      const transports = {
        [mainnet.id]: {} as Transport,
        [optimism.id]: {} as Transport,
      };

      await ensureSufficientGas(chainAddresses, transports);

      // Should only check balance twice: once for mainnet address, once for optimism address
      expect(mockGetBalance).toHaveBeenCalledTimes(2);
    });

    test("should include destination wallet even if same as source", async () => {
      mockGetGasThresholdForChain.mockReturnValue("0.001");

      const mockGetBalance = vi.fn().mockResolvedValue(parseUnits("1", 18));
      mockGetPublicClient.mockReturnValue({
        getBalance: mockGetBalance,
      } as Partial<PublicClient> as PublicClient);

      const tokensIn = [
        makeToken(ETH_ADDRESS, parseUnits("50", 18), mainnet.id, {
          walletAddress: WALLET_1,
          symbol: "ETH",
          decimals: 18,
        }),
      ];

      const tokenOut = makeToken(ETH_ADDRESS, parseUnits("50", 18), mainnet.id, {
        walletAddress: WALLET_1,
        symbol: "ETH",
        decimals: 18,
      });

      const chainAddresses = [
        ...tokensIn.map((token) => [token.chainId, token.walletAddress]),
        [tokenOut.chainId, tokenOut.walletAddress],
      ] as [number, Address][];

      const transports = {
        [mainnet.id]: {} as Transport,
      };

      await ensureSufficientGas(chainAddresses, transports);

      // Should only check once since same chain+address
      expect(mockGetBalance).toHaveBeenCalledTimes(1);
    });

    test("should report multiple insufficient gas errors", async () => {
      mockGetGasThresholdForChain.mockReturnValue("0.002");

      const mockGetBalance = vi.fn().mockResolvedValue(parseUnits("0.001", 18));
      mockGetPublicClient.mockReturnValue({
        getBalance: mockGetBalance,
      } as Partial<PublicClient> as PublicClient);

      const tokensIn = [
        makeToken(ETH_ADDRESS, parseUnits("50", 18), mainnet.id, {
          walletAddress: WALLET_1,
          symbol: "ETH",
          decimals: 18,
        }),
        makeToken(ETH_ADDRESS, parseUnits("50", 18), optimism.id, {
          walletAddress: WALLET_2,
          symbol: "ETH",
          decimals: 18,
        }),
      ];

      const tokenOut = makeToken(ETH_ADDRESS, parseUnits("100", 18), polygon.id, {
        walletAddress: WALLET_3,
        symbol: "MATIC",
        decimals: 18,
      });

      const chainAddresses = [
        ...tokensIn.map((token) => [token.chainId, token.walletAddress]),
        [tokenOut.chainId, tokenOut.walletAddress],
      ] as [number, Address][];

      const transports = {
        [mainnet.id]: {} as Transport,
        [optimism.id]: {} as Transport,
        [polygon.id]: {} as Transport,
      };

      try {
        await ensureSufficientGas(chainAddresses, transports);
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
      mockGetPublicClient.mockReturnValue({
        getBalance: mockGetBalance,
      } as Partial<PublicClient> as PublicClient);

      const tokensIn = [
        makeToken(ETH_ADDRESS, parseUnits("100", 18), mainnet.id, {
          walletAddress: WALLET_1,
          symbol: "ETH",
          decimals: 18,
        }),
      ];

      const tokenOut = makeToken(ETH_ADDRESS, parseUnits("100", 18), mainnet.id, {
        walletAddress: WALLET_2,
        symbol: "ETH",
        decimals: 18,
      });

      const chainAddresses = [
        ...tokensIn.map((token) => [token.chainId, token.walletAddress]),
        [tokenOut.chainId, tokenOut.walletAddress],
      ] as [number, Address][];

      const transports = {
        [mainnet.id]: {} as Transport,
      };

      try {
        await ensureSufficientGas(chainAddresses, transports);
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
      mockGetPublicClient.mockReturnValue({
        getBalance: mockGetBalance,
      } as Partial<PublicClient> as PublicClient);

      const USDC_TOKEN = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address;
      const WALLET_UPPER = "0xC30B007BC349D52850207F78C63B4BD0C823F122" as Address;
      const WALLET_LOWER = "0xc30b007bc349d52850207f78c63b4bd0c823f122" as Address;

      const tokensIn = [
        makeToken(ETH_ADDRESS, parseUnits("50", 18), mainnet.id, {
          walletAddress: WALLET_UPPER, // uppercase
          symbol: "ETH",
          decimals: 18,
        }),
        makeToken(USDC_TOKEN, parseUnits("100", 6), mainnet.id, {
          walletAddress: WALLET_LOWER, // lowercase
        }),
      ];

      const tokenOut = makeToken(ETH_ADDRESS, parseUnits("150", 18), optimism.id, {
        walletAddress: WALLET_2,
        symbol: "ETH",
        decimals: 18,
      });

      const chainAddresses = [
        ...tokensIn.map((token) => [token.chainId, token.walletAddress]),
        [tokenOut.chainId, tokenOut.walletAddress],
      ] as [number, Address][];

      const transports = {
        [mainnet.id]: {} as Transport,
        [optimism.id]: {} as Transport,
      };

      await ensureSufficientGas(chainAddresses, transports);

      // Should deduplicate by lowercase address
      expect(mockGetBalance).toHaveBeenCalledTimes(2);
    });
  });
});
