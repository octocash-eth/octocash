import { parse, stringify } from "superjson";
import type { Account, Address, Chain, HttpTransport, WalletClient } from "viem";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { ConsolidationState, TokenAmount, TransactionStep } from "../../app/lib/types";
import { consumeGenerator, makeToken, USDC_ETHEREUM, USDC_OPTIMISM, USDC_POLYGON, WALLET } from "../test-helpers";

// Mock external dependencies BEFORE imports
vi.mock("../../app/lib/delora");
vi.mock("../../app/lib/cctp");
vi.mock("../../app/lib/gas-refuel");
vi.mock("../../app/lib/gas", () => ({
  getNativeBalance: vi.fn(),
}));
vi.mock("../../app/lib/api/delora", () => ({
  fetchDeloraPrices: vi.fn().mockResolvedValue(new Map()),
  deloraPriceKey: (chainId: number, address: string) => `${chainId}:${address.toLowerCase()}`,
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
  const actual = await vi.importActual<typeof import("../../app/lib/gas-estimation")>("../../app/lib/gas-estimation");
  const estimateChainGasCosts = vi.fn();
  return {
    ...actual,
    buildGasContext: vi.fn().mockResolvedValue({
      maxFeePerGas: { 1: 20000000000n, 10: 1000000n, 137: 50000000000n, 8453: 1000000n, 42161: 100000000n },
      nativeTokenPriceUsd: { 1: 2000, 10: 2000, 137: 0.5, 8453: 2000, 42161: 2000 },
      nativeSymbol: { 1: "ETH", 10: "ETH", 137: "POL", 8453: "ETH", 42161: "ETH" },
    }),
    estimateChainGasCosts,
    measureOpsGas: vi.fn().mockResolvedValue(0n),
    // Per-step estimates derive from the per-chain estimateChainGasCosts mock
    // so each test's deficit setup flows into reconcileGasGaps unchanged.
    attachGasEstimates: vi.fn(async (steps: TransactionStep[]) => {
      for (const step of steps) {
        if (step.type === "attestation" || step.type === "gas-topup-wait") continue;
        const { totalGasCost } = await estimateChainGasCosts(step.chainId, []);
        step.estimatedGas = {
          gasUnits: 0n,
          maxFeePerGas: 0n,
          gasCostWei: totalGasCost,
          nativeSymbol: "ETH",
          source: "budget",
        };
      }
    }),
    fetchMaxFeePerGas: vi.fn().mockResolvedValue(1000000n),
  };
});
vi.mock("viem/actions", () => ({
  estimateGas: vi.fn().mockResolvedValue(100000n),
  waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: "success" }),
}));

import { estimateGas, waitForTransactionReceipt } from "viem/actions";
import { executeCCTPBurn, executeCCTPMint, getBridgeFee, retrieveAttestations } from "../../app/lib/cctp";
import { executeDeloraSwap, getSwapQuote, getSwapQuoteWithLegs } from "../../app/lib/delora";
import { executeConsolidationPlan } from "../../app/lib/execution";
import { getNativeBalance } from "../../app/lib/gas";
import { estimateChainGasCosts } from "../../app/lib/gas-estimation";
import { getGasRefuelQuote, waitForRefuelDelivery } from "../../app/lib/gas-refuel";
import { planConsolidation } from "../../app/lib/planning";

const GASZIP_DEPOSIT = "0x391E7C679d29bD940d63be94AD22A25d25b5A604" as Address;

function makeRefuelQuote(overrides: {
  fromChainId: number;
  toChainId: number;
  provider?: "gaszip" | "delora";
  value?: bigint;
  data?: string;
  depositWei?: bigint;
  expectedWei?: bigint;
}) {
  const depositWei = overrides.depositWei ?? 1500000000000000n;
  const expectedWei = overrides.expectedWei ?? 1400000000000000n;
  return {
    provider: overrides.provider ?? ("gaszip" as const),
    fromChainId: overrides.fromChainId,
    toChainId: overrides.toChainId,
    depositWei,
    expectedWei,
    minDeliveredWei: expectedWei,
    tx: {
      to: GASZIP_DEPOSIT,
      data: (overrides.data ?? "0xabcdef") as `0x${string}`,
      value: overrides.value ?? depositWei,
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

    // --- Delora mocks (planning + execution) ---
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
    // Planning consumes the legs variant; delegate to the amount-only mock.
    vi.mocked(getSwapQuoteWithLegs).mockImplementation(async (input, outputToken) => ({
      output: await getSwapQuote(input, outputToken),
      legs: [],
    }));

    vi.mocked(executeDeloraSwap).mockImplementation(async (tokensIn) => {
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

    // --- Gas refuel mocks ---
    vi.mocked(getGasRefuelQuote).mockImplementation(async (fromChainId, toChainId) =>
      makeRefuelQuote({ fromChainId, toChainId }),
    );
    vi.mocked(waitForRefuelDelivery).mockResolvedValue(undefined);

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
    // Optimism wallet has zero native (no gas), destination wallet on Ethereum
    // also has zero (so it can't fund itself), Base wallet has plenty so it
    // wins the richest-source fallback.
    const DEFICIT_OPTIMISM = 5_000_000_000_000n; // 0.000005 ETH (above default budget tolerance)
    vi.mocked(getNativeBalance).mockImplementation(async (chain, address) => {
      if (chain.id === 8453 && address === WALLET) return 10_000_000_000_000_000_000n;
      return 0n;
    });
    vi.mocked(estimateChainGasCosts).mockImplementation(async (chainId) => {
      if (chainId === 10) {
        return { totalGasCost: DEFICIT_OPTIMISM, maxFeePerGas: 20_000_000_000n, perOperation: [] };
      }
      return { totalGasCost: 0n, maxFeePerGas: 20_000_000_000n, perOperation: [] };
    });

    // Make the refuel quote return a deposit close to the deficit so we can assert on it.
    vi.mocked(getGasRefuelQuote).mockResolvedValue(
      makeRefuelQuote({
        fromChainId: 8453,
        toChainId: 10,
        depositWei: DEFICIT_OPTIMISM,
        expectedWei: DEFICIT_OPTIMISM,
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
    expect(topupStep.gasTopUpDestinations?.[0].chainId).toBe(10);

    // The destination amount must equal the estimator deficit (no threshold * 3 multiplier).
    expect(BigInt(topupStep.gasTopUpDestinations?.[0].amountWei ?? "0")).toBe(DEFICIT_OPTIMISM);

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
    };

    const { finalValue: executedState } = await consumeGenerator(executeConsolidationPlan(state, mockWalletClient));

    expect(executedState.status).toBe("completed");
    for (const result of Object.values(executedState.results)) {
      expect(result.status).toBe("success");
    }

    expect(executedState.results["step-gas-topup"].transactionHash).toBe("0xgastopuptx");

    const refuels = executedState.metadata?.gasRefuels;
    expect(refuels).toHaveLength(1);
    expect(refuels?.[0]).toMatchObject({
      provider: "gaszip",
      txHash: "0xgastopuptx",
      fromChainId: 8453,
      toChainId: 10,
      toAddress: WALLET,
      baselineWei: "0",
      minDeliveredWei: DEFICIT_OPTIMISM.toString(),
    });

    expect(waitForRefuelDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ txHash: "0xgastopuptx", fromChainId: 8453, toChainId: 10 }),
      undefined,
      undefined,
      expect.any(Function),
    );

    // State survives superjson round-trip
    const loaded: ConsolidationState = parse(stringify(executedState));
    expect(loaded.status).toBe("completed");
    expect(loaded.metadata?.gasRefuels).toEqual(refuels);
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
    const quoteEth = makeRefuelQuote({
      fromChainId: 8453,
      toChainId: 1,
      value: 256n,
      data: "0xaaa",
      depositWei: DEFICIT_ETH,
      expectedWei: DEFICIT_ETH,
    });
    const quotePol = makeRefuelQuote({
      fromChainId: 8453,
      toChainId: 137,
      provider: "delora",
      value: 512n,
      data: "0xbbb",
      depositWei: DEFICIT_POL,
      expectedWei: DEFICIT_POL,
    });

    // 4 calls total: 2 during planning + 2 during execution re-quote
    vi.mocked(getGasRefuelQuote)
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
    const destChainIds = plan[0].gasTopUpDestinations?.map((d) => d.chainId).sort();
    expect(destChainIds).toEqual([1, 137]);

    // Each destination's amountWei must equal the per-chain estimator deficit (no threshold * 3).
    const ethDest = plan[0].gasTopUpDestinations?.find((d) => d.chainId === 1);
    const polDest = plan[0].gasTopUpDestinations?.find((d) => d.chainId === 137);
    expect(BigInt(ethDest?.amountWei ?? "0")).toBe(DEFICIT_ETH);
    expect(BigInt(polDest?.amountWei ?? "0")).toBe(DEFICIT_POL);

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
    };

    const { finalValue: executedState } = await consumeGenerator(executeConsolidationPlan(state, mockWalletClient));

    expect(executedState.status).toBe("completed");
    for (const result of Object.values(executedState.results)) {
      expect(result.status).toBe("success");
    }

    expect(sendTxMock).toHaveBeenCalledTimes(2);
    expect(sendTxMock.mock.calls[0][0].to).toBe(GASZIP_DEPOSIT);
    expect(sendTxMock.mock.calls[1][0].to).toBe(GASZIP_DEPOSIT);

    const refuels = executedState.metadata?.gasRefuels;
    expect(refuels).toHaveLength(2);
    const refuelTo = (toChainId: number) => refuels?.find((r) => r.toChainId === toChainId);
    expect(refuelTo(1)).toMatchObject({ txHash: "0xtx-eth", provider: "gaszip", fromChainId: 8453 });
    expect(refuelTo(137)).toMatchObject({ txHash: "0xtx-pol", provider: "delora", fromChainId: 8453 });

    expect(waitForRefuelDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ txHash: "0xtx-eth", toChainId: 1 }),
      undefined,
      undefined,
      expect.any(Function),
    );
    expect(waitForRefuelDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ txHash: "0xtx-pol", toChainId: 137 }),
      undefined,
      undefined,
      expect.any(Function),
    );
  });

  test("forwards refuel delivery progress via opts.onStepProgress without persisting it", async () => {
    const DEFICIT_OPTIMISM = 5_000_000_000_000n;
    vi.mocked(getNativeBalance).mockImplementation(async (chain, address) => {
      if (chain.id === 8453 && address === WALLET) return 10_000_000_000_000_000_000n;
      return 0n;
    });
    vi.mocked(estimateChainGasCosts).mockImplementation(async (chainId) =>
      chainId === 10
        ? { totalGasCost: DEFICIT_OPTIMISM, maxFeePerGas: 20_000_000_000n, perOperation: [] }
        : { totalGasCost: 0n, maxFeePerGas: 20_000_000_000n, perOperation: [] },
    );
    vi.mocked(getGasRefuelQuote).mockResolvedValue(
      makeRefuelQuote({
        fromChainId: 8453,
        toChainId: 10,
        depositWei: DEFICIT_OPTIMISM,
        expectedWei: DEFICIT_OPTIMISM,
      }),
    );

    // Drive one pending progress event, then resolve delivered.
    vi.mocked(waitForRefuelDelivery).mockImplementation(async (_refuel, _timeout, _interval, onProgress) => {
      onProgress?.(false);
      onProgress?.(true);
    });

    const sourceTokens: TokenAmount[] = [makeToken(USDC_OPTIMISM, 1000000n, 10, { walletAddress: WALLET })];
    const destinationToken = { token: USDC_ETHEREUM, chainId: 1, walletAddress: WALLET, symbol: "USDC", decimals: 6 };

    const plan = await planConsolidation(sourceTokens, destinationToken, [WALLET]);
    const waitStepId = plan.find((s) => s.type === "gas-topup-wait")?.id;
    expect(waitStepId).toBeDefined();

    const state: ConsolidationState = {
      id: "test-gas-topup-progress",
      plan,
      currentStepIndex: 0,
      status: "ready",
      results: {},
      sourceTokens,
      destinationToken,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const events: unknown[] = [];
    const { finalValue: executedState } = await consumeGenerator(
      executeConsolidationPlan(state, mockWalletClient, { onStepProgress: (e) => events.push(e) }),
    );

    expect(executedState.status).toBe("completed");
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "refuel",
        stepId: waitStepId,
        delivered: false,
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "refuel",
        stepId: waitStepId,
        delivered: true,
      }),
    );
    // Progress is display-only — it must never leak into persisted state.
    expect(stringify(executedState)).not.toContain('"delivered"');
  });
});
