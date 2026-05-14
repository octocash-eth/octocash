import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Attestation } from "~/lib/cctp";
import { useCCTPClaim } from "./use-cctp-claim";

// Mock wagmi
const mockWalletClient = {
  account: { address: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd" as `0x${string}` },
  chain: { id: 1 },
};
const mockUseWalletClient = vi.fn();
vi.mock("wagmi", () => ({
  useWalletClient: () => mockUseWalletClient(),
}));

// Mock cctp-contracts data
vi.mock("~/data/cctp-contracts", () => ({
  chainIdToDomain: {
    1: 0, // Ethereum
    137: 7, // Polygon
    10: 2, // Optimism
    42161: 3, // Arbitrum
    8453: 6, // Base
  },
  tokenAddresses: {
    1: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    137: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
    10: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
    42161: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    8453: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  },
}));

// Mock cctp lib
const mockRetrieveAttestations = vi.fn();
const mockExecuteCCTPMint = vi.fn();
vi.mock("~/lib/cctp", () => ({
  retrieveAttestations: (...args: unknown[]) => mockRetrieveAttestations(...args),
  executeCCTPMint: (...args: unknown[]) => mockExecuteCCTPMint(...args),
}));

// Mock send-calls
const mockPrepareSendCalls = vi.fn();
vi.mock("~/lib/send-calls", () => ({
  prepareSendCalls: (...args: unknown[]) => mockPrepareSendCalls(...args),
}));

describe("useCCTPClaim", () => {
  const createMockAttestation = (destinationDomain: string): Attestation => ({
    message: "0xaabbccdd",
    attestation: "0xaabbccdd",
    status: "complete",
    decodedMessage: {
      nonce: "0x1",
      destinationDomain,
      decodedMessageBody: {
        amount: "1000000",
        feeExecuted: "0",
      },
    },
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockUseWalletClient.mockReturnValue({ data: mockWalletClient });
  });

  describe("initialization", () => {
    test("returns claim function", () => {
      const { result } = renderHook(() => useCCTPClaim());
      expect(result.current.claim).toBeDefined();
      expect(typeof result.current.claim).toBe("function");
    });
  });

  describe("claim", () => {
    test("throws error when wallet client is not available", async () => {
      mockUseWalletClient.mockReturnValue({ data: undefined });

      const { result } = renderHook(() => useCCTPClaim());

      await expect(result.current.claim("0xaabbccdd", 1)).rejects.toThrow("Wallet client is not available.");
    });

    test("retrieves attestations for transaction", async () => {
      const txHash = "0xaabbccdd";
      const sourceChainId = 1;
      const attestations = [createMockAttestation("0")];

      mockRetrieveAttestations.mockResolvedValue(attestations);
      mockPrepareSendCalls.mockReturnValue(vi.fn());
      mockExecuteCCTPMint.mockResolvedValue(["0xtxhash", []]);

      const { result } = renderHook(() => useCCTPClaim());

      await act(async () => {
        await result.current.claim(txHash, sourceChainId);
      });

      expect(mockRetrieveAttestations).toHaveBeenCalledWith([[txHash, sourceChainId]], undefined);
    });

    test("throws error when no attestations found", async () => {
      mockRetrieveAttestations.mockResolvedValue([]);

      const { result } = renderHook(() => useCCTPClaim());

      await expect(result.current.claim("0xaabbccdd", 1)).rejects.toThrow("No attestations found.");
    });

    test("throws error when attestations have different destination chains", async () => {
      const attestations = [createMockAttestation("0"), createMockAttestation("2")];

      mockRetrieveAttestations.mockResolvedValue(attestations);

      const { result } = renderHook(() => useCCTPClaim());

      await expect(result.current.claim("0xaabbccdd", 1)).rejects.toThrow(
        "Only same destination chain ID is supported.",
      );
    });

    test("executes CCTP mint with correct parameters", async () => {
      const attestations = [createMockAttestation("0")]; // Domain 0 = Ethereum (chainId 1)
      const mockSendCalls = vi.fn();

      mockRetrieveAttestations.mockResolvedValue(attestations);
      mockPrepareSendCalls.mockReturnValue(mockSendCalls);
      mockExecuteCCTPMint.mockResolvedValue(["0xtxhash", []]);

      const { result } = renderHook(() => useCCTPClaim());

      await act(async () => {
        await result.current.claim("0xaabbccdd", 1);
      });

      expect(mockPrepareSendCalls).toHaveBeenCalledWith(mockWalletClient);
      expect(mockExecuteCCTPMint).toHaveBeenCalledWith(
        attestations,
        expect.objectContaining({
          token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // Ethereum USDC
          amount: 0n,
          walletAddress: mockWalletClient.account.address,
          chainId: 1,
          symbol: "USDC",
          decimals: 6,
        }),
        mockSendCalls,
      );
    });

    test("returns mint transaction hash and logs", async () => {
      const attestations = [createMockAttestation("0")];
      const mockTxHash = "0xminthash";
      const mockLogs = [{ data: "0xaabbccdd" }];

      mockRetrieveAttestations.mockResolvedValue(attestations);
      mockPrepareSendCalls.mockReturnValue(vi.fn());
      mockExecuteCCTPMint.mockResolvedValue([mockTxHash, mockLogs]);

      const { result } = renderHook(() => useCCTPClaim());

      const claimResult = await act(async () => {
        return await result.current.claim("0xaabbccdd", 1);
      });

      expect(claimResult.mintTx).toBe(mockTxHash);
      expect(claimResult.logs).toEqual(mockLogs);
    });

    test("handles Polygon destination (domain 7)", async () => {
      const attestations = [createMockAttestation("7")]; // Domain 7 = Polygon (chainId 137)

      mockRetrieveAttestations.mockResolvedValue(attestations);
      mockPrepareSendCalls.mockReturnValue(vi.fn());
      mockExecuteCCTPMint.mockResolvedValue(["0xtxhash", []]);

      const { result } = renderHook(() => useCCTPClaim());

      await act(async () => {
        await result.current.claim("0xaabbccdd", 1);
      });

      expect(mockExecuteCCTPMint).toHaveBeenCalledWith(
        attestations,
        expect.objectContaining({
          token: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", // Polygon USDC
          chainId: 137,
        }),
        expect.any(Function),
      );
    });

    test("handles Optimism destination (domain 2)", async () => {
      const attestations = [createMockAttestation("2")]; // Domain 2 = Optimism (chainId 10)

      mockRetrieveAttestations.mockResolvedValue(attestations);
      mockPrepareSendCalls.mockReturnValue(vi.fn());
      mockExecuteCCTPMint.mockResolvedValue(["0xtxhash", []]);

      const { result } = renderHook(() => useCCTPClaim());

      await act(async () => {
        await result.current.claim("0xaabbccdd", 1);
      });

      expect(mockExecuteCCTPMint).toHaveBeenCalledWith(
        attestations,
        expect.objectContaining({
          token: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", // Optimism USDC
          chainId: 10,
        }),
        expect.any(Function),
      );
    });

    test("handles Arbitrum destination (domain 3)", async () => {
      const attestations = [createMockAttestation("3")]; // Domain 3 = Arbitrum (chainId 42161)

      mockRetrieveAttestations.mockResolvedValue(attestations);
      mockPrepareSendCalls.mockReturnValue(vi.fn());
      mockExecuteCCTPMint.mockResolvedValue(["0xtxhash", []]);

      const { result } = renderHook(() => useCCTPClaim());

      await act(async () => {
        await result.current.claim("0xaabbccdd", 1);
      });

      expect(mockExecuteCCTPMint).toHaveBeenCalledWith(
        attestations,
        expect.objectContaining({
          token: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", // Arbitrum USDC
          chainId: 42161,
        }),
        expect.any(Function),
      );
    });

    test("handles Base destination (domain 6)", async () => {
      const attestations = [createMockAttestation("6")]; // Domain 6 = Base (chainId 8453)

      mockRetrieveAttestations.mockResolvedValue(attestations);
      mockPrepareSendCalls.mockReturnValue(vi.fn());
      mockExecuteCCTPMint.mockResolvedValue(["0xtxhash", []]);

      const { result } = renderHook(() => useCCTPClaim());

      await act(async () => {
        await result.current.claim("0xaabbccdd", 1);
      });

      expect(mockExecuteCCTPMint).toHaveBeenCalledWith(
        attestations,
        expect.objectContaining({
          token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // Base USDC
          chainId: 8453,
        }),
        expect.any(Function),
      );
    });

    test("handles multiple attestations with same destination", async () => {
      const attestations = [createMockAttestation("0"), createMockAttestation("0")];

      mockRetrieveAttestations.mockResolvedValue(attestations);
      mockPrepareSendCalls.mockReturnValue(vi.fn());
      mockExecuteCCTPMint.mockResolvedValue(["0xtxhash", []]);

      const { result } = renderHook(() => useCCTPClaim());

      await act(async () => {
        await result.current.claim("0xaabbccdd", 1);
      });

      expect(mockExecuteCCTPMint).toHaveBeenCalledWith(attestations, expect.any(Object), expect.any(Function));
    });

    test("propagates errors from retrieveAttestations", async () => {
      const error = new Error("Failed to retrieve attestations");
      mockRetrieveAttestations.mockRejectedValue(error);

      const { result } = renderHook(() => useCCTPClaim());

      await expect(result.current.claim("0xaabbccdd", 1)).rejects.toThrow("Failed to retrieve attestations");
    });

    test("propagates errors from executeCCTPMint", async () => {
      const attestations = [createMockAttestation("0")];
      const error = new Error("Failed to execute mint");

      mockRetrieveAttestations.mockResolvedValue(attestations);
      mockPrepareSendCalls.mockReturnValue(vi.fn());
      mockExecuteCCTPMint.mockRejectedValue(error);

      const { result } = renderHook(() => useCCTPClaim());

      await expect(result.current.claim("0xaabbccdd", 1)).rejects.toThrow("Failed to execute mint");
    });

    test("uses wallet address from wallet client", async () => {
      const customWalletClient = {
        account: { address: "0x9876543210987654321098765432109876543210" as `0x${string}` },
        chain: { id: 1 },
      };
      mockUseWalletClient.mockReturnValue({ data: customWalletClient });

      const attestations = [createMockAttestation("0")];
      mockRetrieveAttestations.mockResolvedValue(attestations);
      mockPrepareSendCalls.mockReturnValue(vi.fn());
      mockExecuteCCTPMint.mockResolvedValue(["0xtxhash", []]);

      const { result } = renderHook(() => useCCTPClaim());

      await act(async () => {
        await result.current.claim("0xaabbccdd", 1);
      });

      expect(mockExecuteCCTPMint).toHaveBeenCalledWith(
        attestations,
        expect.objectContaining({
          walletAddress: customWalletClient.account.address,
        }),
        expect.any(Function),
      );
    });
  });

  describe("destination chain ID mapping", () => {
    test("maps domain 0 to Ethereum (chain 1)", async () => {
      const attestations = [createMockAttestation("0")];
      mockRetrieveAttestations.mockResolvedValue(attestations);
      mockPrepareSendCalls.mockReturnValue(vi.fn());
      mockExecuteCCTPMint.mockResolvedValue(["0xtxhash", []]);

      const { result } = renderHook(() => useCCTPClaim());

      await act(async () => {
        await result.current.claim("0xaabbccdd", 1);
      });

      expect(mockExecuteCCTPMint).toHaveBeenCalledWith(
        attestations,
        expect.objectContaining({ chainId: 1 }),
        expect.any(Function),
      );
    });

    test("maps domain 7 to Polygon (chain 137)", async () => {
      const attestations = [createMockAttestation("7")];
      mockRetrieveAttestations.mockResolvedValue(attestations);
      mockPrepareSendCalls.mockReturnValue(vi.fn());
      mockExecuteCCTPMint.mockResolvedValue(["0xtxhash", []]);

      const { result } = renderHook(() => useCCTPClaim());

      await act(async () => {
        await result.current.claim("0xaabbccdd", 1);
      });

      expect(mockExecuteCCTPMint).toHaveBeenCalledWith(
        attestations,
        expect.objectContaining({ chainId: 137 }),
        expect.any(Function),
      );
    });

    test("maps domain 2 to Optimism (chain 10)", async () => {
      const attestations = [createMockAttestation("2")];
      mockRetrieveAttestations.mockResolvedValue(attestations);
      mockPrepareSendCalls.mockReturnValue(vi.fn());
      mockExecuteCCTPMint.mockResolvedValue(["0xtxhash", []]);

      const { result } = renderHook(() => useCCTPClaim());

      await act(async () => {
        await result.current.claim("0xaabbccdd", 1);
      });

      expect(mockExecuteCCTPMint).toHaveBeenCalledWith(
        attestations,
        expect.objectContaining({ chainId: 10 }),
        expect.any(Function),
      );
    });

    test("maps domain 3 to Arbitrum (chain 42161)", async () => {
      const attestations = [createMockAttestation("3")];
      mockRetrieveAttestations.mockResolvedValue(attestations);
      mockPrepareSendCalls.mockReturnValue(vi.fn());
      mockExecuteCCTPMint.mockResolvedValue(["0xtxhash", []]);

      const { result } = renderHook(() => useCCTPClaim());

      await act(async () => {
        await result.current.claim("0xaabbccdd", 1);
      });

      expect(mockExecuteCCTPMint).toHaveBeenCalledWith(
        attestations,
        expect.objectContaining({ chainId: 42161 }),
        expect.any(Function),
      );
    });

    test("maps domain 6 to Base (chain 8453)", async () => {
      const attestations = [createMockAttestation("6")];
      mockRetrieveAttestations.mockResolvedValue(attestations);
      mockPrepareSendCalls.mockReturnValue(vi.fn());
      mockExecuteCCTPMint.mockResolvedValue(["0xtxhash", []]);

      const { result } = renderHook(() => useCCTPClaim());

      await act(async () => {
        await result.current.claim("0xaabbccdd", 1);
      });

      expect(mockExecuteCCTPMint).toHaveBeenCalledWith(
        attestations,
        expect.objectContaining({ chainId: 8453 }),
        expect.any(Function),
      );
    });
  });
});
