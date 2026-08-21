import { describe, test, expect, beforeEach, vi } from "vitest";
import type { Account, Chain, HttpTransport, WalletClient } from "viem";
import type { ConsolidationState, TokenAmount } from "../../app/lib/types";
import { WALLET, consumeGenerator, makeToken, USDC_OPTIMISM, ETH_ADDRESS, WBTC_ADDRESS, USDC_POLYGON, USDC_ETHEREUM } from "../test-helpers";

// Mock dependencies
vi.mock("../../app/lib/delora");
vi.mock("../../app/lib/cctp");
vi.mock("../../app/lib/public-client", () => ({
  getPublicClient: vi.fn(() => ({
    // Feeds the EIP-1559 path in `fetchFastFees`. baseFee 0.5 gwei (gasUsed
    // == target ⇒ pendingBase = baseFee), so bufferedBase = 1 gwei. Empty
    // feeHistory falls back to the chain's priority floor.
    getBlock: vi.fn().mockResolvedValue({
      baseFeePerGas: 500_000_000n,
      gasUsed: 15_000_000n,
      gasLimit: 30_000_000n,
    }),
    getFeeHistory: vi.fn().mockResolvedValue({ reward: [] }),
    getGasPrice: vi.fn().mockResolvedValue(500_000_000n),
    // Simulation reverts ⇒ buildStepGasEstimate falls back to GAS_BUDGETS.
    estimateGas: vi.fn().mockRejectedValue(new Error("revert")),
    readContract: vi.fn().mockResolvedValue(2n ** 128n),
    getCode: vi.fn().mockResolvedValue("0x"),
  })),
  retryOnRateLimit: <T>(fn: () => Promise<T>) => fn(),
}));
vi.mock("../../app/lib/gas", () => ({
  getNativeBalance: vi.fn().mockResolvedValue(2n ** 128n),
}));
// The route comparison prices its candidates through the Delora oracle; keep
// it deterministic (and offline) here. Tests that exercise the direct route
// override the price map per-test.
vi.mock("../../app/lib/api/delora", () => ({
  fetchDeloraPrices: vi.fn().mockResolvedValue(new Map()),
  deloraPriceKey: (chainId: number, address: string) => `${chainId}:${address.toLowerCase()}`,
}));

import { zeroAddress } from "viem";
import { planConsolidation } from "../../app/lib/planning";
import { executeConsolidationPlan } from "../../app/lib/execution";
import {
  executeDeloraCrossChainSwap,
  executeDeloraSwap,
  getCrossChainSwapQuoteWithLegs,
  getSwapQuote,
  getSwapQuoteWithLegs,
  waitForCrossChainDelivery,
} from "../../app/lib/delora";
import { fetchDeloraPrices } from "../../app/lib/api/delora";
import { getBridgeFee, executeCCTPBurn, retrieveAttestations, executeCCTPMint } from "../../app/lib/cctp";
import { stringify, parse } from "superjson";

/**
 * Scenario 1: Happy Path - Multi-Chain Consolidation
 * 
 * User has 1 USDC (Optimism) + 0.2 ETH (Polygon)
 * Destination: WBTC on Ethereum
 * 
 * Expected: All steps succeed, WBTC successfully consolidated
 */
describe("Scenario 1: Happy Path - Multi-Chain Consolidation", () => {

  let mockWalletClient: WalletClient<HttpTransport, Chain, Account>;


  beforeEach(() => {
    vi.clearAllMocks();

    // Create mock wallet client
    mockWalletClient = {
      account: { address: WALLET } as Account,
      chain: { id: 1 } as Chain,
    } as WalletClient<HttpTransport, Chain, Account>;

    // Setup default mocks for planning
    // Planning consumes the legs variant; delegate to the amount-only mock.
    vi.mocked(getSwapQuoteWithLegs).mockImplementation(async (input, outputToken) => ({
      output: await getSwapQuote(input, outputToken),
      legs: [],
    }));
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
    vi.mocked(executeDeloraSwap).mockImplementation(async (tokensIn, tokenOut, _sendCalls) => {
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

  test("complete consolidation flow - all steps succeed", async () => {
    // Step 1-4: User selects source tokens
    const sourceTokens: TokenAmount[] = [
      makeToken(USDC_OPTIMISM, 1000000n, 10, { walletAddress: WALLET }), // 1 USDC on Optimism
      makeToken(ETH_ADDRESS, 200000000000000000n, 137, { walletAddress: WALLET, symbol: "POL", decimals: 18 }), // 0.2 POL on Polygon
    ];

    const destinationToken = {
      token: WBTC_ADDRESS,
      chainId: 1, // Ethereum
      walletAddress: WALLET,
      symbol: "WBTC",
      decimals: 8,
    };

    // Step 5: Generate plan
    const plan = await planConsolidation(sourceTokens, destinationToken, [WALLET]);

    // Step 6: Verify Plan Display
    expect(plan.length).toBeGreaterThanOrEqual(5);

    // Verify card types are present
    const types = plan.map((s) => s.type);
    expect(types).toContain("swap"); // ETH -> USDC on Polygon
    expect(types).toContain("bridge"); // At least one bridge
    expect(types).toContain("attestation"); // Wait for attestation
    expect(types).toContain("claim"); // Claim on Ethereum
    
    // Verify swap step
    const swapStep = plan.find((s) => s.type === "swap" && s.chainId === 137);
    expect(swapStep).toBeDefined();
    expect(swapStep?.status).toBe("pending");
    expect(swapStep?.inputTokens[0].token).toBe(ETH_ADDRESS);
    expect(swapStep?.outputToken.token).toBe(USDC_POLYGON);

    // Verify bridge steps
    const bridgeSteps = plan.filter((s) => s.type === "bridge");
    expect(bridgeSteps.length).toBeGreaterThanOrEqual(2);
    expect(bridgeSteps.every((s) => s.status === "pending")).toBe(true);

    // Verify attestation step has inputs from multiple bridges
    const attestationStep = plan.find((s) => s.type === "attestation");
    expect(attestationStep?.inputTokens.length).toBeGreaterThanOrEqual(2);

    // Verify claim step
    const claimStep = plan.find((s) => s.type === "claim");
    expect(claimStep).toBeDefined();
    expect(claimStep?.chainId).toBe(1); // Ethereum

    // Verify final swap to WBTC
    const finalSwap = plan.find(
      (s) => s.type === "swap" && s.chainId === 1 && s.outputToken.token === WBTC_ADDRESS
    );
    expect(finalSwap).toBeDefined();

    // Step 7: Execute Plan
    const state: ConsolidationState = {
      id: "test-consolidation-1",
      plan,
      currentStepIndex: 0,
      status: "ready",
      results: {},
      sourceTokens,
      destinationToken,
      createdAt: Date.now(),
      updatedAt: Date.now(),    };

    const { finalValue: executedState, values: states } = await consumeGenerator(executeConsolidationPlan(state, mockWalletClient));

    // Step 8: Verify Execution
    expect(executedState.status).toBe("completed");
    expect(Object.keys(executedState.results).length).toBe(plan.length);

    // All steps should be successful
    for (const result of Object.values(executedState.results)) {
      expect(result.status).toBe("success");
    }

    // States should have been yielded during execution
    expect(states.length).toBeGreaterThan(0);

    // Verify actual amounts were captured for swap steps
    for (const result of Object.values(executedState.results)) {
      if (result.status === "success") {
        const step = plan.find((s) => s.id === result.stepId);
        // Only transaction steps (swap, bridge, claim, transfer) have transactionHash
        // Attestation is a wait step and doesn't have a transaction hash
        if (step?.type !== "attestation") {
          expect(result.transactionHash).toBeDefined();
        }
        // Only swap and claim steps have actualOutput
        if (step?.type === "swap" || step?.type === "claim") {
          expect(result.actualOutput).toBeDefined();
        }
      }
    }

    // Simulate browser close/reopen
    const loadedState: ConsolidationState = parse(stringify(executedState));

    // Step 9: Verify State Persistence
    expect(loadedState).toBeDefined();
    expect(loadedState?.status).toBe("completed");
    expect(loadedState?.results).toEqual(executedState.results);

    // Verify all cards are in success state
    for (const step of loadedState!.plan) {
      expect(step.status).toBe("success");
    }
  });

  test("verify estimated vs actual amounts are tracked", async () => {
    const sourceTokens: TokenAmount[] = [
      makeToken(ETH_ADDRESS, 200000000000000000n, 137, { walletAddress: WALLET, symbol: "POL", decimals: 18 }), // 0.2 POL on Polygon
    ];

    const destinationToken = {
      token: USDC_ETHEREUM,
      chainId: 1,
      walletAddress: WALLET,
      symbol: "USDC",
      decimals: 6,
    };

    const plan = await planConsolidation(sourceTokens, destinationToken, [WALLET]);
    const swapStep = plan.find((s) => s.type === "swap");

    expect(swapStep).toBeDefined();

    const state: ConsolidationState = {
      id: "test-amounts",
      plan,
      currentStepIndex: 0,
      status: "ready",
      results: {},
      sourceTokens,
      destinationToken,
      createdAt: Date.now(),
      updatedAt: Date.now(),    };

    const { finalValue: executedState } = await consumeGenerator(executeConsolidationPlan(state, mockWalletClient));

    const swapResult = executedState.results[swapStep!.id];
    expect(swapResult.actualOutput).toBeDefined();

    // Actual amount may differ from estimated due to slippage
    const actualAmount = swapResult.actualOutput!.amount;
    expect(actualAmount).toBeDefined();
    // In our mock, actual = estimated, but in real scenario they might differ
    expect(actualAmount).toBeGreaterThan(0n);

    // Verify subsequent steps use actual amount, not estimated (via provenance)
    const dependentStep = plan.find((s) => 
      s.inputTokens.some(token => token.provenance === swapStep!.id)
    );
    expect(dependentStep).toBeDefined(); // Assert provenance chain exists

    const updatedDependentStep = executedState.plan.find((s) => s.id === dependentStep!.id);
    expect(updatedDependentStep).toBeDefined();

    const inputFromSwap = updatedDependentStep!.inputTokens.find(t => t.provenance === swapStep!.id);
    expect(inputFromSwap).toBeDefined(); // Assert provenance-tagged token exists
    expect(inputFromSwap!.amount).toBe(actualAmount);
  });

  test("verify transaction cards show correct states during execution", async () => {
    const sourceTokens: TokenAmount[] = [
      makeToken(USDC_OPTIMISM, 1000000n, 10, { walletAddress: WALLET }), // 1 USDC on Optimism
    ];

    const destinationToken = {
      token: WBTC_ADDRESS,
      chainId: 1,
      walletAddress: WALLET,
      symbol: "WBTC",
      decimals: 8,
    };

    const plan = await planConsolidation(sourceTokens, destinationToken, [WALLET]);

    const state: ConsolidationState = {
      id: "test-states",
      plan,
      currentStepIndex: 0,
      status: "ready",
      results: {},
      sourceTokens,
      destinationToken,
      createdAt: Date.now(),
      updatedAt: Date.now(),    };

    const { values: states } = await consumeGenerator(executeConsolidationPlan(state, mockWalletClient));

    // Verify each step went through executing -> success transition by checking yielded states
    for (const step of plan) {
      // Find state where this step was executing
      const executingState = states.find((s) => {
        const planStep = s.plan.find((p) => p.id === step.id);
        return planStep?.status === "executing";
      });

      // Find state where this step succeeded
      const successState = states.find((s) => {
        const planStep = s.plan.find((p) => p.id === step.id);
        return planStep?.status === "success";
      });

      expect(executingState).toBeDefined();
      expect(successState).toBeDefined();

      // Executing should come before success in the state sequence
      const executingIndex = states.indexOf(executingState!);
      const successIndex = states.indexOf(successState!);
      expect(executingIndex).toBeLessThan(successIndex);
    }
  });
});

/**
 * Direct cross-chain route: when a single Delora cross-chain swap nets more
 * than swap → CCTP → claim → swap, the planner emits crosschain-swap +
 * crosschain-wait and execution delivers straight to the destination wallet.
 */
describe("Direct cross-chain route - plan then execute", () => {
  let mockWalletClient: WalletClient<HttpTransport, Chain, Account>;

  beforeEach(() => {
    vi.clearAllMocks();

    mockWalletClient = {
      account: { address: WALLET } as Account,
      chain: { id: 1 } as Chain,
    } as WalletClient<HttpTransport, Chain, Account>;

    vi.mocked(getSwapQuoteWithLegs).mockImplementation(async (input, outputToken) => ({
      output: await getSwapQuote(input, outputToken),
      legs: [],
    }));
    // Conversion probe / bridged final swap: ~999 USDC → 0.00985 WBTC (~$985).
    vi.mocked(getSwapQuote).mockResolvedValue({
      token: WBTC_ADDRESS,
      amount: 985_000n,
      chainId: 1,
      walletAddress: WALLET,
      symbol: "WBTC",
      decimals: 8,
    });
    vi.mocked(getBridgeFee).mockResolvedValue(1_000_000n); // $1 CCTP fee
    vi.mocked(fetchDeloraPrices).mockResolvedValue(
      new Map<`${number}:${string}`, number>([
        [`1:${WBTC_ADDRESS.toLowerCase()}`, 100_000],
        [`1:${zeroAddress}`, 3_000],
        [`10:${zeroAddress}`, 3_000],
      ]),
    );
    // The direct quote nets ~$999 — beats the bridged ~$985.
    vi.mocked(getCrossChainSwapQuoteWithLegs).mockResolvedValue({
      output: {
        token: WBTC_ADDRESS,
        amount: 999_000n,
        chainId: 1,
        walletAddress: WALLET,
        symbol: "WBTC",
        decimals: 8,
      },
      legs: [],
      minOutputAmount: 994_000n,
    });
    vi.mocked(executeDeloraCrossChainSwap).mockResolvedValue({
      expectedAmount: 999_000n,
      minDeliveredAmount: 994_000n,
      transactionHash: "0xdirectswap",
    });
    vi.mocked(waitForCrossChainDelivery).mockResolvedValue(998_500n);
  });

  test("plans a direct route and executes it end-to-end with a persisted delivery record", async () => {
    const sourceTokens: TokenAmount[] = [
      makeToken(USDC_OPTIMISM, 1_000_000_000n, 10, { walletAddress: WALLET }), // 1000 USDC on Optimism
    ];
    const destinationToken = {
      token: WBTC_ADDRESS,
      chainId: 1,
      walletAddress: WALLET,
      symbol: "WBTC",
      decimals: 8,
    };

    const plan = await planConsolidation(sourceTokens, destinationToken, [WALLET]);
    expect(plan.map((s) => s.type)).toEqual(["crosschain-swap", "crosschain-wait"]);

    const state: ConsolidationState = {
      id: "direct-happy-path",
      plan,
      currentStepIndex: 0,
      status: "ready",
      results: {},
      sourceTokens,
      destinationToken,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const { finalValue: finalState } = await consumeGenerator(executeConsolidationPlan(state, mockWalletClient));

    expect(finalState.status).toBe("completed");

    const swapResult = finalState.results[plan[0].id];
    expect(swapResult.status).toBe("success");
    expect(swapResult.transactionHash).toBe("0xdirectswap");
    expect(swapResult.actualOutput?.amount).toBe(999_000n); // quoted, pre-delivery

    // The delivery record survived into metadata for the wait step / reloads.
    const deliveries = finalState.metadata?.crosschain?.deliveries;
    expect(deliveries).toHaveLength(1);
    expect(deliveries?.[0]).toMatchObject({
      txHash: "0xdirectswap",
      fromChainId: 10,
      toChainId: 1,
      toAddress: WALLET,
      tokenAddress: WBTC_ADDRESS,
      minDeliveredUnits: "994000",
      expectedUnits: "999000",
    });

    // The wait adopted the measured delivery.
    const waitResult = finalState.results[plan[1].id];
    expect(waitResult.status).toBe("success");
    expect(waitResult.actualOutput?.amount).toBe(998_500n);

    // Nothing CCTP-related ever ran.
    expect(executeCCTPBurn).not.toHaveBeenCalled();
    expect(retrieveAttestations).not.toHaveBeenCalled();
    expect(executeCCTPMint).not.toHaveBeenCalled();
  });
});
