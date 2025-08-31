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
import { ConsolidationStep, executeBridge, executeSwapOrTransfer, groupTokensByWalletAndChain } from "./consolidation";
import * as odos from "./odos";

// Helpers for executeBridge tests
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
    .mockResolvedValue([{ attestation: "ok" }] as unknown as Awaited<ReturnType<typeof cctp.retrieveAttestations>>);
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
    const walletClient = {} as unknown as WalletClient<HttpTransport, Chain, Account>;

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
    expect(mintMock).toHaveBeenCalledWith([{ attestation: "ok" }], tokenOut, expect.any(Function));
    expect(result).toEqual({ ...tokenOut, amount: 120n });

    restore();
  });
});
