import { describe, test, expect, beforeEach, vi } from "vitest";
import type { Account, Chain, HttpTransport, WalletClient, Address } from "viem";
import type { ConsolidationState, TokenAmount } from "../../app/lib/types";
import { WALLET, consumeGenerator, makeToken } from "../test-helpers";

// Mock dependencies
vi.mock("../../app/lib/odos");
vi.mock("../../app/lib/cctp");

import { planConsolidation } from "../../app/lib/planning";
import { executeConsolidationPlan } from "../../app/lib/execution";
import { getSwapQuote, executeOdosSwap } from "../../app/lib/odos";
import { getBridgeFee, executeCCTPBurn, retrieveAttestations, executeCCTPMint } from "../../app/lib/cctp";

const USDC_OPTIMISM = "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85" as Address;
const USDC_ARBITRUM = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" as Address;
const USDC_POLYGON = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359" as Address;

/**
 * Scenario: Multi-Bridge Claim Amount Aggregation Bug
 * 
 * User has 1 USDC on Optimism + 1 USDC on Arbitrum
 * Destination: USDC on Polygon
 * 
 * Expected: After both bridges complete, claim step should show 2 USDC total
 * Actual Bug: Claim step only shows 1 USDC after first bridge completes
 */
describe("Scenario: Multi-Bridge Claim Amount Aggregation", () => {

  let mockWalletClient: WalletClient<HttpTransport, Chain, Account>;


  beforeEach(() => {
    vi.clearAllMocks();

    // Create mock wallet client
    mockWalletClient = {
      account: { address: WALLET } as Account,
      chain: { id: 137 } as Chain, // Polygon
    } as WalletClient<HttpTransport, Chain, Account>;

    // Setup default mocks for planning
    vi.mocked(getSwapQuote).mockImplementation(async (input, outputToken) => {
      const inputArray = Array.isArray(input) ? input : [input];
      const totalAmount = inputArray.reduce((sum, token) => sum + token.amount, 0n);
      return {
        token: outputToken.token,
        amount: totalAmount, // 1:1 for simplicity
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
      return { amount: totalAmount, transactionHash: `0x${Math.random().toString(16).substring(2)}` };
    });

    vi.mocked(executeCCTPBurn).mockImplementation(async (tokenIn, _tokenOut, _sendCalls) => {
      const txHash = `0x${Math.random().toString(16).substring(2)}`;
      return [txHash, tokenIn.chainId];
    });

    // Mock attestations to return the actual amounts being bridged
    vi.mocked(retrieveAttestations).mockImplementation(async (txsAndChainIds) => {
      return txsAndChainIds.map(() => ({
        message: `0x${"00".repeat(32)}`,
        attestation: `0x${"00".repeat(65)}`,
        status: "complete",
        decodedMessage: {
          nonce: `0x${Math.random().toString(16).substring(2).padStart(64, "0")}`,
          destinationDomain: "0",
          decodedMessageBody: {
            amount: "1000000", // 1 USDC per bridge
            feeExecuted: "0",
          },
        },
      }));
    });

    vi.mocked(executeCCTPMint).mockImplementation(async (_attestations, _tokenOut, _sendCalls) => {
      const txHash = `0x${Math.random().toString(16).substring(2)}`;
      return [txHash, []];
    });
  });

  test("claim step should aggregate amounts from multiple bridges", async () => {
    // Step 1: User selects source tokens
    const sourceTokens: TokenAmount[] = [
      makeToken(USDC_OPTIMISM, 1000000n, 10, { walletAddress: WALLET }), // 1 USDC on Optimism
      makeToken(USDC_ARBITRUM, 1000000n, 42161, { walletAddress: WALLET }), // 1 USDC on Arbitrum
    ];

    const destinationToken = {
      token: USDC_POLYGON,
      chainId: 137, // Polygon
      walletAddress: WALLET,
      symbol: "USDC",
      decimals: 6,
    };

    // Step 2: Generate plan
    const plan = await planConsolidation(sourceTokens, destinationToken, [WALLET]);

    console.log("\n=== Initial Plan ===");
    for (const step of plan) {
      console.log(`${step.id} (${step.type}): ${step.inputTokens.length} inputs -> ${step.outputToken.amount.toString()} ${step.outputToken.symbol}`);
    }

    // Step 3: Verify initial plan structure
    const bridgeSteps = plan.filter((s) => s.type === "bridge");
    const attestationStep = plan.find((s) => s.type === "attestation");
    const claimStep = plan.find((s) => s.type === "claim");

    expect(bridgeSteps.length).toBe(2); // Two bridges: Optimism -> Polygon, Arbitrum -> Polygon
    expect(attestationStep).toBeDefined();
    expect(claimStep).toBeDefined();

    // Initial claim step should expect to receive 2 USDC (sum of both bridges)
    expect(claimStep?.outputToken.amount).toBe(2000000n); // 2 USDC in smallest units

    // Step 4: Execute Plan
    const state: ConsolidationState = {
      id: "test-multi-bridge-claim",
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

    console.log("\n=== After First Bridge ===");
    const afterFirstBridge = states.find((s) => {
      const firstBridge = s.plan.find((p) => p.type === "bridge" && p.status === "success");
      const secondBridge = s.plan.find((p) => p.type === "bridge" && p.status === "pending");
      return firstBridge && secondBridge;
    });

    if (afterFirstBridge) {
      const claimStepAfterFirst = afterFirstBridge.plan.find((s) => s.type === "claim");
      console.log(`Claim step after first bridge: ${claimStepAfterFirst?.outputToken.amount.toString()} USDC`);
      
      // BUG: This will fail! The claim step will show 1 USDC instead of 2 USDC
      // because recalculatePlan only uses updatedInputs[0].amount instead of summing all inputs
      expect(claimStepAfterFirst?.outputToken.amount).toBe(2000000n); // Should still be 2 USDC
    }

    console.log("\n=== After Second Bridge ===");
    const afterSecondBridge = states.find((s) => {
      const bridges = s.plan.filter((p) => p.type === "bridge" && p.status === "success");
      return bridges.length === 2;
    });

    if (afterSecondBridge) {
      const claimStepAfterSecond = afterSecondBridge.plan.find((s) => s.type === "claim");
      console.log(`Claim step after second bridge: ${claimStepAfterSecond?.outputToken.amount.toString()} USDC`);
      
      // BUG: This will also fail! After the second bridge, recalculatePlan will only see the second
      // bridge's output and update the claim to 1 USDC again
      expect(claimStepAfterSecond?.outputToken.amount).toBe(2000000n); // Should be 2 USDC
    }

    // Step 5: Verify final execution
    expect(executedState.status).toBe("completed");

    // All steps should succeed
    for (const result of Object.values(executedState.results)) {
      expect(result.status).toBe("success");
    }

    // Final claim step result should have 2 USDC
    const claimStepResult = executedState.results[claimStep!.id];
    expect(claimStepResult.status).toBe("success");
    expect(claimStepResult.actualOutput?.amount).toBe(2000000n); // 2 USDC total
  });

  test("claim step inputs should track provenance from all bridges", async () => {
    const sourceTokens: TokenAmount[] = [
      makeToken(USDC_OPTIMISM, 1000000n, 10, { walletAddress: WALLET }), // 1 USDC on Optimism
      makeToken(USDC_ARBITRUM, 1000000n, 42161, { walletAddress: WALLET }), // 1 USDC on Arbitrum
    ];

    const destinationToken = {
      token: USDC_POLYGON,
      chainId: 137, // Polygon
      walletAddress: WALLET,
      symbol: "USDC",
      decimals: 6,
    };

    const plan = await planConsolidation(sourceTokens, destinationToken, [WALLET]);

    const bridgeSteps = plan.filter((s) => s.type === "bridge");
    const claimStep = plan.find((s) => s.type === "claim");

    expect(claimStep).toBeDefined();
    expect(claimStep!.inputTokens.length).toBe(2); // Should have inputs from both bridges

    // Verify each input token has provenance from a bridge step
    for (const input of claimStep!.inputTokens) {
      expect(input.provenance).toBeDefined();
      const bridgeStep = bridgeSteps.find((s) => s.id === input.provenance);
      expect(bridgeStep).toBeDefined();
    }
  });
});

