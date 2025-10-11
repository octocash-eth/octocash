import { describe, test, expect, beforeEach, vi } from "vitest";
import type { Account, Chain, HttpTransport, WalletClient } from "viem";
import type { ConsolidationState, TokenAmount } from "../../app/lib/types";
import { WALLET, consumeGenerator, makeToken,  USDT_ADDRESS, DAI_ADDRESS, WBTC_ADDRESS, USDC_ETHEREUM as USDC_ADDRESS } from "../helpers";

// Mock dependencies
vi.mock("../../app/lib/odos");
vi.mock("../../app/lib/cctp");

import { planConsolidation } from "../../app/lib/planning";
import { executeConsolidationPlan } from "../../app/lib/execution";
import { getSwapQuote, executeOdosSwapOrTransfer } from "../../app/lib/odos";
import { getBridgeFee, executeCCTPBurn, retrieveAttestations, executeCCTPMint } from "../../app/lib/cctp";

/**
 * Scenario 3: Continue Past Failure with Partial Dependency Adaptation
 * 
 * User has tokens on multiple chains, one bridge fails
 * Expected: System skips dependent steps, but partial dependency steps adapt and continue
 */
describe("Scenario 3: Continue Past Failure with Partial Dependency Adaptation", () => {
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
      return makeToken(outputToken.token, totalAmount / 2n, outputToken.chainId, inputArray[0].walletAddress, "USDC", 6);
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

  test("partial dependency adaptation - attestation and claim adapt when one bridge fails", async () => {
    // User has:
    // - 1 USDT (Optimism) -> swap to USDC -> bridge
    // - 1 DAI (Polygon) -> swap to USDC -> bridge
    // Destination: WBTC (Ethereum)
    const sourceTokens: TokenAmount[] = [
      makeToken(USDT_ADDRESS, 1000000n, 10, WALLET, "USDT", 6), // 1 USDT on Optimism
      makeToken(DAI_ADDRESS, 1000000000000000000n, 137, WALLET, "DAI", 18), // 1 DAI on Polygon
    ];

    const destinationToken = makeToken(WBTC_ADDRESS, 0n, 1, WALLET, "WBTC", 8);

    // Generate plan
    const plan = await planConsolidation(sourceTokens, destinationToken);

    // Expected steps:
    // 1. Swap USDT -> USDC (Optimism)
    // 2. Swap DAI -> USDC (Polygon)
    // 3. Bridge USDC (Optimism -> Ethereum)
    // 4. Bridge USDC (Polygon -> Ethereum)
    // 5. Attestation (waits for both bridges) - partialDependency=true
    // 6. Claim (claims both) - partialDependency=true
    // 7. Swap USDC -> WBTC (Ethereum)

    const swaps = plan.filter((s) => s.type === "swap" && s.chainId !== 1);
    const bridges = plan.filter((s) => s.type === "bridge");
    const attestation = plan.find((s) => s.type === "attestation");
    const claim = plan.find((s) => s.type === "claim");
    const finalSwap = plan.find((s) => s.type === "swap" && s.chainId === 1);

    expect(swaps.length).toBe(2);
    expect(bridges.length).toBe(2);
    expect(attestation).toBeDefined();
    expect(claim).toBeDefined();
    expect(finalSwap).toBeDefined();

    // Verify attestation and claim have partial dependency
    expect(attestation!.partialDependency).toBe(true);
    expect(claim!.partialDependency).toBe(true);

    // Identify which swap is first in the plan
    const daiSwap = swaps.find((s) => s.chainId === 137);
    const usdtSwap = swaps.find((s) => s.chainId === 10);
    const firstSwap = swaps[0];
    const secondSwap = swaps[1];
    
    // Mock swaps based on which is first in the execution order
    if (firstSwap.chainId === 137) {
      // DAI swap is first - make it fail
      vi.mocked(executeOdosSwapOrTransfer).mockImplementationOnce(async () => {
        throw new Error("Swap failed: Insufficient liquidity");
      });
      // USDT swap is second - make it succeed
      vi.mocked(executeOdosSwapOrTransfer).mockImplementationOnce(async (tokensIn, _tokenOut, _sendCalls) => {
        const totalAmount = tokensIn.reduce((sum, token) => sum + token.amount, 0n);
        return { amount: totalAmount / 2n, transactionHash: `0x${Math.random().toString(16).substring(2)}` };
      });
    } else {
      // USDT swap is first - make it succeed
      vi.mocked(executeOdosSwapOrTransfer).mockImplementationOnce(async (tokensIn, _tokenOut, _sendCalls) => {
        const totalAmount = tokensIn.reduce((sum, token) => sum + token.amount, 0n);
        return { amount: totalAmount / 2n, transactionHash: `0x${Math.random().toString(16).substring(2)}` };
      });
      // DAI swap is second - make it fail
      vi.mocked(executeOdosSwapOrTransfer).mockImplementationOnce(async () => {
        throw new Error("Swap failed: Insufficient liquidity");
      });
    }

    // Simulate execution with one swap failing
    const state: ConsolidationState = {
      id: "test-partial-dep",
      plan,
      currentStepIndex: 0,
      status: "ready",
      results: {},
      sourceTokens,
      destinationToken,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      hasSubsequentExecution: true, // Continue past failures to test skip logic
    };

    const { finalValue: executedState } = await consumeGenerator(executeConsolidationPlan(state, mockWalletClient));

    // Verify results:
    // Verify results:
    // Expected outcomes (order may vary):
    // - Step 1 - USDT swap (Optimism): success
    // - Step 2 - DAI swap (Polygon): failed
    // - Step 3 - Bridge from Optimism: success
    // - Step 4 - Bridge from Polygon: skipped (depends on failed DAI swap)
    // - Step 5 - Attestation: SUCCESS (adapts to only bridge from Optimism)
    // - Step 6 - Claim: SUCCESS (claims only from bridge 1)
    // - Step 7 - Swap USDC -> WBTC (Ethereum): success (with reduced amount)

    const polygonBridge = bridges.find((s) => s.chainId === 137);

    // DAI swap should have failed
    expect(executedState.results[daiSwap!.id]?.status).toBe("failed");
    
    // Polygon bridge should be skipped
    expect(executedState.results[polygonBridge!.id]?.status).toBe("skipped");

    // Attestation should adapt (not skip)
    expect(executedState.results[attestation!.id]?.status).toBe("success");

    // Verify attestation adapted its dependencies
    const updatedAttestation = executedState.plan.find((s) => s.id === attestation!.id);
    expect(updatedAttestation?.dependsOn.length).toBeLessThan(attestation!.dependsOn.length);
    expect(updatedAttestation?.adaptedFrom).toEqual(attestation!.dependsOn);

    // Claim should succeed (it depends on attestation, which adapted)
    expect(executedState.results[claim!.id]?.status).toBe("success");

    // The claim step itself may or may not adapt depending on its dependency structure
    // (it typically depends on attestation, not directly on bridges)
    const updatedClaim = executedState.plan.find((s) => s.id === claim!.id);
    expect(updatedClaim).toBeDefined();

    // Final swap should succeed with reduced amount
    expect(executedState.results[finalSwap!.id]?.status).toBe("success");

    // Overall status should be 'partial' (some steps skipped)
    expect(executedState.status).toBe("partial");
  });

  test("verify user is shown clear explanation for skipped and adapted steps", async () => {
    const sourceTokens: TokenAmount[] = [
      makeToken(USDT_ADDRESS, 1000000n, 10, WALLET, "USDT", 6), // 1 USDT on Optimism
      makeToken(DAI_ADDRESS, 1000000000000000000n, 137, WALLET, "DAI", 18), // 1 DAI on Polygon
    ];

    const destinationToken = {
      token: USDC_ADDRESS,
      chainId: 1,
      walletAddress: WALLET,
        symbol: "USDC",
        decimals: 6,
    };

    const plan = await planConsolidation(sourceTokens, destinationToken);

    // Force the first swap (USDT on Optimism) to fail
    vi.mocked(executeOdosSwapOrTransfer).mockImplementationOnce(async () => {
      throw new Error("Swap failed: Network timeout");
    });

    const state: ConsolidationState = {
      id: "test-explanations",
      plan,
      currentStepIndex: 0,
      status: "ready",
      results: {},
      sourceTokens,
      destinationToken,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      hasSubsequentExecution: true, // User clicked continue
    };

    const { finalValue: executedState } = await consumeGenerator(executeConsolidationPlan(state, mockWalletClient));

    // Find any skipped steps - there MUST be at least one since we forced a failure
    const skippedSteps = Object.values(executedState.results).filter((r) => r.status === "skipped");
    expect(skippedSteps.length).toBeGreaterThan(0);

    for (const skipped of skippedSteps) {
      // Each skipped step should have a clear reason
      expect(skipped.skipReason).toBeDefined();
      expect(skipped.skipReason).toContain("step"); // Should reference the failed dependency
    }

    // Find adapted steps - there MUST be at least one
    const adaptedSteps = executedState.plan.filter((s) => s.adaptedFrom && s.adaptedFrom.length > 0);
    expect(adaptedSteps.length).toBeGreaterThan(0);

    for (const adapted of adaptedSteps) {
      // Adapted steps should track original dependencies
      expect(adapted.adaptedFrom).toBeDefined();
      expect(adapted.adaptedFrom!.length).toBeGreaterThan(adapted.dependsOn.length);

      // Should have reduced dependencies to only successful ones
      expect(adapted.dependsOn.length).toBeGreaterThan(0);
    }
  });

  test("verify consolidation completes partially with correct final amount", async () => {
    const sourceTokens: TokenAmount[] = [
      makeToken(USDC_ADDRESS, 500000n, 10, WALLET), // 0.5 USDC on Optimism
      makeToken(USDC_ADDRESS, 500000n, 137, WALLET), // 0.5 USDC on Polygon
    ];

    const destinationToken = {
      token: WBTC_ADDRESS,
      chainId: 1, // Ethereum
      walletAddress: WALLET,
        symbol: "WBTC",
        decimals: 8,
    };

    const plan = await planConsolidation(sourceTokens, destinationToken);
    
    const bridges = plan.filter((s) => s.type === "bridge");
    const optimismBridge = bridges.find((b) => b.chainId === 10);
    const polygonBridge = bridges.find((b) => b.chainId === 137);

    // Force Optimism bridge to succeed (first call)
    vi.mocked(executeCCTPBurn).mockImplementationOnce(async (tokenIn, _tokenOut, _sendCalls) => {
      const txHash = `0x${Math.random().toString(16).substring(2)}`;
      return [txHash, tokenIn.chainId];
    });
    
    // Force Polygon bridge to fail (second call)
    vi.mocked(executeCCTPBurn).mockImplementationOnce(async () => {
      throw new Error("Bridge failed: Circle API unavailable");
    });

    const state: ConsolidationState = {
      id: "test-partial-amount",
      plan,
      currentStepIndex: 0,
      status: "ready",
      results: {},
      sourceTokens,
      destinationToken,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      hasSubsequentExecution: true,
    };

    // Simulate: Optimism bridge succeeds, Polygon bridge fails
    const { finalValue: executedState } = await consumeGenerator(executeConsolidationPlan(state, mockWalletClient));

    const claim = plan.find((s) => s.type === "claim");
    const finalSwap = plan.find((s) => s.type === "swap" && s.chainId === 1);

    // Optimism bridge should succeed
    expect(executedState.results[optimismBridge!.id]?.status).toBe("success");
    
    // Polygon bridge should fail
    expect(executedState.results[polygonBridge!.id]?.status).toBe("failed");

    // Claim should succeed with reduced amount (only from successful bridge)
    expect(executedState.results[claim!.id]?.status).toBe("success");

    const claimResult = executedState.results[claim!.id];
    const claimAmount = claimResult.actualOutput?.amount || 0n;
    expect(claimAmount).toBeGreaterThan(0n);

    // Final swap should use the reduced amount from claim
    const finalSwapResult = executedState.results[finalSwap!.id];
    expect(finalSwapResult.status).toBe("success");
    
    const updatedFinalSwap = executedState.plan.find((s) => s.id === finalSwap!.id);
    expect(updatedFinalSwap?.inputTokens[0].amount).toBe(claimAmount);

    // Status should be 'partial'
    expect(executedState.status).toBe("partial");
  });

  test("skip reason shows which dependency failed", async () => {
    const sourceTokens: TokenAmount[] = [
      makeToken(DAI_ADDRESS, 1000000000000000000n, 137, WALLET, "DAI", 18), // 1 DAI on Polygon
    ];

    const destinationToken = {
      token: USDC_ADDRESS,
      chainId: 1,
      walletAddress: WALLET,
        symbol: "USDC",
        decimals: 6,
    };

    const plan = await planConsolidation(sourceTokens, destinationToken);

    const swapStep = plan.find((s) => s.type === "swap");
    const bridgeStep = plan.find((s) => s.type === "bridge");

    // Force the swap to fail
    vi.mocked(executeOdosSwapOrTransfer).mockImplementationOnce(async () => {
      throw new Error("Swap failed: Price impact too high");
    });

    const state: ConsolidationState = {
      id: "test-skip-reason",
      plan,
      currentStepIndex: 0,
      status: "ready",
      results: {},
      sourceTokens,
      destinationToken,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      hasSubsequentExecution: true,
    };

    // Simulate: First swap fails
    const { finalValue: executedState } = await consumeGenerator(executeConsolidationPlan(state, mockWalletClient));

    // Swap should have failed
    expect(executedState.results[swapStep!.id]?.status).toBe("failed");
    
    // Bridge should be skipped
    expect(executedState.results[bridgeStep!.id]?.status).toBe("skipped");

    // Skip reason should reference the failed swap
    const skipReason = executedState.results[bridgeStep!.id]?.skipReason;
    expect(skipReason).toBeDefined();
    expect(skipReason).toContain(swapStep!.id);
  });
});
