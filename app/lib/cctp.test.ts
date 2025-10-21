import type { Address, Hex, PublicClient } from "viem";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Attestation } from "./cctp";
import type { TokenAmount } from "./types";

// Mock external dependencies BEFORE imports
vi.mock("viem", async () => {
  const actual = await vi.importActual<typeof import("viem")>("viem");
  return {
    ...actual,
    encodeFunctionData: vi.fn((config) => {
      // Return a simple mock based on function name
      return `0x${config.functionName}_encoded` as Hex;
    }),
    createPublicClient: vi.fn(() => ({
      multicall: vi.fn(),
    })),
  };
});

// Mock data imports
vi.mock("~/data/cctp-contracts", () => ({
  chainIdToDomain: {
    1: 0, // Ethereum
    137: 7, // Polygon
    10: 2, // Optimism
    42161: 3, // Arbitrum
    8453: 6, // Base
  },
  messageTransmitter: {
    1: "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64",
    137: "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64",
    10: "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64",
  },
  tokenAddresses: {
    1: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    137: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
    10: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
  },
  tokenMessenger: {
    1: "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d",
    137: "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d",
    10: "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d",
  },
}));

vi.mock("~/data/supported-chains", () => ({
  chains: {
    1: { id: 1, name: "Ethereum" },
    137: { id: 137, name: "Polygon" },
    10: { id: 10, name: "Optimism" },
  },
  transports: {
    1: {},
    137: {},
    10: {},
  },
}));

import { createPublicClient } from "viem";
import { executeCCTPBurn, executeCCTPMint, getBridgeFee, getMintUsdcCalls, retrieveAttestations } from "./cctp";

describe("cctp", () => {
  const USDC_ADDRESS = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address;
  const WALLET = "0x1234567890123456789012345678901234567890" as Address;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset fetch mock
    global.fetch = vi.fn();
  });

  describe("getBridgeFee", () => {
    test("returns 0 for bridge fee", async () => {
      const fee = await getBridgeFee(1000000n, 1, 137);
      expect(fee).toBe(0n);
    });

    test("returns 0 regardless of amount or chains", async () => {
      const fee1 = await getBridgeFee(999999999999n, 10, 42161);
      const fee2 = await getBridgeFee(1n, 1, 1);
      expect(fee1).toBe(0n);
      expect(fee2).toBe(0n);
    });
  });

  describe("executeCCTPBurn", () => {
    test("executes burn successfully with approve and depositForBurn calls", async () => {
      const tokenIn: TokenAmount = {
        token: USDC_ADDRESS,
        amount: 1000000n, // 1 USDC
        chainId: 1, // Ethereum
        walletAddress: WALLET,
        symbol: "USDC",
        decimals: 6,
      };

      const tokenOut: TokenAmount = {
        token: USDC_ADDRESS,
        amount: 0n,
        chainId: 137, // Polygon
        walletAddress: WALLET,
        symbol: "USDC",
        decimals: 6,
      };

      const mockSendCalls = vi.fn().mockResolvedValue(["0xburnhash", []]);

      const [txHash, chainId] = await executeCCTPBurn(tokenIn, tokenOut, mockSendCalls);

      expect(txHash).toBe("0xburnhash");
      expect(chainId).toBe(1);
      expect(mockSendCalls).toHaveBeenCalledWith("burn", 1, WALLET, expect.any(Array), "atomic-steps");
      expect(mockSendCalls).toHaveBeenCalledTimes(1);

      // Verify the calls structure
      const calls = mockSendCalls.mock.calls[0][3];
      expect(calls).toHaveLength(2); // approve + depositForBurn
      expect(calls[0].to).toBe("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"); // USDC token
      expect(calls[1].to).toBe("0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d"); // Token Messenger
    });

    test("throws error when source and destination chains are the same", async () => {
      const tokenIn: TokenAmount = {
        token: USDC_ADDRESS,
        amount: 1000000n,
        chainId: 1,
        walletAddress: WALLET,
        symbol: "USDC",
        decimals: 6,
      };

      const tokenOut: TokenAmount = {
        token: USDC_ADDRESS,
        amount: 0n,
        chainId: 1, // Same chain
        walletAddress: WALLET,
        symbol: "USDC",
        decimals: 6,
      };

      const mockSendCalls = vi.fn();

      await expect(executeCCTPBurn(tokenIn, tokenOut, mockSendCalls)).rejects.toThrow(
        "Token is already on the destination chain",
      );
      expect(mockSendCalls).not.toHaveBeenCalled();
    });

    test("correctly pads destination address for EVM chains", async () => {
      const tokenIn: TokenAmount = {
        token: USDC_ADDRESS,
        amount: 500000n,
        chainId: 10,
        walletAddress: WALLET,
        symbol: "USDC",
        decimals: 6,
      };

      const tokenOut: TokenAmount = {
        token: USDC_ADDRESS,
        amount: 0n,
        chainId: 42161,
        walletAddress: "0xabcd" as Address, // Short address to test padding
        symbol: "USDC",
        decimals: 6,
      };

      const mockSendCalls = vi.fn().mockResolvedValue(["0xhash", []]);

      await executeCCTPBurn(tokenIn, tokenOut, mockSendCalls);

      expect(mockSendCalls).toHaveBeenCalledWith("burn", 10, WALLET, expect.any(Array), "atomic-steps");
    });
  });

  describe("retrieveAttestations", () => {
    test("retrieves attestation successfully on first attempt", async () => {
      const mockAttestation: Attestation = {
        message: "0xmessage",
        attestation: "0xattestation",
        status: "complete",
        decodedMessage: {
          nonce: "0xnonce1",
          destinationDomain: "7",
          decodedMessageBody: {
            amount: "1000000",
            feeExecuted: "0",
          },
        },
      };

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ messages: [mockAttestation] }),
      } as Response);

      const result = await retrieveAttestations([["0xtxhash", 1]]);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(mockAttestation);
      expect(global.fetch).toHaveBeenCalledWith("https://iris-api.circle.com/v2/messages/0?transactionHash=0xtxhash");
    });

    test("retrieves multiple attestations sequentially", async () => {
      const mockAttestation1: Attestation = {
        message: "0xmessage1",
        attestation: "0xattestation1",
        status: "complete",
        decodedMessage: {
          nonce: "0xnonce1",
          destinationDomain: "7",
          decodedMessageBody: { amount: "1000000", feeExecuted: "0" },
        },
      };

      const mockAttestation2: Attestation = {
        message: "0xmessage2",
        attestation: "0xattestation2",
        status: "complete",
        decodedMessage: {
          nonce: "0xnonce2",
          destinationDomain: "2",
          decodedMessageBody: { amount: "2000000", feeExecuted: "0" },
        },
      };

      global.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ messages: [mockAttestation1] }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ messages: [mockAttestation2] }),
        } as Response);

      const result = await retrieveAttestations([
        ["0xtxhash1", 1],
        ["0xtxhash2", 137],
      ]);

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual(mockAttestation1);
      expect(result[1]).toEqual(mockAttestation2);
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    test("retries on 404 and succeeds on second attempt", async () => {
      vi.useFakeTimers();

      const mockAttestation: Attestation = {
        message: "0xmessage",
        attestation: "0xattestation",
        status: "complete",
        decodedMessage: {
          nonce: "0xnonce1",
          destinationDomain: "7",
          decodedMessageBody: { amount: "1000000", feeExecuted: "0" },
        },
      };

      global.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 404,
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ messages: [mockAttestation] }),
        } as Response);

      const promise = retrieveAttestations([["0xtxhash", 1]]);

      // Fast-forward through first retry delay
      await vi.advanceTimersByTimeAsync(5000);

      const result = await promise;

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(mockAttestation);
      expect(global.fetch).toHaveBeenCalledTimes(2);

      vi.useRealTimers();
    });

    test("retries when attestation status is not complete", async () => {
      vi.useFakeTimers();

      const mockAttestationPending: Attestation = {
        message: "0xmessage",
        attestation: "0xattestation",
        status: "pending_confirmations",
        decodedMessage: {
          nonce: "0xnonce1",
          destinationDomain: "7",
          decodedMessageBody: { amount: "1000000", feeExecuted: "0" },
        },
      };

      const mockAttestationComplete: Attestation = {
        ...mockAttestationPending,
        status: "complete",
      };

      global.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ messages: [mockAttestationPending] }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ messages: [mockAttestationComplete] }),
        } as Response);

      const promise = retrieveAttestations([["0xtxhash", 1]]);

      // Fast-forward through retry delay
      await vi.advanceTimersByTimeAsync(5000);

      const result = await promise;

      expect(result).toHaveLength(1);
      expect(result[0].status).toBe("complete");
      expect(global.fetch).toHaveBeenCalledTimes(2);

      vi.useRealTimers();
    });

    test("throws error on non-404 API error", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
      } as Response);

      await expect(retrieveAttestations([["0xtxhash", 1]])).rejects.toThrow("Attestation retrieval failed");
    });

    test("throws error on fetch exception", async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error("Network error"));

      await expect(retrieveAttestations([["0xtxhash", 1]])).rejects.toThrow("Attestation retrieval failed");
    });
  });

  describe("getMintUsdcCalls", () => {
    test("returns mint calls for unused nonces", async () => {
      const mockAttestations: Attestation[] = [
        {
          message: "0xmessage1",
          attestation: "0xattestation1",
          status: "complete",
          decodedMessage: {
            nonce: "0xnonce1",
            destinationDomain: "0",
            decodedMessageBody: { amount: "1000000", feeExecuted: "0" },
          },
        },
        {
          message: "0xmessage2",
          attestation: "0xattestation2",
          status: "complete",
          decodedMessage: {
            nonce: "0xnonce2",
            destinationDomain: "0",
            decodedMessageBody: { amount: "2000000", feeExecuted: "0" },
          },
        },
      ];

      const mockPublicClient = {
        multicall: vi.fn().mockResolvedValue([{ result: 0n }, { result: 0n }]),
      } as unknown as PublicClient;

      vi.mocked(createPublicClient).mockReturnValue(mockPublicClient);

      const calls = await getMintUsdcCalls(1, mockAttestations);

      expect(calls).toHaveLength(2);
      expect(calls[0].to).toBe("0x81D40F21F12A8F0E3252Bccb954D722d4c464B64");
      expect(calls[1].to).toBe("0x81D40F21F12A8F0E3252Bccb954D722d4c464B64");
      expect(mockPublicClient.multicall).toHaveBeenCalledTimes(1);
    });

    test("filters out already used nonces", async () => {
      const mockAttestations: Attestation[] = [
        {
          message: "0xmessage1",
          attestation: "0xattestation1",
          status: "complete",
          decodedMessage: {
            nonce: "0xnonce1",
            destinationDomain: "0",
            decodedMessageBody: { amount: "1000000", feeExecuted: "0" },
          },
        },
        {
          message: "0xmessage2",
          attestation: "0xattestation2",
          status: "complete",
          decodedMessage: {
            nonce: "0xnonce2",
            destinationDomain: "0",
            decodedMessageBody: { amount: "2000000", feeExecuted: "0" },
          },
        },
      ];

      const mockPublicClient = {
        multicall: vi.fn().mockResolvedValue([
          { result: 1n }, // Used
          { result: 0n }, // Unused
        ]),
      } as unknown as PublicClient;

      vi.mocked(createPublicClient).mockReturnValue(mockPublicClient);

      const calls = await getMintUsdcCalls(1, mockAttestations);

      expect(calls).toHaveLength(1);
      expect(calls[0].data).toContain("receiveMessage");
    });

    test("returns empty array when all nonces are used", async () => {
      const mockAttestations: Attestation[] = [
        {
          message: "0xmessage1",
          attestation: "0xattestation1",
          status: "complete",
          decodedMessage: {
            nonce: "0xnonce1",
            destinationDomain: "0",
            decodedMessageBody: { amount: "1000000", feeExecuted: "0" },
          },
        },
      ];

      const mockPublicClient = {
        multicall: vi.fn().mockResolvedValue([{ result: 1n }]),
      } as unknown as PublicClient;

      vi.mocked(createPublicClient).mockReturnValue(mockPublicClient);

      const calls = await getMintUsdcCalls(1, mockAttestations);

      expect(calls).toHaveLength(0);
    });

    test("throws error for unsupported chain", async () => {
      const mockAttestations: Attestation[] = [
        {
          message: "0xmessage1",
          attestation: "0xattestation1",
          status: "complete",
          decodedMessage: {
            nonce: "0xnonce1",
            destinationDomain: "0",
            decodedMessageBody: { amount: "1000000", feeExecuted: "0" },
          },
        },
      ];

      await expect(getMintUsdcCalls(999, mockAttestations)).rejects.toThrow(
        "Chain 999 not supported or no transport configured",
      );
    });
  });

  describe("executeCCTPMint", () => {
    test("executes mint successfully with valid attestations", async () => {
      const mockAttestations: Attestation[] = [
        {
          message: "0xmessage",
          attestation: "0xattestation",
          status: "complete",
          decodedMessage: {
            nonce: "0xnonce1",
            destinationDomain: "0",
            decodedMessageBody: { amount: "1000000", feeExecuted: "0" },
          },
        },
      ];

      const tokenOut: TokenAmount = {
        token: USDC_ADDRESS,
        amount: 1000000n,
        chainId: 1,
        walletAddress: WALLET,
        symbol: "USDC",
        decimals: 6,
      };

      const mockPublicClient = {
        multicall: vi.fn().mockResolvedValue([{ result: 0n }]),
      } as unknown as PublicClient;

      vi.mocked(createPublicClient).mockReturnValue(mockPublicClient);

      const mockSendCalls = vi.fn().mockResolvedValue([
        "0xminthash",
        [
          [
            {
              address: "0x123" as Address,
              data: "0xdata" as Hex,
              topics: ["0xtopic" as Hex],
            },
          ],
        ],
      ]);

      const [txHash, logs] = await executeCCTPMint(mockAttestations, tokenOut, mockSendCalls);

      expect(txHash).toBe("0xminthash");
      expect(logs).toHaveLength(1);
      expect(logs[0]).toHaveLength(1);
      expect(mockSendCalls).toHaveBeenCalledWith("mint", 1, WALLET, expect.any(Array), "atomic-multicall");
    });

    test("throws error when no attestations provided", async () => {
      const tokenOut: TokenAmount = {
        token: USDC_ADDRESS,
        amount: 1000000n,
        chainId: 1,
        walletAddress: WALLET,
        symbol: "USDC",
        decimals: 6,
      };

      const mockSendCalls = vi.fn();

      await expect(executeCCTPMint([], tokenOut, mockSendCalls)).rejects.toThrow("No attestations");
      expect(mockSendCalls).not.toHaveBeenCalled();
    });

    test("returns empty result when all nonces are already used", async () => {
      const mockAttestations: Attestation[] = [
        {
          message: "0xmessage",
          attestation: "0xattestation",
          status: "complete",
          decodedMessage: {
            nonce: "0xnonce1",
            destinationDomain: "0",
            decodedMessageBody: { amount: "1000000", feeExecuted: "0" },
          },
        },
      ];

      const tokenOut: TokenAmount = {
        token: USDC_ADDRESS,
        amount: 1000000n,
        chainId: 1,
        walletAddress: WALLET,
        symbol: "USDC",
        decimals: 6,
      };

      const mockPublicClient = {
        multicall: vi.fn().mockResolvedValue([{ result: 1n }]), // Nonce already used
      } as unknown as PublicClient;

      vi.mocked(createPublicClient).mockReturnValue(mockPublicClient);

      const mockSendCalls = vi.fn();

      const [txHash, logs] = await executeCCTPMint(mockAttestations, tokenOut, mockSendCalls);

      expect(txHash).toBe("");
      expect(logs).toEqual([]);
      expect(mockSendCalls).not.toHaveBeenCalled();
    });

    test("handles multiple attestations with mixed used/unused nonces", async () => {
      const mockAttestations: Attestation[] = [
        {
          message: "0xmessage1",
          attestation: "0xattestation1",
          status: "complete",
          decodedMessage: {
            nonce: "0xnonce1",
            destinationDomain: "0",
            decodedMessageBody: { amount: "1000000", feeExecuted: "0" },
          },
        },
        {
          message: "0xmessage2",
          attestation: "0xattestation2",
          status: "complete",
          decodedMessage: {
            nonce: "0xnonce2",
            destinationDomain: "0",
            decodedMessageBody: { amount: "2000000", feeExecuted: "0" },
          },
        },
        {
          message: "0xmessage3",
          attestation: "0xattestation3",
          status: "complete",
          decodedMessage: {
            nonce: "0xnonce3",
            destinationDomain: "0",
            decodedMessageBody: { amount: "3000000", feeExecuted: "0" },
          },
        },
      ];

      const tokenOut: TokenAmount = {
        token: USDC_ADDRESS,
        amount: 6000000n,
        chainId: 1,
        walletAddress: WALLET,
        symbol: "USDC",
        decimals: 6,
      };

      const mockPublicClient = {
        multicall: vi.fn().mockResolvedValue([
          { result: 1n }, // Used
          { result: 0n }, // Unused
          { result: 1n }, // Used
        ]),
      } as unknown as PublicClient;

      vi.mocked(createPublicClient).mockReturnValue(mockPublicClient);

      const mockSendCalls = vi.fn().mockResolvedValue(["0xminthash", [[]]]);

      const [txHash, _logs] = await executeCCTPMint(mockAttestations, tokenOut, mockSendCalls);

      expect(txHash).toBe("0xminthash");
      expect(mockSendCalls).toHaveBeenCalledWith("mint", 1, WALLET, expect.any(Array), "atomic-multicall");

      // Verify only one call was made (for the unused nonce)
      const calls = mockSendCalls.mock.calls[0][3];
      expect(calls).toHaveLength(1);
    });
  });

  describe("edge cases and integration", () => {
    test("executeCCTPBurn handles large amounts correctly", async () => {
      const tokenIn: TokenAmount = {
        token: USDC_ADDRESS,
        amount: 999999999999999n, // Very large amount
        chainId: 1,
        walletAddress: WALLET,
        symbol: "USDC",
        decimals: 6,
      };

      const tokenOut: TokenAmount = {
        token: USDC_ADDRESS,
        amount: 0n,
        chainId: 137,
        walletAddress: WALLET,
        symbol: "USDC",
        decimals: 6,
      };

      const mockSendCalls = vi.fn().mockResolvedValue(["0xhash", []]);

      await executeCCTPBurn(tokenIn, tokenOut, mockSendCalls);

      expect(mockSendCalls).toHaveBeenCalledWith("burn", 1, WALLET, expect.any(Array), "atomic-steps");
    });
  });
});
