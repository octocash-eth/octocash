import { describe, test, expect, beforeEach, vi } from "vitest";
import type { Account, Chain, HttpTransport, WalletClient } from "viem";
import type { ConsolidationState, TokenAmount } from "../../app/lib/types";
import { WALLET, consumeGenerator, makeToken, USDC_OPTIMISM, ETH_ADDRESS, WBTC_ADDRESS, USDC_POLYGON, USDC_ETHEREUM } from "../helpers";

// Mock dependencies
vi.mock("../../app/lib/odos");
vi.mock("../../app/lib/cctp");

import { planConsolidation } from "../../app/lib/planning";
import { executeConsolidationPlan } from "../../app/lib/execution";
import { getSwapQuote, executeOdosSwapOrTransfer } from "../../app/lib/odos";
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
  const stateStorage = new Map<string, ConsolidationState>();

  beforeEach(() => {
    vi.clearAllMocks();
    stateStorage.clear();

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
        walletAddress: inputArray[0].walletAddress,
        symbol: "USDC",
        decimals: 6,
      };
    });

    vi.mocked(getBridgeFee).mockResolvedValue(0n);
    
    // Setup default mocks for execution
    vi.mocked(executeOdosSwapOrTransfer).mockImplementation(async (tokensIn, tokenOut, _sendCalls) => {
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
      makeToken(ETH_ADDRESS, 200000000000000000n, 137, { walletAddress: WALLET, symbol: "ETH", decimals: 18 }), // 0.2 ETH on Polygon
    ];

    const destinationToken = {
      token: WBTC_ADDRESS,
      chainId: 1, // Ethereum
      walletAddress: WALLET,
      symbol: "WBTC",
      decimals: 8,
    };

    // Step 5: Generate plan
    const plan = await planConsolidation(sourceTokens, destinationToken);

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

    // Verify attestation step has partial dependency
    const attestationStep = plan.find((s) => s.type === "attestation");
    expect(attestationStep?.partialDependency).toBe(true);
    expect(attestationStep?.dependsOn.length).toBeGreaterThanOrEqual(2);

    // Verify claim step
    const claimStep = plan.find((s) => s.type === "claim");
    expect(claimStep).toBeDefined();
    expect(claimStep?.chainId).toBe(1); // Ethereum
    expect(claimStep?.partialDependency).toBe(true);

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
      updatedAt: Date.now(),
      hasSubsequentExecution: false,
    };

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

    const plan = await planConsolidation(sourceTokens, destinationToken);
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
      updatedAt: Date.now(),
      hasSubsequentExecution: false,
    };

    const { finalValue: executedState } = await consumeGenerator(executeConsolidationPlan(state, mockWalletClient));

    const swapResult = executedState.results[swapStep!.id];
    expect(swapResult.actualOutput).toBeDefined();

    // Actual amount may differ from estimated due to slippage
    const actualAmount = swapResult.actualOutput!.amount;
    expect(actualAmount).toBeDefined();
    // In our mock, actual = estimated, but in real scenario they might differ
    expect(actualAmount).toBeGreaterThan(0n);

    // Verify subsequent steps use actual amount, not estimated
    if (plan.length > 1) {
      const dependentStep = plan.find((s) => s.dependsOn.includes(swapStep!.id));
      if (dependentStep) {
        const updatedDependentStep = executedState.plan.find((s) => s.id === dependentStep.id);
        expect(updatedDependentStep?.inputTokens[0].amount).toBe(actualAmount);
      }
    }
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

    const plan = await planConsolidation(sourceTokens, destinationToken);

    const state: ConsolidationState = {
      id: "test-states",
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
