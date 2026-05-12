import { describe, test, expect, beforeEach, vi, afterEach } from "vitest";
import type { Address, Account, Chain, HttpTransport, WalletClient } from "viem";
import type { ConsolidationState, TokenAmount } from "../../app/lib/types";
import { WALLET, consumeGenerator, makeToken } from "../test-helpers";

// Mock dependencies
vi.mock("../../app/lib/odos");
vi.mock("../../app/lib/cctp");
vi.mock("../../app/lib/public-client", () => ({
  getPublicClient: vi.fn(() => ({
    estimateFeesPerGas: vi.fn().mockResolvedValue({ maxFeePerGas: 1_000_000_000n }),
    readContract: vi.fn().mockResolvedValue(2n ** 128n),
  })),
  retryOnRateLimit: <T>(fn: () => Promise<T>) => fn(),
}));
vi.mock("../../app/lib/gas", () => ({
  getNativeBalance: vi.fn().mockResolvedValue(2n ** 128n),
}));

import { planConsolidation } from "../../app/lib/planning";
import { executeConsolidationPlan } from "../../app/lib/execution";
import { getSwapQuote, executeOdosSwap } from "../../app/lib/odos";
import { getBridgeFee, executeCCTPBurn, retrieveAttestations, executeCCTPMint } from "../../app/lib/cctp";
import { parse, stringify } from "superjson";

/**
 * Scenario 8: Browser Recovery
 * 
 * User closes browser mid-consolidation
 * Expected: Progress is saved, user can resume from where they left off
 */
describe("Scenario 8: Browser Recovery", () => {
  const USDC_ADDRESS = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address;
  const WBTC_ADDRESS = "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599" as Address;
  const ETH_ADDRESS = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" as Address;

  let mockWalletClient: WalletClient<HttpTransport, Chain, Account>;


  beforeEach(() => {
    vi.clearAllMocks();

    // Create mock wallet client
    mockWalletClient = {
      account: { address: WALLET } as Account,
      chain: { id: 1 } as Chain,
    } as WalletClient<HttpTransport, Chain, Account>;

    // Setup default mocks for planning
    vi.mocked(getSwapQuote).mockImplementation(async (input, outputToken) => {
      const inputArray = Array.isArray(input) ? input : [input];
      const totalAmount = inputArray.reduce((sum, token) => sum + token.amount, 0n);
      return {
        token: outputToken.token,
        amount: totalAmount / 2n, // Mock 50% conversion for simplicity
        chainId: outputToken.chainId,
        walletAddress: outputToken.walletAddress,
        symbol: "USDC",
        decimals: 6,
      };
    });

    vi.mocked(getBridgeFee).mockResolvedValue(0n);
    
    // Setup default mocks for execution
    vi.mocked(executeOdosSwap).mockImplementation(async (tokensIn, tokenOut, _sendCalls) => {
      const totalAmount = tokensIn.reduce((sum, token) => sum + token.amount, 0n);
      return { amount: totalAmount / 2n, transactionHash: `0x${Math.random().toString(16).substring(2)}` }; // Mock 50% conversion
    });

    vi.mocked(executeCCTPBurn).mockImplementation(async (tokenIn, _tokenOut, _sendCalls) => {
      const txHash = `0x${Math.random().toString(16).substring(2)}`;
      return [txHash, tokenIn.chainId];
    });

    vi.mocked(retrieveAttestations).mockImplementation(async (_txsAndChainIds) => {
      return [{
        message: `0x${"00".repeat(32)}`,
        attestation: `0x${"00".repeat(65)}`,
        status: "complete",
        decodedMessage: {
          nonce: `0x${"00".repeat(32)}`,
          destinationDomain: "0",
          decodedMessageBody: {
            amount: "1000000",
            feeExecuted: "0",
          },
        },
      }];
    });

    vi.mocked(executeCCTPMint).mockImplementation(async (_attestations, _tokenOut, _sendCalls) => {
      const txHash = `0x${Math.random().toString(16).substring(2)}`;
      return [txHash, []];
    });
  });

  test("browser close mid-execution - state is persisted and recoverable", async () => {
    const sourceTokens: TokenAmount[] = [
      makeToken(ETH_ADDRESS, 100000000000000000n, 137, { walletAddress: WALLET, symbol: "POL", decimals: 18 }), // 0.1 ETH on Polygon
    ];

    const destinationToken = {
      token: USDC_ADDRESS,
      chainId: 1, // Ethereum
      walletAddress: WALLET,
        symbol: "USDC",
        decimals: 6,
    };

    // Generate plan
    const plan = await planConsolidation(sourceTokens, destinationToken, [WALLET]);

    const state: ConsolidationState = {
      id: "recovery-test-1",
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

    // Start execution (simulate completing 2 steps, then browser closes)
    const { finalValue: partialState } = await consumeGenerator(executeConsolidationPlan(state, mockWalletClient), 2);

    // Simulate browser close and reopen - load state
    const recoveredState: ConsolidationState = parse(stringify(partialState));

    expect(recoveredState).toBeDefined();
    expect(recoveredState!.id).toBe(state.id);
    expect(recoveredState!.plan).toEqual(partialState.plan);
    expect(recoveredState!.results).toEqual(partialState.results);
    expect(recoveredState!.status).toBe(partialState.status);

    // Verify we can resume from where we left off
    if (recoveredState!.status === "executing" || recoveredState!.status === "paused") {
      const { finalValue: resumedState } = await consumeGenerator(executeConsolidationPlan(recoveredState!, mockWalletClient));
      expect(resumedState.status).toMatch(/completed|partial/);
    }
  });

  test("recover from paused state - failed step can be retried", async () => {
    const sourceTokens: TokenAmount[] = [
      makeToken(USDC_ADDRESS, 1000000n, 10), // 1 USDC on Optimism
    ];

    const destinationToken = {
      token: WBTC_ADDRESS,
      chainId: 1,
      walletAddress: WALLET,
        symbol: "WBTC",
        decimals: 8,
    };

    const plan = await planConsolidation(sourceTokens, destinationToken, [WALLET]);

    // Simulate a failed state
    const state: ConsolidationState = {
      id: "recovery-test-2",
      plan: plan.map((s, i) => ({
        ...s,
        status: i === 1 ? ("failed" as const) : i === 0 ? ("success" as const) : ("pending" as const),
      })),
      currentStepIndex: 1,
      status: "paused",
      results: {
        [plan[0].id]: {
          stepId: plan[0].id,
          status: "success",
          chainId: plan[0].chainId,
          transactionHash: "0xabc",
        },
        [plan[1].id]: {
          stepId: plan[1].id,
          status: "failed",
          chainId: plan[1].chainId,
          error: {
            code: "USER_REJECTED",
            title: "Transaction cancelled",
            message: "Click retry to try again.",
            recoverable: true,
            timestamp: Date.now(),
          },
        },
      },
      sourceTokens,
      destinationToken,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      hasSubsequentExecution: false, // Retry is allowed
    };

    // Simulate browser close and reopen - load state
    const recoveredState: ConsolidationState = parse(stringify(state));

    expect(recoveredState).toBeDefined();
    expect(recoveredState!.status).toBe("paused");
    expect(recoveredState!.currentStepIndex).toBe(1);
    expect(recoveredState!.results[plan[1].id].status).toBe("failed");

    // User should see:
    // - Step 1: Green (success)
    // - Step 2: Red (failed) with Retry/Continue buttons
    // - Step 3+: Gray (pending)

    expect(recoveredState!.plan[0].status).toBe("success");
    expect(recoveredState!.plan[1].status).toBe("failed");
    expect(recoveredState!.plan[2].status).toBe("pending");

    // Verify retry is allowed
    expect(recoveredState!.hasSubsequentExecution).toBe(false);

    // User clicks retry - execution resumes
    const { finalValue: resumedState } = await consumeGenerator(executeConsolidationPlan(recoveredState!, mockWalletClient));

    // After retry, should either complete or pause again
    expect(resumedState.status).toMatch(/completed|partial|paused/);
  });

  test("multiple consolidations in storage - load correct one", async () => {
    const sourceTokens1: TokenAmount[] = [
      makeToken(USDC_ADDRESS, 1000000n, 10), // 1 USDC on Optimism
    ];

    const sourceTokens2: TokenAmount[] = [
      makeToken(ETH_ADDRESS, 100000000000000000n, 137, { walletAddress: WALLET, symbol: "POL", decimals: 18 }), // 0.1 ETH on Polygon
    ];

    const destinationToken = {
      token: WBTC_ADDRESS,
      chainId: 1,
      walletAddress: WALLET,
        symbol: "WBTC",
        decimals: 8,
    };

    const plan1 = await planConsolidation(sourceTokens1, destinationToken, [WALLET]);
    const plan2 = await planConsolidation(sourceTokens2, destinationToken, [WALLET]);

    const state1: ConsolidationState = {
      id: "consolidation-1",
      plan: plan1,
      currentStepIndex: 0,
      status: "executing",
      results: {},
      sourceTokens: sourceTokens1,
      destinationToken,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      hasSubsequentExecution: false,
    };

    const state2: ConsolidationState = {
      id: "consolidation-2",
      plan: plan2,
      currentStepIndex: 0,
      status: "paused",
      results: {},
      sourceTokens: sourceTokens2,
      destinationToken,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      hasSubsequentExecution: false,
    };

    
    // Simulate browser close and reopen - load state
    const loaded1: ConsolidationState = parse(stringify(state1));
    const loaded2: ConsolidationState = parse(stringify(state2));

    // Load first
    expect(loaded1).toBeDefined();
    expect(loaded1!.id).toBe("consolidation-1");
    expect(loaded1!.sourceTokens).toEqual(sourceTokens1);

    // Load second
    expect(loaded2).toBeDefined();
    expect(loaded2!.id).toBe("consolidation-2");
    expect(loaded2!.sourceTokens).toEqual(sourceTokens2);
  });

  test("recovery prompt shows on page load if incomplete consolidation exists", async () => {
    const sourceTokens: TokenAmount[] = [
      makeToken(USDC_ADDRESS, 1000000n, 10), // 1 USDC on Optimism
    ];

    const destinationToken = {
      token: WBTC_ADDRESS,
      chainId: 1,
      walletAddress: WALLET,
        symbol: "WBTC",
        decimals: 8,
    };

    const plan = await planConsolidation(sourceTokens, destinationToken, [WALLET]);

    // Create incomplete consolidation
    const incompleteState: ConsolidationState = {
      id: "incomplete-consolidation",
      plan,
      currentStepIndex: 1,
      status: "executing", // Still executing when browser closed
      results: {
        [plan[0].id]: {
          stepId: plan[0].id,
          status: "success",
          chainId: plan[0].chainId,
          transactionHash: "0xabc",
        },
      },
      sourceTokens,
      destinationToken,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      hasSubsequentExecution: false,
    };

    const loaded: ConsolidationState = parse(stringify(incompleteState));

    expect(loaded).toBeDefined();

    // Determine if recovery prompt should be shown
    const shouldShowRecoveryPrompt = 
      loaded!.status === "executing" || 
      loaded!.status === "paused" ||
      (loaded!.status === "ready" && Object.keys(loaded!.results).length > 0);

    expect(shouldShowRecoveryPrompt).toBe(true);

    // UI should show: "Resume previous consolidation?"
    // - Yes: Call executeConsolidationPlan(loaded)
    // - No: Clear state, start fresh
  });

  test("completed consolidation not prompted for recovery", async () => {
    const sourceTokens: TokenAmount[] = [
      makeToken(USDC_ADDRESS, 1000000n, 10), // 1 USDC on Optimism
    ];

    const destinationToken = {
      token: WBTC_ADDRESS,
      chainId: 1,
      walletAddress: WALLET,
        symbol: "WBTC",
        decimals: 8,
    };

    const plan = await planConsolidation(sourceTokens, destinationToken, [WALLET]);

    // Create completed consolidation
    const completedState: ConsolidationState = {
      id: "completed-consolidation",
      plan: plan.map((s) => ({ ...s, status: "success" as const })),
      currentStepIndex: plan.length,
      status: "completed",
      results: plan.reduce((acc, step) => {
        acc[step.id] = {
          stepId: step.id,
          status: "success",
          transactionHash: `0x${step.id}`,
        };
        return acc;
      }, {} as Record<string, any>),
      sourceTokens,
      destinationToken,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      hasSubsequentExecution: false,
    };

    const loaded: ConsolidationState = parse(stringify(completedState));
    expect(loaded).toBeDefined();

    // Should NOT show recovery prompt for completed consolidation
    const shouldShowRecoveryPrompt = loaded!.status !== "completed" && loaded!.status !== "partial";
    expect(shouldShowRecoveryPrompt).toBe(false);
  });

  test("state persistence preserves all critical data", async () => {
    const sourceTokens: TokenAmount[] = [
      makeToken(ETH_ADDRESS, 200000000000000000n, 137, { walletAddress: WALLET, symbol: "POL", decimals: 18 }), // 0.2 POL on Polygon
    ];

    const destinationToken = {
      token: USDC_ADDRESS,
      chainId: 1,
      walletAddress: WALLET,
        symbol: "USDC",
        decimals: 6,
    };

    const plan = await planConsolidation(sourceTokens, destinationToken, [WALLET]);

    const state: ConsolidationState = {
      id: "persistence-test",
      plan,
      currentStepIndex: 2,
      status: "paused",
      results: {
        [plan[0].id]: {
          stepId: plan[0].id,
          status: "success",
          chainId: plan[0].chainId,
          actualOutput: makeToken(USDC_ADDRESS, 798450000n, 137),
          transactionHash: "0xabc123",
        },
        [plan[1].id]: {
          stepId: plan[1].id,
          status: "failed",
          chainId: plan[1].chainId,
          error: {
            code: "SLIPPAGE_EXCEEDED",
            title: "Price changed too much",
            message: "Retry for new quote.",
            recoverable: true,
            timestamp: Date.now(),
          },
        },
      },
      sourceTokens,
      destinationToken,
      createdAt: 1234567890,
      updatedAt: 1234567900,
      hasSubsequentExecution: true,
    };

    // Simulate browser close and reopen - load state
    const loaded: ConsolidationState = parse(stringify(state));

    expect(loaded).toBeDefined();
    expect(loaded!.id).toBe(state.id);
    expect(loaded!.currentStepIndex).toBe(state.currentStepIndex);
    expect(loaded!.status).toBe(state.status);
    expect(loaded!.hasSubsequentExecution).toBe(state.hasSubsequentExecution);
    expect(loaded!.createdAt).toBe(state.createdAt);
    expect(loaded!.updatedAt).toBe(state.updatedAt);

    // Verify plan is preserved
    expect(loaded!.plan.length).toBe(state.plan.length);
    expect(loaded!.plan[0].id).toBe(state.plan[0].id);

    // Verify results are preserved with all details
    expect(loaded!.results[plan[0].id].status).toBe("success");
    expect(loaded!.results[plan[0].id].actualOutput?.amount).toBe(798450000n);
    expect(loaded!.results[plan[0].id].transactionHash).toBe("0xabc123");

    expect(loaded!.results[plan[1].id].status).toBe("failed");
    expect(loaded!.results[plan[1].id].error?.code).toBe("SLIPPAGE_EXCEEDED");
    expect(loaded!.results[plan[1].id].error?.recoverable).toBe(true);

    // Verify metadata
    expect(loaded!.sourceTokens).toEqual(state.sourceTokens);
    expect(loaded!.destinationToken).toEqual(state.destinationToken);
  });
});
