import {
  type Account,
  type Address,
  type Chain,
  encodeAbiParameters,
  encodeEventTopics,
  type HttpTransport,
  parseAbi,
  type WalletClient,
} from "viem";
import { describe, expect, test, vi } from "vitest";
import { USDC as tokenAddresses } from "../data/token-contracts";
import * as cctp from "./cctp";
import * as consolidation from "./consolidation";
import { ConsolidationStep, executeBridge, executeSwapOrTransfer, groupTokensByWalletAndChain } from "./consolidation";
import * as gas from "./gas";
import * as odos from "./odos";

// Helpers for executeBridge tests

const buildAttestations = (
  _tokenOut: { token: Address; walletAddress: Address },
  amounts: bigint[],
): cctp.Attestation[] => {
  return amounts.map((amount) => ({
    message: "0x01",
    attestation: "0x02",
    status: "complete",
    decodedMessage: {
      destinationDomain: "1",
      nonce: "0x00",
      decodedMessageBody: { amount: amount.toString(), feeExecuted: "0" },
    },
  }));
};

const buildMintLogs = (tokenOut: { token: Address; walletAddress: Address }, amounts: bigint[]) => {
  const eventAbi = parseAbi([
    "event MintAndWithdraw(address indexed mintRecipient, uint256 amount, address indexed mintToken, uint256 feeCollected)",
  ]);
  return amounts.map((amount) => {
    const topics = encodeEventTopics({
      abi: eventAbi,
      eventName: "MintAndWithdraw",
      args: { mintRecipient: tokenOut.walletAddress, mintToken: tokenOut.token },
    });
    const data = encodeAbiParameters(
      [
        { type: "uint256", name: "amount" },
        { type: "uint256", name: "feeCollected" },
      ],
      [amount, 0n],
    );
    return { address: tokenOut.token as Address, topics, data };
  });
};

const mockCCTPForBridge = (tokenOut: { token: Address; walletAddress: Address }, mintedAmounts: bigint[]) => {
  const burnMock = vi
    .spyOn(cctp, "executeCCTPBurn")
    .mockImplementation(async (token) => [`0xburn_${token.chainId}`, token.chainId]);
  const retrieveMock = vi
    .spyOn(cctp, "retrieveAttestations")
    .mockResolvedValue(buildAttestations(tokenOut, mintedAmounts));
  const mintLogs = buildMintLogs(tokenOut, mintedAmounts);
  const mintMock = vi
    .spyOn(cctp, "executeCCTPMint")
    .mockResolvedValue(["0xmint", mintLogs] as unknown as Awaited<ReturnType<typeof cctp.executeCCTPMint>>);
  const restore = () => {
    burnMock.mockRestore();
    retrieveMock.mockRestore();
    mintMock.mockRestore();
  };
  return { burnMock, retrieveMock, mintMock, restore };
};

describe("consolidation", () => {
  describe("groupTokensByWalletAndChain", () => {
    test("groups tokens by wallet and chain", () => {
      const tokens = [
        { token: "0x1" as Address, walletAddress: "0x2" as Address, chainId: 1, amount: 1n },
        { token: "0x3" as Address, walletAddress: "0x2" as Address, chainId: 1, amount: 2n },
        { token: "0x1" as Address, walletAddress: "0x2" as Address, chainId: 2, amount: 1n },
        { token: "0x1" as Address, walletAddress: "0x3" as Address, chainId: 2, amount: 2n },
      ];
      const grouped = groupTokensByWalletAndChain(tokens);
      expect(grouped).toEqual([
        [
          { token: "0x1", walletAddress: "0x2", chainId: 1, amount: 1n },
          { token: "0x3", walletAddress: "0x2", chainId: 1, amount: 2n },
        ],
        [{ token: "0x1", walletAddress: "0x2", chainId: 2, amount: 1n }],
        [{ token: "0x1", walletAddress: "0x3", chainId: 2, amount: 2n }],
      ]);
    });
    test("sums the amounts for the same token", () => {
      const tokens = [
        { token: "0x1" as Address, walletAddress: "0x2" as Address, chainId: 1, amount: 1n },
        { token: "0x1" as Address, walletAddress: "0x2" as Address, chainId: 1, amount: 2n },
      ];
      const grouped = groupTokensByWalletAndChain(tokens);
      expect(grouped).toEqual([[{ token: "0x1", walletAddress: "0x2", chainId: 1, amount: 3n }]]);
    });
  });

  describe("executeSwapOrTransfer", () => {
    test("forwards args, triggers progress, and returns updated amount", async () => {
      const tokens = [{ token: "0x1" as Address, walletAddress: "0x2" as Address, chainId: 1, amount: 1n }];
      const tokenOut = { token: "0x2" as Address, walletAddress: "0x3" as Address, chainId: 2, amount: 0n };
      const walletClient = {} as unknown as WalletClient<HttpTransport, Chain, Account>;

      const executeSpy = vi.spyOn(odos, "executeOdosSwapOrTransfer").mockResolvedValue(123n);
      const onProgress = vi.fn();

      const result = await executeSwapOrTransfer(tokens, tokenOut, walletClient, onProgress);

      expect(onProgress).toHaveBeenCalledWith(ConsolidationStep.SWAPPING);
      expect(executeSpy).toHaveBeenCalledWith(tokens, tokenOut, expect.any(Function));
      expect(result).toEqual({ ...tokenOut, amount: 123n });
    });
  });

  describe("executeBridge", () => {
    test("throws when a token is already on the destination chain", async () => {
      const destChainId = 1;
      const tokens = [
        {
          token: tokenAddresses[destChainId] as Address,
          walletAddress: "0x2" as Address,
          chainId: destChainId,
          amount: 1n,
        },
      ];
      const tokenOut = {
        token: tokenAddresses[destChainId] as Address,
        walletAddress: "0x0000000000000000000000000000000000000001" as Address,
        chainId: destChainId,
        amount: 0n,
      };

      await expect(
        executeBridge(tokens, tokenOut, {} as unknown as WalletClient<HttpTransport, Chain, Account>),
      ).rejects.toThrow("Tokens are already on the same chain");
    });

    test("throws when an input token is not USDC on its chain", async () => {
      const srcChainId = 10; // optimism
      const destChainId = 1; // mainnet
      const tokens = [
        {
          token: "0x0000000000000000000000000000000000000000" as Address,
          walletAddress: "0x2" as Address,
          chainId: srcChainId,
          amount: 1n,
        },
      ];
      const tokenOut = {
        token: tokenAddresses[destChainId] as Address,
        walletAddress: "0x0000000000000000000000000000000000000001" as Address,
        chainId: destChainId,
        amount: 0n,
      };

      await expect(
        executeBridge(tokens, tokenOut, {} as unknown as WalletClient<HttpTransport, Chain, Account>),
      ).rejects.toThrow(`Token 0x0000000000000000000000000000000000000000 on chain ${srcChainId} is not USDC`);
    });

    test("throws when output token is not USDC on destination chain", async () => {
      const srcChainId = 10;
      const destChainId = 1;
      const tokens = [
        {
          token: tokenAddresses[srcChainId] as Address,
          walletAddress: "0x2" as Address,
          chainId: srcChainId,
          amount: 1n,
        },
      ];
      const tokenOut = {
        token: "0x0000000000000000000000000000000000000000" as Address,
        walletAddress: "0x3" as Address,
        chainId: destChainId,
        amount: 0n,
      };

      await expect(
        executeBridge(tokens, tokenOut, {} as unknown as WalletClient<HttpTransport, Chain, Account>),
      ).rejects.toThrow(`Token 0x0000000000000000000000000000000000000000 on chain ${destChainId} is not USDC`);
    });

    test("returns tokenOut unchanged when no inputs", async () => {
      const destChainId = 1;
      const tokenOut = {
        token: tokenAddresses[destChainId] as Address,
        walletAddress: "0x3" as Address,
        chainId: destChainId,
        amount: 42n,
      };

      const result = await executeBridge([], tokenOut, {} as unknown as WalletClient<HttpTransport, Chain, Account>);
      expect(result).toEqual(tokenOut);
    });

    test("bridges tokens, reports progress, and aggregates minted amount", async () => {
      const srcChainIdA = 10; // optimism
      const srcChainIdB = 42161; // arbitrum
      const destChainId = 1; // mainnet
      const tokens = [
        {
          token: tokenAddresses[srcChainIdA] as Address,
          walletAddress: "0x2" as Address,
          chainId: srcChainIdA,
          amount: 5n,
        },
        {
          token: tokenAddresses[srcChainIdB] as Address,
          walletAddress: "0x2" as Address,
          chainId: srcChainIdB,
          amount: 7n,
        },
      ];
      const tokenOut = {
        token: tokenAddresses[destChainId] as Address,
        walletAddress: "0x0000000000000000000000000000000000000001" as Address,
        chainId: destChainId,
        amount: 0n,
      };

      const { burnMock, retrieveMock, mintMock, restore } = mockCCTPForBridge(tokenOut, [50n, 70n]);

      const onProgress = vi.fn();
      const walletClient = {
        switchChain: vi.fn().mockResolvedValue(undefined),
        addChain: vi.fn().mockResolvedValue(undefined),
        sendCalls: vi.fn().mockResolvedValue({ id: "test-id" }),
        waitForCallsStatus: vi.fn().mockResolvedValue({ status: "success", receipts: [] }),
      } as unknown as WalletClient<HttpTransport, Chain, Account>;

      const result = await executeBridge(tokens, tokenOut, walletClient, onProgress);

      expect(onProgress.mock.calls.map((c) => c[0])).toEqual([
        ConsolidationStep.BURNING,
        ConsolidationStep.WAITING_ATTESTATION,
        ConsolidationStep.MINTING,
      ]);

      expect(burnMock).toHaveBeenCalledTimes(2);
      expect(burnMock).toHaveBeenNthCalledWith(1, tokens[0], tokenOut, expect.any(Function));
      expect(burnMock).toHaveBeenNthCalledWith(2, tokens[1], tokenOut, expect.any(Function));

      expect(retrieveMock).toHaveBeenCalledWith([
        ["0xburn_10", 10],
        ["0xburn_42161", 42161],
      ]);
      expect(mintMock).toHaveBeenCalledWith(buildAttestations(tokenOut, [50n, 70n]), tokenOut, expect.any(Function));
      expect(result).toEqual({ ...tokenOut, amount: 120n });

      restore();
    });
  });
  describe("executeConsolidation", () => {
    test("bridges tokens, reports progress, and aggregates minted amount", async () => {
      const srcChainIdA = 10; // optimism
      const srcChainIdB = 42161; // arbitrum
      const destChainId = 1; // mainnet

      const sourceTokens = [
        // Off-destination chain group A (wallet W1 on chain 10)
        {
          token: "0xA" as Address,
          walletAddress: "0x00000000000000000000000000000000000000a1" as Address,
          chainId: srcChainIdA,
          amount: 2n,
        },
        {
          token: "0xB" as Address,
          walletAddress: "0x00000000000000000000000000000000000000a1" as Address,
          chainId: srcChainIdA,
          amount: 3n,
        },
        // Off-destination chain group B (wallet W2 on chain 42161)
        {
          token: "0xC" as Address,
          walletAddress: "0x00000000000000000000000000000000000000a2" as Address,
          chainId: srcChainIdB,
          amount: 7n,
        },
        // Already on destination chain (wallet W3 on chain 1)
        {
          token: "0xD" as Address,
          walletAddress: "0x00000000000000000000000000000000000000a3" as Address,
          chainId: destChainId,
          amount: 11n,
        },
        {
          token: "0xE" as Address,
          walletAddress: "0x00000000000000000000000000000000000000a3" as Address,
          chainId: destChainId,
          amount: 13n,
        },
      ];

      const destinationToken = {
        token: "0xDEST" as Address,
        walletAddress: "0x00000000000000000000000000000000000000b0" as Address,
        chainId: destChainId,
        amount: 0n,
      };

      const sendTo = "0x00000000000000000000000000000000000000c0" as Address;
      const walletClient = {} as unknown as WalletClient<HttpTransport, Chain, Account>;

      const ensureGasMock = vi.spyOn(gas, "ensureSufficientGas").mockResolvedValue();

      // Let executeSwapOrTransfer run, but mock Odos execution to avoid network
      const odosSpy = vi
        .spyOn(odos, "executeOdosSwapOrTransfer")
        .mockImplementation(async (tokensIn) => tokensIn.reduce((acc, t) => acc + t.amount, 0n));

      // Mock CCTP internals used by executeBridge to avoid real send-calls
      const usdcDestTokenOut = {
        token: tokenAddresses[destChainId] as Address,
        walletAddress: destinationToken.walletAddress,
        chainId: destChainId,
        amount: 0n,
      };
      const { restore } = mockCCTPForBridge(usdcDestTokenOut, [5n, 7n]);

      const setCurrentStep = vi.fn();

      const result = await consolidation.executeConsolidation({
        sourceTokens,
        destinationToken,
        sendTo,
        walletClient,
        setCurrentStep,
      });

      // ensure gas was checked
      expect(ensureGasMock).toHaveBeenCalledWith(sourceTokens, destinationToken);

      // Odos execution should be called for two pre-bridge and two post-bridge swaps
      expect(odosSpy).toHaveBeenCalledTimes(4);

      // Progress sequence: two SWAPPING, bridge steps, two SWAPPING_BACK, COMPLETED
      expect(setCurrentStep.mock.calls.map((c) => c[0])).toEqual([
        ConsolidationStep.SWAPPING,
        ConsolidationStep.SWAPPING,
        ConsolidationStep.BURNING,
        ConsolidationStep.WAITING_ATTESTATION,
        ConsolidationStep.MINTING,
        ConsolidationStep.SWAPPING_BACK,
        ConsolidationStep.SWAPPING_BACK,
        ConsolidationStep.COMPLETED,
      ]);

      // Final amount = (11 + 13) from dest chain group + ((2 + 3) from bridged group A + (7) from bridged group B)
      expect(result).toEqual({ ...destinationToken, amount: 36n, walletAddress: sendTo });

      ensureGasMock.mockRestore();
      odosSpy.mockRestore();
      restore();
    });
  });
});
