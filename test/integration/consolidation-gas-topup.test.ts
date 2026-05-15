import type { Account, Address, Chain, HttpTransport, WalletClient } from "viem";
import { parse, stringify } from "superjson";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { ConsolidationState, TokenAmount } from "../../app/lib/types";
import {
  USDC_ETHEREUM,
  USDC_OPTIMISM,
  USDC_POLYGON,
  WALLET,
  consumeGenerator,
  makeToken,
} from "../test-helpers";

// Mock external dependencies BEFORE imports
vi.mock("../../app/lib/odos");
vi.mock("../../app/lib/cctp");
vi.mock("../../app/lib/lifi");
vi.mock("../../app/lib/gas", () => ({
  getNativeBalance: vi.fn(),
  findRichestSource: vi.fn(),
}));
// The executor's `validateInputBalances` preflight (and planning's EIP-7702
// delegation probe) read on-chain state via the public client. This suite
// drives planning/execution with mocked quotes and the arbitrary test WALLET,
// which holds no real token balance, so stub the client: huge ERC20 balances
// (preflight always passes) and no contract code (WALLET treated as a plain EOA).
vi.mock("../../app/lib/public-client", () => ({
  getPublicClient: vi.fn(() => ({
    readContract: vi.fn().mockResolvedValue(2n ** 128n),
    getCode: vi.fn().mockResolvedValue(undefined),
  })),
  retryOnRateLimit: vi.fn(<T>(fn: () => Promise<T>) => fn()),
}));
vi.mock("../../app/lib/gas-estimation", async () => {
  const actual = await vi.importActual<typeof import("../../app/lib/gas-estimation")>(
    "../../app/lib/gas-estimation",
  );
  return {
    ...actual,
    buildGasContext: vi.fn().mockResolvedValue({
      maxFeePerGas: { 1: 20000000000n, 10: 1000000n, 137: 50000000000n, 8453: 1000000n, 42161: 100000000n },
      nativeTokenPriceUsd: { 1: 2000, 10: 2000, 137: 0.5, 8453: 2000, 42161: 2000 },
      nativeSymbol: { 1: "ETH", 10: "ETH", 137: "POL", 8453: "ETH", 42161: "ETH" },
    }),
    estimateChainGasCosts: vi.fn(),
    fetchMaxFeePerGas: vi.fn().mockResolvedValue(1000000n),
  };
});
vi.mock("viem/actions", () => ({
  estimateGas: vi.fn().mockResolvedValue(100000n),
  waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: "success" }),
}));

import { estimateGas, waitForTransactionReceipt } from "viem/actions";
import { executeCCTPBurn, executeCCTPMint, getBridgeFee, retrieveAttestations } from "../../app/lib/cctp";
import { executeConsolidationPlan } from "../../app/lib/execution";
import { findRichestSource, getNativeBalance } from "../../app/lib/gas";
import { estimateChainGasCosts } from "../../app/lib/gas-estimation";
import { getLiFiQuoteForTargetOutput, pollLiFiTransferStatus } from "../../app/lib/lifi";
import { executeOdosSwap, getSwapQuote } from "../../app/lib/odos";
import { planConsolidation } from "../../app/lib/planning";

const LIFI_DIAMOND = "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE" as Address;

function makeLiFiQuote(overrides: {
  fromChainId: number;
  toChainId: number;
  tool?: string;
  value?: string;
  data?: string;
  fromAmount?: string;
  toAmount?: string;
}) {
  const fromAmount = overrides.fromAmount ?? "1500000000000000";
  const toAmount = overrides.toAmount ?? "1400000000000000";
  return {
    tool: overrides.tool ?? "across",
    action: {
      fromChainId: overrides.fromChainId,
      toChainId: overrides.toChainId,
      fromToken: { symbol: "ETH", decimals: 18, priceUSD: "2000" },
      toToken: { symbol: "ETH", decimals: 18, priceUSD: "2000" },
    },
    estimate: {
      fromAmount,
      toAmount,
      toAmountMin: toAmount,
    },
    transactionRequest: {
      value: overrides.value ?? "0x5543DF729C000",
      to: LIFI_DIAMOND,
      data: (overrides.data ?? "0xabcdef") as `0x${string}`,
      from: WALLET,
      chainId: overrides.fromChainId,
    },
  };
}

describe("Gas Top-Up Integration: plan then execute", () => {
  let mockWalletClient: WalletClient<HttpTransport, Chain, Account>;

  beforeEach(() => {
    vi.clearAllMocks();

    mockWalletClient = {
      account: { address: WALLET } as Account,
      chain: { id: 8453 } as Chain,
      sendTransaction: vi.fn().mockResolvedValue("0xgastopuptx"),
      switchChain: vi.fn(),
      addChain: vi.fn(),
    } as unknown as WalletClient<HttpTransport, Chain, Account>;

    // --- Odos mocks (planning + execution) ---
    vi.mocked(getSwapQuote).mockImplementation(async (input, outputToken) => {
      const inputArray = Array.isArray(input) ? input : [input];
      const totalAmount = inputArray.reduce((sum, t) => sum + t.amount, 0n);
      return {
        token: outputToken.token,
        amount: totalAmount / 2n,
        chainId: outputToken.chainId,
        walletAddress: outputToken.walletAddress,
        symbol: "USDC",
        decimals: 6,
      };
    });

    vi.mocked(executeOdosSwap).mockImplementation(async (tokensIn) => {
      const totalAmount = tokensIn.reduce((sum, t) => sum + t.amount, 0n);
      return {
        amount: totalAmount / 2n,
        transactionHash: `0x${Math.random().toString(16).substring(2)}`,
      };
    });

    // --- CCTP mocks ---
    vi.mocked(getBridgeFee).mockResolvedValue(0n);
    vi.mocked(executeCCTPBurn).mockImplementation(async (tokenIn) => [
      `0x${Math.random().toString(16).substring(2)}`,
      tokenIn.chainId,
    ]);
    vi.mocked(retrieveAttestations).mockResolvedValue([
      {
        message: `0x${"00".repeat(32)}`,
        attestation: `0x${"00".repeat(65)}`,
        status: "complete",
        decodedMessage: {
          nonce: `0x${"00".repeat(32)}`,
          destinationDomain: "0",
          decodedMessageBody: { amount: "1000000", feeExecuted: "0" },
        },
      },
    ]);
    vi.mocked(executeCCTPMint).mockResolvedValue([`0x${Math.random().toString(16).substring(2)}`, []]);

    // --- LI.FI mocks ---
    vi.mocked(getLiFiQuoteForTargetOutput).mockImplementation(async (fromChainId, toChainId) =>
      makeLiFiQuote({ fromChainId, toChainId }),
    );
    vi.mocked(pollLiFiTransferStatus).mockResolvedValue({ status: "DONE", substatus: "COMPLETED" });

    // --- gas-estimation: small per-chain gas cost so destination wallet can cover (1 ETH default) ---
    vi.mocked(estimateChainGasCosts).mockResolvedValue({
      totalGasCost: 100_000_000_000_000n, // 0.0001 ETH
      maxFeePerGas: 20_000_000_000n,
      perOperation: [],
    });

    // --- viem/actions mocks ---
    vi.mocked(estimateGas).mockResolvedValue(100000n);
    vi.mocked(waitForTransactionReceipt).mockResolvedValue({ status: "success" } as never);
  });

  test("single chain needs gas top-up before consolidation (estimator-sized deficit)", async () => {
    // Optimism wallet has zero native (no gas), Base wallet (richest source) has plenty.
    // Destination wallet on Ethereum has plenty (so it's a viable funding candidate),
    // but the source-chain (10) gap still gets recorded.
    const DEFICIT_OPTIMISM = 5_000_000_000_000n; // 0.000005 ETH (above default budget tolerance)
    vi.mocked(getNativeBalance).mockImplementation(async (chain, address) => {
      if (chain.id === 10 && address === WALLET) return 0n;
      // Destination chain (Ethereum) wallet looks short too, so we fall back to richest.
      if (chain.id === 1 && address === WALLET) return 0n;
      return 0n;
    });
    vi.mocked(estimateChainGasCosts).mockImplementation(async (chainId) => {
      if (chainId === 10) {
        return { totalGasCost: DEFICIT_OPTIMISM, maxFeePerGas: 20_000_000_000n, perOperation: [] };
      }
      return { totalGasCost: 0n, maxFeePerGas: 20_000_000_000n, perOperation: [] };
    });
    vi.mocked(findRichestSource).mockResolvedValue({
      chainId: 8453,
      address: WALLET,
      balance: 10_000_000_000_000_000_000n,
    });

    // Make the LI.FI quote return a deposit close to the deficit so we can assert on it.
    vi.mocked(getLiFiQuoteForTargetOutput).mockResolvedValue(
      makeLiFiQuote({
        fromChainId: 8453,
        toChainId: 10,
        fromAmount: DEFICIT_OPTIMISM.toString(),
        toAmount: DEFICIT_OPTIMISM.toString(),
      }),
    );

    const sourceTokens: TokenAmount[] = [makeToken(USDC_OPTIMISM, 1000000n, 10, { walletAddress: WALLET })];
    const destinationToken = {
      token: USDC_ETHEREUM,
      chainId: 1,
      walletAddress: WALLET,
      symbol: "USDC",
      decimals: 6,
    };

    // --- Plan ---
    const plan = await planConsolidation(sourceTokens, destinationToken, [WALLET]);

    const types = plan.map((s) => s.type);
    expect(types).toContain("gas-topup");
    expect(types).toContain("gas-topup-wait");

    // gas-topup must be the very first step
    expect(plan[0].type).toBe("gas-topup");
    expect(plan[1].type).toBe("gas-topup-wait");

    const topupStep = plan[0];
    expect(topupStep.chainId).toBe(8453);
    expect(topupStep.gasTopUpDestinations).toHaveLength(1);
    expect(topupStep.gasTopUpDestinations![0].chainId).toBe(10);

    // The destination amount must equal the estimator deficit (no threshold * 3 multiplier).
    expect(BigInt(topupStep.gasTopUpDestinations![0].amountWei)).toBe(DEFICIT_OPTIMISM);

    // --- Execute ---
    const state: ConsolidationState = {
      id: "test-gas-topup-single",
      plan,
      currentStepIndex: 0,
      status: "ready",
      results: {},
      sourceTokens,
      destinationToken,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      hasSubsequentExecution: false,
    };

    const { finalValue: executedState } = await consumeGenerator(executeConsolidationPlan(state, mockWalletClient));

    expect(executedState.status).toBe("completed");
    for (const result of Object.values(executedState.results)) {
      expect(result.status).toBe("success");
    }

    expect(executedState.results["step-gas-topup"].transactionHash).toBe("0xgastopuptx");

    const transfers = executedState.metadata?.lifiTransfers;
    expect(transfers).toHaveLength(1);
    expect(transfers![0].txHash).toBe("0xgastopuptx");
    expect(transfers![0].fromChainId).toBe(8453);
    expect(transfers![0].toChainId).toBe(10);

    expect(pollLiFiTransferStatus).toHaveBeenCalledWith("0xgastopuptx", "across", 8453, 10);

    // State survives superjson round-trip
    const loaded: ConsolidationState = parse(stringify(executedState));
    expect(loaded.status).toBe("completed");
    expect(loaded.metadata?.lifiTransfers).toEqual(transfers);
  });

  test("two chains need gas top-up -- individual transactions, deposits sized per deficit", async () => {
    const DEFICIT_ETH = 1_000_000_000_000_000n; // 0.001 ETH
    const DEFICIT_POL = 2_000_000_000_000_000n; // 0.002 POL

    // Source chain (Ethereum) WALLET and Polygon WALLET both have 0 native; Base wallet
    // (richest source, also the destination chain) has plenty.
    vi.mocked(getNativeBalance).mockImplementation(async (chain, address) => {
      if (chain.id === 8453 && address === WALLET) return 10_000_000_000_000_000_000n;
      return 0n;
    });
    vi.mocked(estimateChainGasCosts).mockImplementation(async (chainId) => {
      if (chainId === 1) {
        return { totalGasCost: DEFICIT_ETH, maxFeePerGas: 20_000_000_000n, perOperation: [] };
      }
      if (chainId === 137) {
        return { totalGasCost: DEFICIT_POL, maxFeePerGas: 50_000_000_000n, perOperation: [] };
      }
      return { totalGasCost: 0n, maxFeePerGas: 1_000_000n, perOperation: [] };
    });
    vi.mocked(findRichestSource).mockResolvedValue({
      chainId: 8453,
      address: WALLET,
      balance: 10_000_000_000_000_000_000n,
    });

    const quoteEth = makeLiFiQuote({
      fromChainId: 8453,
      toChainId: 1,
      tool: "across",
      value: "0x100",
      data: "0xaaa",
      fromAmount: DEFICIT_ETH.toString(),
      toAmount: DEFICIT_ETH.toString(),
    });
    const quotePol = makeLiFiQuote({
      fromChainId: 8453,
      toChainId: 137,
      tool: "hop",
      value: "0x200",
      data: "0xbbb",
      fromAmount: DEFICIT_POL.toString(),
      toAmount: DEFICIT_POL.toString(),
    });

    // 4 calls total: 2 during planning + 2 during execution re-quote
    vi.mocked(getLiFiQuoteForTargetOutput)
      .mockResolvedValueOnce(quoteEth)
      .mockResolvedValueOnce(quotePol)
      .mockResolvedValueOnce(quoteEth)
      .mockResolvedValueOnce(quotePol);

    const sendTxMock = vi.fn().mockResolvedValueOnce("0xtx-eth").mockResolvedValueOnce("0xtx-pol");
    (mockWalletClient as unknown as { sendTransaction: typeof sendTxMock }).sendTransaction = sendTxMock;

    const sourceTokens: TokenAmount[] = [
      // ERC20-only source on each chain so the recorded deficit matches the
      // estimator output exactly (no native swap amount mixed in).
      makeToken(USDC_ETHEREUM, 1_000_000n, 1, { walletAddress: WALLET }),
      makeToken(USDC_POLYGON, 2_000_000n, 137, { walletAddress: WALLET }),
    ];
    const destinationToken = {
      token: USDC_ETHEREUM,
      chainId: 8453,
      walletAddress: WALLET,
      symbol: "USDC",
      decimals: 6,
    };

    // --- Plan ---
    const plan = await planConsolidation(sourceTokens, destinationToken, [WALLET]);

    expect(plan[0].type).toBe("gas-topup");
    expect(plan[0].gasTopUpDestinations).toHaveLength(2);
    const destChainIds = plan[0].gasTopUpDestinations!.map((d) => d.chainId).sort();
    expect(destChainIds).toEqual([1, 137]);

    // Each destination's amountWei must equal the per-chain estimator deficit (no threshold * 3).
    const ethDest = plan[0].gasTopUpDestinations!.find((d) => d.chainId === 1)!;
    const polDest = plan[0].gasTopUpDestinations!.find((d) => d.chainId === 137)!;
    expect(BigInt(ethDest.amountWei)).toBe(DEFICIT_ETH);
    expect(BigInt(polDest.amountWei)).toBe(DEFICIT_POL);

    // --- Execute ---
    const state: ConsolidationState = {
      id: "test-gas-topup-multi",
      plan,
      currentStepIndex: 0,
      status: "ready",
      results: {},
      sourceTokens,
      destinationToken,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      hasSubsequentExecution: false,
    };

    const { finalValue: executedState } = await consumeGenerator(executeConsolidationPlan(state, mockWalletClient));

    expect(executedState.status).toBe("completed");
    for (const result of Object.values(executedState.results)) {
      expect(result.status).toBe("success");
    }

    expect(sendTxMock).toHaveBeenCalledTimes(2);
    expect(sendTxMock.mock.calls[0][0].to).toBe(LIFI_DIAMOND);
    expect(sendTxMock.mock.calls[1][0].to).toBe(LIFI_DIAMOND);

    const transfers = executedState.metadata?.lifiTransfers;
    expect(transfers).toHaveLength(2);
    const transferTo = (toChainId: number) => transfers!.find((t) => t.toChainId === toChainId)!;
    expect(transferTo(1)).toMatchObject({ txHash: "0xtx-eth", bridge: "across", fromChainId: 8453 });
    expect(transferTo(137)).toMatchObject({ txHash: "0xtx-pol", bridge: "hop", fromChainId: 8453 });

    expect(pollLiFiTransferStatus).toHaveBeenCalledWith("0xtx-eth", "across", 8453, 1);
    expect(pollLiFiTransferStatus).toHaveBeenCalledWith("0xtx-pol", "hop", 8453, 137);
  });
});
