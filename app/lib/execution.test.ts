import type { Account, Address, Chain, HttpTransport, WalletClient } from "viem";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { consumeGenerator, makeToken, WALLET } from "../../test/helpers";
import type { ConsolidationState, StepResult, TokenAmount, TransactionStep } from "./types";

// Mock dependencies BEFORE imports
vi.mock("./odos");
vi.mock("./cctp");
vi.mock("./send-calls");

import { executeCCTPBurn, executeCCTPMint, retrieveAttestations } from "./cctp";
import { executeConsolidationPlan, shouldSkipStep } from "./execution";
import { executeOdosSwapOrTransfer, getSwapQuote } from "./odos";
import { prepareSendCalls } from "./send-calls";

describe("executeConsolidationPlan", () => {
  const USDC_ADDRESS = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address;

  let mockState: ConsolidationState;
  let mockWalletClient: WalletClient<HttpTransport, Chain, Account>;

  beforeEach(() => {
    vi.clearAllMocks();

    // Create mock wallet client
    mockWalletClient = {
      account: { address: WALLET } as Account,
      chain: { id: 1 } as Chain,
    } as WalletClient<HttpTransport, Chain, Account>;

    // Default mock for getSwapQuote (used in recalculation)
    vi.mocked(getSwapQuote).mockResolvedValue(makeToken(USDC_ADDRESS, 1000000n, 1));

    // Default execution mocks
    vi.mocked(executeOdosSwapOrTransfer).mockResolvedValue({ amount: 1000000n, transactionHash: "0xswap123" });
    vi.mocked(executeCCTPBurn).mockResolvedValue(["0xburn", 1]);
    vi.mocked(retrieveAttestations).mockResolvedValue([
      {
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
      },
    ]);
    vi.mocked(executeCCTPMint).mockResolvedValue(["0xmint", []]);

    // Mock prepareSendCalls to return a function that returns success
    vi.mocked(prepareSendCalls).mockReturnValue(vi.fn().mockResolvedValue(["0xtxhash", []]));

    mockState = {
      id: "test-consolidation",
      plan: [],
      currentStepIndex: 0,
      status: "ready",
      results: {},
      sourceTokens: [],
      destinationToken: makeToken(USDC_ADDRESS, 0n, 1),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      hasSubsequentExecution: false,
    };
  });

  test("all steps succeed - should return status='completed'", async () => {
    const step1: TransactionStep = {
      id: "step-1",
      type: "swap",
      status: "pending",
      chainId: 1,
      inputTokens: [makeToken(USDC_ADDRESS, 1000000n, 1)],
      outputToken: makeToken(USDC_ADDRESS, 1000000n, 1),
    };

    mockState.plan = [step1];

    const { finalValue: finalState, values: states } = await consumeGenerator(
      executeConsolidationPlan(mockState, mockWalletClient),
    );

    expect(finalState.status).toBe("completed");
    expect(finalState.results["step-1"].status).toBe("success");
    expect(states.length).toBeGreaterThan(0);
  });

  test("middle step fails with pause - should return status='paused'", async () => {
    const step1: TransactionStep = {
      id: "step-1",
      type: "swap",
      status: "pending",
      chainId: 1,
      inputTokens: [makeToken(USDC_ADDRESS, 1000000n, 1)],
      outputToken: makeToken(USDC_ADDRESS, 1000000n, 1),
    };

    const step2: TransactionStep = {
      id: "step-2",
      type: "bridge",
      status: "pending",
      chainId: 1,
      inputTokens: [makeToken(USDC_ADDRESS, 1000000n, 1)],
      outputToken: makeToken(USDC_ADDRESS, 1000000n, 1),
    };

    mockState.plan = [step1, step2];

    vi.mocked(executeCCTPBurn).mockRejectedValueOnce(new Error("Bridge failed"));

    const { finalValue: finalState } = await consumeGenerator(executeConsolidationPlan(mockState, mockWalletClient));

    expect(finalState.status).toBe("paused");
    expect(finalState.results["step-1"].status).toBe("success");
    expect(finalState.results["step-2"].status).toBe("failed");
  });

  test("continue after failure with skip - should skip dependent steps", async () => {
    const step1: TransactionStep = {
      id: "step-1",
      type: "swap",
      status: "failed",
      chainId: 1,
      inputTokens: [makeToken(USDC_ADDRESS, 1000000n, 1)],
      outputToken: makeToken(USDC_ADDRESS, 1000000n, 1),
    };

    const step2: TransactionStep = {
      id: "step-2",
      type: "bridge",
      status: "pending",
      chainId: 1,
      inputTokens: [makeToken(USDC_ADDRESS, 1000000n, 1, { provenance: "step-1" })], // Input from step-1
      outputToken: makeToken(USDC_ADDRESS, 1000000n, 1),
    };

    mockState.plan = [step1, step2];
    mockState.status = "paused";
    mockState.currentStepIndex = 0;
    mockState.hasSubsequentExecution = true; // User clicked continue
    mockState.results["step-1"] = { stepId: "step-1", status: "failed", chainId: 1 };

    const { finalValue: finalState } = await consumeGenerator(executeConsolidationPlan(mockState, mockWalletClient));

    expect(finalState.results["step-2"].status).toBe("skipped");
    expect(finalState.results["step-2"].skipReason).toContain("step-1");
    expect(finalState.status).toBe("partial");
  });

  test("recalculation - after step with different actual amount, verify subsequent steps updated", async () => {
    const step1: TransactionStep = {
      id: "step-1",
      type: "swap",
      status: "pending",
      chainId: 1,
      inputTokens: [makeToken(USDC_ADDRESS, 1000000n, 1)],
      outputToken: makeToken(USDC_ADDRESS, 1000000n, 1), // Estimated 1 USDC
    };

    const step2: TransactionStep = {
      id: "step-2",
      type: "bridge",
      status: "pending",
      chainId: 1,
      inputTokens: [makeToken(USDC_ADDRESS, 1000000n, 1, { provenance: "step-1" })], // Based on step-1 estimate
      outputToken: makeToken(USDC_ADDRESS, 1000000n, 1),
    };

    mockState.plan = [step1, step2];

    // Step-1 returns different actual amount (0.98 USDC instead of 1 USDC)
    vi.mocked(executeOdosSwapOrTransfer).mockResolvedValueOnce({ amount: 980000n, transactionHash: "0xswap123" }); // 0.98 USDC

    const { finalValue: finalState } = await consumeGenerator(executeConsolidationPlan(mockState, mockWalletClient));

    // Step-2 input should be recalculated to use actual from step-1
    expect(finalState.plan[1].inputTokens[0].amount).toBe(980000n); // Updated to actual
  });

  test("value changes during execution - track intermediate state updates", async () => {
    const DAI_ADDRESS = "0x6B175474E89094C44Da98b954EedeAC495271d0F" as Address;
    const WETH_ADDRESS = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" as Address;

    // Complex scenario: WETH -> USDC -> DAI (2 swaps with recalculation)
    const step1: TransactionStep = {
      id: "step-1",
      type: "swap",
      status: "pending",
      chainId: 1,
      inputTokens: [makeToken(WETH_ADDRESS, 1000000000000000000n, 1)], // 1 WETH
      outputToken: makeToken(USDC_ADDRESS, 3000000000n, 1), // Estimated 3000 USDC
    };

    const step2: TransactionStep = {
      id: "step-2",
      type: "swap",
      status: "pending",
      chainId: 1,
      inputTokens: [makeToken(USDC_ADDRESS, 3000000000n, 1, { provenance: "step-1" })],
      outputToken: makeToken(DAI_ADDRESS, 3000000000000000000000n, 1), // Estimated 3000 DAI
    };

    mockState.plan = [step1, step2];

    // Mock swap 1: WETH -> USDC (actual: 3100 USDC, estimated: 3000)
    vi.mocked(executeOdosSwapOrTransfer).mockResolvedValueOnce({
      amount: 3100000000n, // 3100 USDC (better than estimated)
      transactionHash: "0xswap1",
    });

    // Mock recalculation quote for step 2
    vi.mocked(getSwapQuote).mockResolvedValueOnce(makeToken(DAI_ADDRESS, 3100000000000000000000n, 1)); // 3100 DAI

    // Mock swap 2: USDC -> DAI
    vi.mocked(executeOdosSwapOrTransfer).mockResolvedValueOnce({
      amount: 3098000000000000000000n, // 3098 DAI (slightly less due to slippage)
      transactionHash: "0xswap2",
    });

    const { values: intermediateStates, finalValue: finalState } = await consumeGenerator(
      executeConsolidationPlan(mockState, mockWalletClient),
    );

    // Track state changes through execution
    expect(intermediateStates.length).toBeGreaterThan(0);

    // Find state after step 1 completes
    const stateAfterStep1 = intermediateStates.find(
      (s) => s.results["step-1"]?.status === "success" && s.results["step-2"]?.status !== "success",
    );

    expect(stateAfterStep1).toBeDefined();
    if (stateAfterStep1) {
      // After step 1: step 2 input should be recalculated
      expect(stateAfterStep1.plan[1].inputTokens[0].amount).toBe(3100000000n); // Updated from 3000 to 3100
      expect(stateAfterStep1.plan[1].outputToken.amount).toBe(3100000000000000000000n); // Recalculated estimate

      // Step 1 result should have actual output
      expect(stateAfterStep1.results["step-1"].actualOutput?.amount).toBe(3100000000n);
    }

    // Final state checks
    expect(finalState.status).toBe("completed");
    expect(finalState.results["step-1"].actualOutput?.amount).toBe(3100000000n);
    expect(finalState.results["step-2"].actualOutput?.amount).toBe(3098000000000000000000n);

    // Verify provenance was used correctly
    expect(finalState.plan[1].inputTokens[0].provenance).toBe("step-1");
  });

  test("value changes with multiple dependencies - track cascade effect", async () => {
    const DAI_ADDRESS = "0x6B175474E89094C44Da98b954EedeAC495271d0F" as Address;
    const WETH_ADDRESS = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" as Address;
    const WBTC_ADDRESS = "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599" as Address;

    // Complex: swap1 (WETH->USDC) + swap2 (DAI->USDC) -> swap3 (USDC->WBTC)
    // Test that final swap gets updated amounts from both sources
    const step1: TransactionStep = {
      id: "step-1",
      type: "swap",
      status: "pending",
      chainId: 1,
      inputTokens: [makeToken(WETH_ADDRESS, 1000000000000000000n, 1)],
      outputToken: makeToken(USDC_ADDRESS, 2000000000n, 1, { provenance: "step-1" }),
    };

    const step2: TransactionStep = {
      id: "step-2",
      type: "swap",
      status: "pending",
      chainId: 1,
      inputTokens: [makeToken(DAI_ADDRESS, 1000000000000000000000n, 1)],
      outputToken: makeToken(USDC_ADDRESS, 1000000000n, 1, { provenance: "step-2" }),
    };

    const step3: TransactionStep = {
      id: "step-3",
      type: "swap",
      status: "pending",
      chainId: 1,
      inputTokens: [
        makeToken(USDC_ADDRESS, 2000000000n, 1, { provenance: "step-1" }),
        makeToken(USDC_ADDRESS, 1000000000n, 1, { provenance: "step-2" }),
      ],
      outputToken: makeToken(WBTC_ADDRESS, 10000000n, 1),
    };

    mockState.plan = [step1, step2, step3];

    // Mock swap 1 with better output
    vi.mocked(executeOdosSwapOrTransfer).mockResolvedValueOnce({
      amount: 2100000000n, // 2100 USDC (estimated 2000)
      transactionHash: "0xswap1",
    });

    // Mock swap 2 with worse output
    vi.mocked(executeOdosSwapOrTransfer).mockResolvedValueOnce({
      amount: 950000000n, // 950 USDC (estimated 1000)
      transactionHash: "0xswap2",
    });

    // Mock recalculation quote for step 3 (uses actual amounts from both swaps)
    vi.mocked(getSwapQuote).mockResolvedValueOnce(makeToken(WBTC_ADDRESS, 10200000n, 1)); // Updated estimate

    // Mock swap 3
    vi.mocked(executeOdosSwapOrTransfer).mockResolvedValueOnce({
      amount: 10150000n,
      transactionHash: "0xswap3",
    });

    const { values: intermediateStates, finalValue: finalState } = await consumeGenerator(
      executeConsolidationPlan(mockState, mockWalletClient),
    );

    // Find state after step 1 completes (before step 2)
    const stateAfterStep1 = intermediateStates.find(
      (s) => s.results["step-1"]?.status === "success" && !s.results["step-2"],
    );

    expect(stateAfterStep1).toBeDefined();
    if (stateAfterStep1) {
      // Step 3 first input should be updated from step 1
      expect(stateAfterStep1.plan[2].inputTokens[0].amount).toBe(2100000000n); // Updated from step 1
      // Step 3 second input not yet updated (step 2 hasn't run)
      expect(stateAfterStep1.plan[2].inputTokens[1].amount).toBe(1000000000n); // Original estimate
    }

    // Verify final state has both inputs updated
    expect(finalState.plan[2].inputTokens[0].amount).toBe(2100000000n); // From step 1
    expect(finalState.plan[2].inputTokens[1].amount).toBe(950000000n); // From step 2

    // Verify getSwapQuote was called with both updated amounts for step 3
    expect(getSwapQuote).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ amount: 2100000000n, provenance: "step-1" }),
        expect.objectContaining({ amount: 950000000n, provenance: "step-2" }),
      ]),
      expect.objectContaining({ token: WBTC_ADDRESS }),
    );

    expect(finalState.status).toBe("completed");
    expect(finalState.results["step-3"].actualOutput?.amount).toBe(10150000n);
  });

  test("value changes with partial execution - track state before and after pause", async () => {
    const step1: TransactionStep = {
      id: "step-1",
      type: "swap",
      status: "pending",
      chainId: 1,
      inputTokens: [makeToken(USDC_ADDRESS, 1000000n, 1)],
      outputToken: makeToken(USDC_ADDRESS, 1000000n, 1),
    };

    const step2: TransactionStep = {
      id: "step-2",
      type: "bridge",
      status: "pending",
      chainId: 1,
      inputTokens: [makeToken(USDC_ADDRESS, 1000000n, 1, { provenance: "step-1" })],
      outputToken: makeToken(USDC_ADDRESS, 1000000n, 10),
    };

    mockState.plan = [step1, step2];

    // Step 1 succeeds with different amount
    vi.mocked(executeOdosSwapOrTransfer).mockResolvedValueOnce({
      amount: 980000n,
      transactionHash: "0xswap1",
    });

    // Step 2 fails
    vi.mocked(executeCCTPBurn).mockRejectedValueOnce(new Error("Bridge network error"));

    const { values: intermediateStates, finalValue: finalState } = await consumeGenerator(
      executeConsolidationPlan(mockState, mockWalletClient),
    );

    // Find state right before step 2 execution
    const stateBeforeStep2 = intermediateStates.find(
      (s) => s.results["step-1"]?.status === "success" && !s.results["step-2"],
    );

    expect(stateBeforeStep2).toBeDefined();
    if (stateBeforeStep2) {
      // Step 2 should have recalculated input
      expect(stateBeforeStep2.plan[1].inputTokens[0].amount).toBe(980000n);
      expect(stateBeforeStep2.plan[1].outputToken.amount).toBe(980000n);
    }

    // Final state should be paused with step 1 success, step 2 failed
    expect(finalState.status).toBe("paused");
    expect(finalState.results["step-1"].status).toBe("success");
    expect(finalState.results["step-1"].actualOutput?.amount).toBe(980000n);
    expect(finalState.results["step-2"].status).toBe("failed");

    // Plan should still reflect recalculated values for potential retry
    expect(finalState.plan[1].inputTokens[0].amount).toBe(980000n);
  });

  test("partial dependency adaptation - attestation adapts when some bridges fail", async () => {
    const bridge1: TransactionStep = {
      id: "bridge-1",
      type: "bridge",
      status: "pending",
      chainId: 137,
      inputTokens: [makeToken(USDC_ADDRESS, 500000n, 137)],
      outputToken: makeToken(USDC_ADDRESS, 500000n, 1, { provenance: "bridge-1" }),
    };

    const bridge2: TransactionStep = {
      id: "bridge-2",
      type: "bridge",
      status: "pending",
      chainId: 10,
      inputTokens: [makeToken(USDC_ADDRESS, 500000n, 10)],
      outputToken: makeToken(USDC_ADDRESS, 500000n, 1, { provenance: "bridge-2" }),
    };

    const attestation: TransactionStep = {
      id: "attestation-1",
      type: "attestation",
      status: "pending",
      chainId: 1,
      inputTokens: [bridge1.outputToken, bridge2.outputToken],
      outputToken: makeToken(USDC_ADDRESS, 0n, 1),
    };

    mockState.plan = [bridge1, bridge2, attestation];
    mockState.hasSubsequentExecution = true;

    vi.mocked(executeCCTPBurn)
      .mockResolvedValueOnce(["0xabc", 137]) // Bridge 1 succeeds
      .mockRejectedValueOnce(new Error("Bridge failed")); // Bridge 2 fails

    const { finalValue: finalState } = await consumeGenerator(executeConsolidationPlan(mockState, mockWalletClient));

    expect(finalState.results["bridge-1"].status).toBe("success");
    expect(finalState.results["bridge-2"].status).toBe("failed");
    expect(finalState.results["attestation-1"].status).toBe("success"); // Not skipped - at least one input token has successful provenance
  });

  test("transfer step - should transfer tokens from one wallet to another", async () => {
    const WALLET_2 = "0x2234567890123456789012345678901234567890" as Address;

    const transferStep: TransactionStep = {
      id: "transfer-1",
      type: "transfer",
      status: "pending",
      chainId: 1,
      inputTokens: [makeToken(USDC_ADDRESS, 500000n, 1)],
      outputToken: { ...makeToken(USDC_ADDRESS, 500000n, 1), walletAddress: WALLET_2 },
    };

    mockState.plan = [transferStep];

    // Mock prepareSendCalls for this specific test
    vi.mocked(prepareSendCalls).mockReturnValue(vi.fn().mockResolvedValue(["0xtransfer123", []]));

    const { finalValue: finalState } = await consumeGenerator(executeConsolidationPlan(mockState, mockWalletClient));

    expect(finalState.status).toBe("completed");
    expect(finalState.results["transfer-1"].status).toBe("success");
    expect(finalState.results["transfer-1"].transactionHash).toBe("0xtransfer123");
    expect(finalState.results["transfer-1"].actualOutput?.amount).toBe(500000n);
  });

  // === Error Handling & Edge Cases for 100% Coverage ===

  test("throws error when starting with invalid state status", async () => {
    const invalidState: ConsolidationState = {
      ...mockState,
      status: "completed",
    };

    await expect(async () => {
      await consumeGenerator(executeConsolidationPlan(invalidState, mockWalletClient));
    }).rejects.toThrow("Invalid state: must be 'ready', 'paused', or 'executing'");
  });

  test("attestation step fails when no bridge transactions found", async () => {
    const attestationStep: TransactionStep = {
      id: "attestation-1",
      type: "attestation",
      status: "pending",
      chainId: 1,
      inputTokens: [makeToken(USDC_ADDRESS, 1000000n, 1)],
      outputToken: makeToken(USDC_ADDRESS, 0n, 1),
    };

    mockState.plan = [attestationStep];
    // No successful bridge results, so no transactions to attest
    mockState.results = {};

    const { finalValue: finalState } = await consumeGenerator(executeConsolidationPlan(mockState, mockWalletClient));

    // Should pause due to error
    expect(finalState.status).toBe("paused");
    expect(finalState.results["attestation-1"].status).toBe("failed");
    const errorDetails = finalState.results["attestation-1"].error?.details;
    expect(errorDetails).toBeInstanceOf(Error);
    expect((errorDetails as Error).message).toContain("No bridge transactions found for attestation");
  });

  test("claim step fails when no attestations found in metadata", async () => {
    const claimStep: TransactionStep = {
      id: "claim-1",
      type: "claim",
      status: "pending",
      chainId: 1,
      inputTokens: [makeToken(USDC_ADDRESS, 1000000n, 1)],
      outputToken: makeToken(USDC_ADDRESS, 1000000n, 1),
    };

    const stateWithoutAttestations: ConsolidationState = {
      ...mockState,
      plan: [claimStep],
      metadata: { attestations: [] }, // Empty attestations
    };

    const { finalValue: finalState } = await consumeGenerator(
      executeConsolidationPlan(stateWithoutAttestations, mockWalletClient),
    );

    // Should pause due to error
    expect(finalState.status).toBe("paused");
    expect(finalState.results["claim-1"].status).toBe("failed");
    const errorDetails = finalState.results["claim-1"].error?.details;
    expect(errorDetails).toBeInstanceOf(Error);
    expect((errorDetails as Error).message).toContain("No attestations found for claim");
  });

  test("transfer step fails with multiple input tokens", async () => {
    const DAI_ADDRESS = "0x6B175474E89094C44Da98b954EedeAC495271d0F" as Address;

    const invalidTransferStep: TransactionStep = {
      id: "transfer-1",
      type: "transfer",
      status: "pending",
      chainId: 1,
      inputTokens: [
        makeToken(USDC_ADDRESS, 1000000n, 1),
        makeToken(DAI_ADDRESS, 2000000n, 1, { walletAddress: WALLET, symbol: "DAI", decimals: 18 }), // Second input - invalid!
      ],
      outputToken: makeToken(USDC_ADDRESS, 1000000n, 1),
    };

    mockState.plan = [invalidTransferStep];

    const { finalValue: finalState } = await consumeGenerator(executeConsolidationPlan(mockState, mockWalletClient));

    // Should pause due to validation error
    expect(finalState.status).toBe("paused");
    expect(finalState.results["transfer-1"].status).toBe("failed");
    const errorDetails = finalState.results["transfer-1"].error?.details;
    expect(errorDetails).toBeInstanceOf(Error);
    expect((errorDetails as Error).message).toContain("Transfer step can only have one input token");
  });

  test("transfer step fails when input and output chains differ", async () => {
    const invalidTransferStep: TransactionStep = {
      id: "transfer-1",
      type: "transfer",
      status: "pending",
      chainId: 1,
      inputTokens: [makeToken(USDC_ADDRESS, 1000000n, 1)], // Chain 1
      outputToken: makeToken(USDC_ADDRESS, 1000000n, 137), // Chain 137 - mismatch!
    };

    mockState.plan = [invalidTransferStep];

    const { finalValue: finalState } = await consumeGenerator(executeConsolidationPlan(mockState, mockWalletClient));

    // Should pause due to validation error
    expect(finalState.status).toBe("paused");
    expect(finalState.results["transfer-1"].status).toBe("failed");
    const errorDetails = finalState.results["transfer-1"].error?.details;
    expect(errorDetails).toBeInstanceOf(Error);
    expect((errorDetails as Error).message).toContain("Transfer source and destination must be on the same chain");
  });

  test("fails on unknown step type", async () => {
    const invalidStep = {
      id: "invalid-1",
      // biome-ignore lint/suspicious/noExplicitAny: Testing invalid step type handling
      type: "unknown-type" as any,
      status: "pending" as const,
      chainId: 1,
      inputTokens: [makeToken(USDC_ADDRESS, 1000000n, 1)] as [TokenAmount, ...TokenAmount[]],
      outputToken: makeToken(USDC_ADDRESS, 1000000n, 1),
    };

    mockState.plan = [invalidStep];

    const { finalValue: finalState } = await consumeGenerator(executeConsolidationPlan(mockState, mockWalletClient));

    // Should pause due to unknown step type error
    expect(finalState.status).toBe("paused");
    expect(finalState.results["invalid-1"].status).toBe("failed");
    const errorDetails = finalState.results["invalid-1"].error?.details;
    expect(errorDetails).toBeInstanceOf(Error);
    expect((errorDetails as Error).message).toContain("Unknown step type: unknown-type");
  });

  test("recalculation falls back to original output when quote fails", async () => {
    const step1: TransactionStep = {
      id: "step-1",
      type: "swap",
      status: "pending",
      chainId: 1,
      inputTokens: [makeToken(USDC_ADDRESS, 1000000n, 1)],
      outputToken: makeToken(USDC_ADDRESS, 500000n, 1),
    };

    const step2: TransactionStep = {
      id: "step-2",
      type: "swap",
      status: "pending",
      chainId: 1,
      inputTokens: [makeToken(USDC_ADDRESS, 500000n, 1)],
      outputToken: makeToken(USDC_ADDRESS, 250000n, 1),
    };

    mockState.plan = [step1, step2];

    // First swap succeeds
    vi.mocked(executeOdosSwapOrTransfer).mockResolvedValueOnce({
      amount: 600000n, // Actual output differs
      transactionHash: "0xswap1",
    });

    // Mock getSwapQuote to fail on recalculation for step2
    vi.mocked(getSwapQuote)
      .mockRejectedValueOnce(new Error("Quote API failed")) // Fails during recalculation
      .mockResolvedValueOnce(makeToken(USDC_ADDRESS, 250000n, 1)); // But step2 still executes

    // Second swap succeeds despite quote failure
    vi.mocked(executeOdosSwapOrTransfer).mockResolvedValueOnce({
      amount: 300000n,
      transactionHash: "0xswap2",
    });

    const { finalValue: finalState } = await consumeGenerator(executeConsolidationPlan(mockState, mockWalletClient));

    // Execution should complete successfully despite quote failure
    expect(finalState.status).toBe("completed");
    expect(finalState.results["step-1"].status).toBe("success");
    expect(finalState.results["step-2"].status).toBe("success");
  });
});

describe("recalculatePlan - comprehensive coverage", () => {
  const USDC_ADDRESS = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address;
  const DAI_ADDRESS = "0x6B175474E89094C44Da98b954EedeAC495271d0F" as Address;
  const WETH_ADDRESS = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" as Address;

  let mockWalletClient: WalletClient<HttpTransport, Chain, Account>;

  // Helper to create a step with custom type and tokens
  const createStep = (
    id: string,
    type: TransactionStep["type"],
    inputTokens: [TokenAmount, ...TokenAmount[]],
    outputToken: TokenAmount,
  ): TransactionStep => ({
    id,
    type,
    status: "pending",
    chainId: inputTokens[0].chainId,
    inputTokens,
    outputToken,
  });

  beforeEach(() => {
    vi.clearAllMocks();

    mockWalletClient = {
      account: { address: WALLET } as Account,
      chain: { id: 1 } as Chain,
    } as WalletClient<HttpTransport, Chain, Account>;

    vi.mocked(getSwapQuote).mockResolvedValue(makeToken(USDC_ADDRESS, 1000000n, 1));
    vi.mocked(executeOdosSwapOrTransfer).mockResolvedValue({ amount: 1000000n, transactionHash: "0xswap" });
    vi.mocked(executeCCTPBurn).mockResolvedValue(["0xburn", 1]);
    vi.mocked(retrieveAttestations).mockResolvedValue([
      {
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
      },
    ]);
    vi.mocked(executeCCTPMint).mockResolvedValue(["0xmint", []]);
  });

  test("recalculation cascades through multiple dependent steps", async () => {
    const step1: TransactionStep = createStep(
      "step-1",
      "swap",
      [makeToken(WETH_ADDRESS, 1000000n, 1)],
      makeToken(USDC_ADDRESS, 2000000n, 1),
    );

    const step2: TransactionStep = createStep(
      "step-2",
      "bridge",
      [makeToken(USDC_ADDRESS, 2000000n, 1, { provenance: "step-1" })],
      makeToken(USDC_ADDRESS, 2000000n, 10),
    );

    const step3: TransactionStep = createStep(
      "step-3",
      "claim",
      [makeToken(USDC_ADDRESS, 2000000n, 10, { provenance: "step-2" })],
      makeToken(USDC_ADDRESS, 2000000n, 10),
    );

    const step4: TransactionStep = createStep(
      "step-4",
      "swap",
      [makeToken(USDC_ADDRESS, 2000000n, 10, { provenance: "step-3" })],
      makeToken(DAI_ADDRESS, 2000000n, 10),
    );

    const state: ConsolidationState = {
      id: "test",
      plan: [step1, step2, step3, step4],
      currentStepIndex: 0,
      status: "ready",
      results: {},
      sourceTokens: [],
      destinationToken: makeToken(DAI_ADDRESS, 0n, 10),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      hasSubsequentExecution: false,
    };

    // Step 1 swap execution
    vi.mocked(executeOdosSwapOrTransfer).mockResolvedValueOnce({
      amount: 2500000n,
      transactionHash: "0xswap1",
    });

    // Recalculation quotes for step 4 (called after step 1 completes)
    vi.mocked(getSwapQuote).mockResolvedValueOnce(makeToken(DAI_ADDRESS, 2500000n, 10));

    // Step 4 swap execution (uses the recalculated input)
    vi.mocked(executeOdosSwapOrTransfer).mockResolvedValueOnce({
      amount: 2500000n,
      transactionHash: "0xswap4",
    });

    const { finalValue: finalState } = await consumeGenerator(executeConsolidationPlan(state, mockWalletClient));

    // The key test: all steps should have cascaded amounts through dependencies
    expect(finalState.plan[1].inputTokens[0].amount).toBe(2500000n); // Step 2 input cascaded from step 1
    expect(finalState.plan[1].outputToken.amount).toBe(2500000n); // Step 2 output (1:1 for bridge)
    expect(finalState.plan[2].inputTokens[0].amount).toBe(2500000n); // Step 3 input cascaded from step 2
    expect(finalState.plan[2].outputToken.amount).toBe(2500000n); // Step 3 output (1:1 for claim)
    expect(finalState.plan[3].inputTokens[0].amount).toBe(2500000n); // Step 4 input cascaded from step 3 - proves cascade works!
  });

  test("recalculation updates multi-input swap with all inputs", async () => {
    const USDT_ADDRESS = "0xdAC17F958D2ee523a2206206994597C13D831ec7" as Address;

    const step1: TransactionStep = createStep(
      "step-1",
      "swap",
      [makeToken(WETH_ADDRESS, 1000000n, 1)],
      makeToken(USDC_ADDRESS, 2000000n, 1),
    );

    const step2: TransactionStep = createStep(
      "step-2",
      "swap",
      [
        makeToken(USDC_ADDRESS, 2000000n, 1, { provenance: "step-1" }), // Has provenance
        makeToken(USDT_ADDRESS, 3000000n, 1), // No provenance
      ],
      makeToken(DAI_ADDRESS, 5000000n, 1),
    );

    const state: ConsolidationState = {
      id: "test",
      plan: [step1, step2],
      currentStepIndex: 0,
      status: "ready",
      results: {},
      sourceTokens: [],
      destinationToken: makeToken(DAI_ADDRESS, 0n, 1),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      hasSubsequentExecution: false,
    };

    // Step 1 completes with 2.5 USDC instead of 2 USDC
    vi.mocked(executeOdosSwapOrTransfer).mockResolvedValueOnce({
      amount: 2500000n,
      transactionHash: "0xswap1",
    });

    // Mock getSwapQuote to be called with BOTH inputs
    vi.mocked(getSwapQuote).mockResolvedValueOnce(makeToken(DAI_ADDRESS, 5500000n, 1));

    await consumeGenerator(executeConsolidationPlan(state, mockWalletClient));

    // Verify getSwapQuote was called with array of both inputs
    expect(getSwapQuote).toHaveBeenCalledWith(
      [
        expect.objectContaining({ token: USDC_ADDRESS, amount: 2500000n }), // Updated
        expect.objectContaining({ token: USDT_ADDRESS, amount: 3000000n }), // Unchanged
      ],
      expect.objectContaining({ token: DAI_ADDRESS }),
    );
  });

  test("recalculation handles transfer step with 1:1 amount passthrough", async () => {
    const WALLET_2 = "0x2234567890123456789012345678901234567890" as Address;

    const step1: TransactionStep = createStep(
      "step-1",
      "swap",
      [makeToken(WETH_ADDRESS, 1000000n, 1)],
      makeToken(USDC_ADDRESS, 2000000n, 1),
    );

    const step2: TransactionStep = createStep(
      "step-2",
      "transfer",
      [makeToken(USDC_ADDRESS, 2000000n, 1, { provenance: "step-1" })],
      {
        ...makeToken(USDC_ADDRESS, 2000000n, 1),
        walletAddress: WALLET_2,
      },
    );

    const state: ConsolidationState = {
      id: "test",
      plan: [step1, step2],
      currentStepIndex: 0,
      status: "ready",
      results: {},
      sourceTokens: [],
      destinationToken: makeToken(USDC_ADDRESS, 0n, 1),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      hasSubsequentExecution: false,
    };

    // Step 1 completes with 2.3 USDC
    vi.mocked(executeOdosSwapOrTransfer).mockResolvedValueOnce({
      amount: 2300000n,
      transactionHash: "0xswap1",
    });

    const { finalValue: finalState } = await consumeGenerator(executeConsolidationPlan(state, mockWalletClient));

    // Transfer should pass through the exact amount
    expect(finalState.plan[1].inputTokens[0].amount).toBe(2300000n);
    expect(finalState.plan[1].outputToken.amount).toBe(2300000n);
  });

  test("recalculation skips steps that don't depend on completed step", async () => {
    const step1: TransactionStep = createStep(
      "step-1",
      "swap",
      [makeToken(WETH_ADDRESS, 1000000n, 1)],
      makeToken(USDC_ADDRESS, 2000000n, 1),
    );

    const step2: TransactionStep = createStep(
      "step-2",
      "swap",
      [makeToken(DAI_ADDRESS, 3000000n, 1)],
      makeToken(USDC_ADDRESS, 3000000n, 1),
    );

    const step3: TransactionStep = createStep(
      "step-3",
      "bridge",
      [makeToken(USDC_ADDRESS, 2000000n, 1, { provenance: "step-1" })],
      makeToken(USDC_ADDRESS, 2000000n, 10),
    );

    const state: ConsolidationState = {
      id: "test",
      plan: [step1, step2, step3],
      currentStepIndex: 0,
      status: "ready",
      results: {},
      sourceTokens: [],
      destinationToken: makeToken(USDC_ADDRESS, 0n, 10),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      hasSubsequentExecution: false,
    };

    // Step 1 completes with different amount
    vi.mocked(executeOdosSwapOrTransfer).mockResolvedValueOnce({
      amount: 2500000n,
      transactionHash: "0xswap1",
    });

    const { finalValue: finalState } = await consumeGenerator(executeConsolidationPlan(state, mockWalletClient));

    // Step 2 should NOT be updated (no dependency)
    expect(finalState.plan[1].inputTokens[0].amount).toBe(3000000n);
    expect(finalState.plan[1].outputToken.amount).toBe(3000000n);

    // Step 3 should be updated (depends on step 1)
    expect(finalState.plan[2].inputTokens[0].amount).toBe(2500000n);
    expect(finalState.plan[2].outputToken.amount).toBe(2500000n);
  });

  test("recalculation handles attestation step (no amount change)", async () => {
    const step1: TransactionStep = createStep(
      "step-1",
      "bridge",
      [makeToken(USDC_ADDRESS, 2000000n, 1)],
      makeToken(USDC_ADDRESS, 2000000n, 10),
    );

    const step2: TransactionStep = createStep(
      "step-2",
      "attestation",
      [makeToken(USDC_ADDRESS, 2000000n, 10)],
      makeToken(USDC_ADDRESS, 0n, 10),
    );

    const state: ConsolidationState = {
      id: "test",
      plan: [step1, step2],
      currentStepIndex: 0,
      status: "ready",
      results: {},
      sourceTokens: [],
      destinationToken: makeToken(USDC_ADDRESS, 0n, 10),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      hasSubsequentExecution: false,
    };

    vi.mocked(executeCCTPBurn).mockResolvedValueOnce(["0xburn", 1]);
    vi.mocked(retrieveAttestations).mockResolvedValueOnce([
      {
        message: `0x${"00".repeat(32)}`,
        attestation: `0x${"00".repeat(65)}`,
        status: "complete",
        decodedMessage: {
          nonce: `0x${"00".repeat(32)}`,
          destinationDomain: "0",
          decodedMessageBody: {
            amount: "2500000",
            feeExecuted: "0",
          },
        },
      },
    ]);

    const { finalValue: finalState } = await consumeGenerator(executeConsolidationPlan(state, mockWalletClient));

    // Attestation output should remain unchanged
    expect(finalState.plan[1].outputToken.amount).toBe(0n);
  });

  test("recalculation preserves inputs that don't match changed output", async () => {
    const USDT_ADDRESS = "0xdAC17F958D2ee523a2206206994597C13D831ec7" as Address;

    const step1: TransactionStep = createStep(
      "step-1",
      "swap",
      [makeToken(WETH_ADDRESS, 1000000n, 1)],
      makeToken(USDC_ADDRESS, 2000000n, 1),
    );

    const step2: TransactionStep = createStep(
      "step-2",
      "swap",
      [makeToken(USDC_ADDRESS, 2000000n, 1, { provenance: "step-1" }), makeToken(USDT_ADDRESS, 5000000n, 1)],
      makeToken(DAI_ADDRESS, 7000000n, 1),
    );

    const state: ConsolidationState = {
      id: "test",
      plan: [step1, step2],
      currentStepIndex: 0,
      status: "ready",
      results: {},
      sourceTokens: [],
      destinationToken: makeToken(DAI_ADDRESS, 0n, 1),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      hasSubsequentExecution: false,
    };

    vi.mocked(executeOdosSwapOrTransfer).mockResolvedValueOnce({
      amount: 2100000n,
      transactionHash: "0xswap1",
    });

    vi.mocked(getSwapQuote).mockResolvedValueOnce(makeToken(DAI_ADDRESS, 7100000n, 1));

    const { finalValue: finalState } = await consumeGenerator(executeConsolidationPlan(state, mockWalletClient));

    // USDC should be updated
    expect(finalState.plan[1].inputTokens[0].amount).toBe(2100000n);
    // USDT should remain unchanged
    expect(finalState.plan[1].inputTokens[1].amount).toBe(5000000n);
  });

  test("recalculation updates only correct matching input when multiple tokens match", async () => {
    const WALLET_2 = "0x2234567890123456789012345678901234567890" as Address;

    const step1: TransactionStep = createStep(
      "step-1",
      "swap",
      [makeToken(WETH_ADDRESS, 1000000n, 1)],
      makeToken(USDC_ADDRESS, 2000000n, 1),
    );

    const step2: TransactionStep = createStep(
      "step-2",
      "swap",
      [
        makeToken(USDC_ADDRESS, 2000000n, 1, { provenance: "step-1" }),
        makeToken(USDC_ADDRESS, 1000000n, 1, { walletAddress: WALLET_2 }),
      ],
      makeToken(DAI_ADDRESS, 3000000n, 1),
    );

    const state: ConsolidationState = {
      id: "test",
      plan: [step1, step2],
      currentStepIndex: 0,
      status: "ready",
      results: {},
      sourceTokens: [],
      destinationToken: makeToken(DAI_ADDRESS, 0n, 1),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      hasSubsequentExecution: false,
    };

    vi.mocked(executeOdosSwapOrTransfer).mockResolvedValueOnce({
      amount: 2500000n,
      transactionHash: "0xswap1",
    });

    vi.mocked(getSwapQuote).mockResolvedValueOnce(makeToken(DAI_ADDRESS, 3500000n, 1));

    const { finalValue: finalState } = await consumeGenerator(executeConsolidationPlan(state, mockWalletClient));

    // First USDC from WALLET should be updated
    expect(finalState.plan[1].inputTokens[0].amount).toBe(2500000n);
    expect(finalState.plan[1].inputTokens[0].walletAddress).toBe(WALLET);
    // Second USDC from WALLET_2 should remain unchanged
    expect(finalState.plan[1].inputTokens[1].amount).toBe(1000000n);
    expect(finalState.plan[1].inputTokens[1].walletAddress).toBe(WALLET_2);
  });

  test("recalculation with deep cascade (4 levels)", async () => {
    const step1: TransactionStep = createStep(
      "step-1",
      "swap",
      [makeToken(WETH_ADDRESS, 1000000n, 1)],
      makeToken(USDC_ADDRESS, 1000000n, 1),
    );

    const step2: TransactionStep = createStep(
      "step-2",
      "bridge",
      [makeToken(USDC_ADDRESS, 1000000n, 1, { provenance: "step-1" })],
      makeToken(USDC_ADDRESS, 1000000n, 10),
    );

    const step3: TransactionStep = createStep(
      "step-3",
      "claim",
      [makeToken(USDC_ADDRESS, 1000000n, 10, { provenance: "step-2" })],
      makeToken(USDC_ADDRESS, 1000000n, 10),
    );

    const step4: TransactionStep = createStep(
      "step-4",
      "transfer",
      [makeToken(USDC_ADDRESS, 1000000n, 10, { provenance: "step-3" })],
      makeToken(USDC_ADDRESS, 1000000n, 10),
    );

    const state: ConsolidationState = {
      id: "test",
      plan: [step1, step2, step3, step4],
      currentStepIndex: 0,
      status: "ready",
      results: {},
      sourceTokens: [],
      destinationToken: makeToken(USDC_ADDRESS, 0n, 10),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      hasSubsequentExecution: false,
    };

    vi.mocked(executeOdosSwapOrTransfer).mockResolvedValueOnce({
      amount: 1200000n,
      transactionHash: "0xswap1",
    });

    // Mock wallet methods for transfer step
    mockWalletClient.sendCalls = vi.fn().mockResolvedValue({ id: "test-id" });
    mockWalletClient.waitForCallsStatus = vi.fn().mockResolvedValue({
      status: "success",
      receipts: [{ transactionHash: "0xtransfer", logs: [] }],
    });
    mockWalletClient.switchChain = vi.fn();

    const { finalValue: finalState } = await consumeGenerator(executeConsolidationPlan(state, mockWalletClient));

    // All 4 steps should cascade the change
    expect(finalState.plan[1].inputTokens[0].amount).toBe(1200000n);
    expect(finalState.plan[1].outputToken.amount).toBe(1200000n);
    expect(finalState.plan[2].inputTokens[0].amount).toBe(1200000n);
    expect(finalState.plan[2].outputToken.amount).toBe(1200000n);
    expect(finalState.plan[3].inputTokens[0].amount).toBe(1200000n);
    expect(finalState.plan[3].outputToken.amount).toBe(1200000n);
  });

  test("bridge with multiple swaps + existing USDC - recalculation preserves all sources", async () => {
    // Setup: 2 swaps + existing USDC → bridge
    // Uses provenance: inputTokens[0,1] have provenance, inputTokens[2] does not
    const existingUSDC = makeToken(USDC_ADDRESS, 398000000n, 10); // No provenance - existing USDC

    const swap1: TransactionStep = createStep(
      "step-1",
      "swap",
      [makeToken(WETH_ADDRESS, 1000000n, 10)],
      makeToken(USDC_ADDRESS, 784000000n, 10, { provenance: "step-1" }), // Has provenance
    );

    const swap2: TransactionStep = createStep(
      "step-2",
      "swap",
      [makeToken(DAI_ADDRESS, 500000n, 10)],
      makeToken(USDC_ADDRESS, 201000000n, 10, { provenance: "step-2" }), // Has provenance
    );

    const bridge: TransactionStep = createStep(
      "step-3",
      "bridge",
      [
        makeToken(USDC_ADDRESS, 784000000n, 10, { provenance: "step-1" }), // Has provenance from step-1
        makeToken(USDC_ADDRESS, 201000000n, 10, { provenance: "step-2" }), // Has provenance from step-2
        existingUSDC, // No provenance - won't be updated
      ],
      makeToken(USDC_ADDRESS, 1383000000n, 1, { provenance: "step-3" }), // Output on different chain
    );

    const state: ConsolidationState = {
      id: "test",
      plan: [swap1, swap2, bridge],
      currentStepIndex: 0,
      status: "ready",
      results: {},
      sourceTokens: [],
      destinationToken: makeToken(USDC_ADDRESS, 0n, 1),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      hasSubsequentExecution: false,
    };

    // Mock swap1 to produce actual amount 784.5 USDC
    vi.mocked(executeOdosSwapOrTransfer)
      .mockResolvedValueOnce({ amount: 784500000n, transactionHash: "0xswap1" })
      .mockResolvedValueOnce({ amount: 200500000n, transactionHash: "0xswap2" });

    // Mock bridge execution
    vi.mocked(executeCCTPBurn).mockResolvedValueOnce(["0xbridge", 10]);

    const { finalValue: finalState } = await consumeGenerator(executeConsolidationPlan(state, mockWalletClient));

    // Verify swap 1 completed
    expect(finalState.results["step-1"].status).toBe("success");
    expect(finalState.results["step-1"].actualOutput?.amount).toBe(784500000n);

    // Verify swap 2 completed
    expect(finalState.results["step-2"].status).toBe("success");
    expect(finalState.results["step-2"].actualOutput?.amount).toBe(200500000n);

    // CRITICAL: Verify bridge has all 3 inputs preserved with correct amounts
    const bridgeStep = finalState.plan[2];
    expect(bridgeStep.inputTokens).toHaveLength(3);

    // First input: swap1 output (updated to actual via provenance)
    expect(bridgeStep.inputTokens[0].amount).toBe(784500000n);
    expect(bridgeStep.inputTokens[0].provenance).toBe("step-1");

    // Second input: swap2 output (updated to actual via provenance)
    expect(bridgeStep.inputTokens[1].amount).toBe(200500000n);
    expect(bridgeStep.inputTokens[1].provenance).toBe("step-2");

    // Third input: existing USDC (unchanged - no provenance)
    expect(bridgeStep.inputTokens[2].amount).toBe(398000000n);
    expect(bridgeStep.inputTokens[2].provenance).toBeUndefined();

    // Verify bridge output reflects sum of all inputs
    const totalInput = 784500000n + 200500000n + 398000000n;
    expect(bridgeStep.outputToken.amount).toBe(totalInput);
  });

  test("swap with some zero-amount tokens - should filter them out and execute", async () => {
    const step1: TransactionStep = createStep(
      "step-1",
      "swap",
      [
        makeToken(WETH_ADDRESS, 1000000n, 1), // Non-zero
        makeToken(USDC_ADDRESS, 0n, 1), // Zero - should be filtered
        makeToken(DAI_ADDRESS, 500000n, 1), // Non-zero
      ],
      makeToken(USDC_ADDRESS, 1500000n, 1),
    );

    const state: ConsolidationState = {
      id: "test",
      plan: [step1],
      currentStepIndex: 0,
      status: "ready",
      results: {},
      sourceTokens: [],
      destinationToken: makeToken(USDC_ADDRESS, 0n, 1),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      hasSubsequentExecution: false,
    };

    vi.mocked(executeOdosSwapOrTransfer).mockResolvedValueOnce({
      amount: 1400000n,
      transactionHash: "0xswap1",
    });

    const { finalValue: finalState } = await consumeGenerator(executeConsolidationPlan(state, mockWalletClient));

    expect(finalState.status).toBe("completed");
    expect(finalState.results["step-1"].status).toBe("success");

    // Verify that executeOdosSwapOrTransfer was called with only non-zero tokens
    expect(executeOdosSwapOrTransfer).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ token: WETH_ADDRESS, amount: 1000000n }),
        expect.objectContaining({ token: DAI_ADDRESS, amount: 500000n }),
      ]),
      expect.anything(),
      expect.anything(),
    );

    // Verify zero-amount token was filtered out
    const callArgs = vi.mocked(executeOdosSwapOrTransfer).mock.calls[0][0];
    expect(callArgs).toHaveLength(2); // Only 2 tokens, not 3
    expect(callArgs.every((t: TokenAmount) => t.amount > 0n)).toBe(true);
  });

  test("swap with all zero-amount tokens - should throw error", async () => {
    const step1: TransactionStep = createStep(
      "step-1",
      "swap",
      [
        makeToken(WETH_ADDRESS, 0n, 1), // Zero
        makeToken(USDC_ADDRESS, 0n, 1), // Zero
      ],
      makeToken(DAI_ADDRESS, 0n, 1),
    );

    const state: ConsolidationState = {
      id: "test",
      plan: [step1],
      currentStepIndex: 0,
      status: "ready",
      results: {},
      sourceTokens: [],
      destinationToken: makeToken(DAI_ADDRESS, 0n, 1),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      hasSubsequentExecution: false,
    };

    const { finalValue: finalState } = await consumeGenerator(executeConsolidationPlan(state, mockWalletClient));

    expect(finalState.status).toBe("paused");
    expect(finalState.results["step-1"].status).toBe("failed");

    // Check the error details (original error) instead of the user-friendly message
    const errorDetails = finalState.results["step-1"].error?.details;
    expect(errorDetails instanceof Error).toBe(true);
    expect((errorDetails as Error).message).toContain("Cannot execute swap with zero input amounts");

    // Verify executeOdosSwapOrTransfer was never called
    expect(executeOdosSwapOrTransfer).not.toHaveBeenCalled();
  });

  test("bridge with some zero-amount tokens - should filter them out and execute", async () => {
    const step1: TransactionStep = createStep(
      "step-1",
      "bridge",
      [
        makeToken(USDC_ADDRESS, 1000000n, 1), // Non-zero
        makeToken(USDC_ADDRESS, 0n, 1), // Zero - should be filtered
        makeToken(USDC_ADDRESS, 500000n, 1), // Non-zero
      ],
      makeToken(USDC_ADDRESS, 1500000n, 10),
    );

    const state: ConsolidationState = {
      id: "test",
      plan: [step1],
      currentStepIndex: 0,
      status: "ready",
      results: {},
      sourceTokens: [],
      destinationToken: makeToken(USDC_ADDRESS, 0n, 10),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      hasSubsequentExecution: false,
    };

    vi.mocked(executeCCTPBurn).mockResolvedValueOnce(["0xburn1", 1]);

    const { finalValue: finalState } = await consumeGenerator(executeConsolidationPlan(state, mockWalletClient));

    expect(finalState.status).toBe("completed");
    expect(finalState.results["step-1"].status).toBe("success");

    // Verify that executeCCTPBurn was called with summed non-zero amounts
    expect(executeCCTPBurn).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 1500000n }), // 1000000n + 500000n (zero filtered out)
      expect.anything(),
      expect.anything(),
    );
  });

  test("bridge with all zero-amount tokens - should throw error", async () => {
    const step1: TransactionStep = createStep(
      "step-1",
      "bridge",
      [
        makeToken(USDC_ADDRESS, 0n, 1), // Zero
        makeToken(USDC_ADDRESS, 0n, 1), // Zero
      ],
      makeToken(USDC_ADDRESS, 0n, 10),
    );

    const state: ConsolidationState = {
      id: "test",
      plan: [step1],
      currentStepIndex: 0,
      status: "ready",
      results: {},
      sourceTokens: [],
      destinationToken: makeToken(USDC_ADDRESS, 0n, 10),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      hasSubsequentExecution: false,
    };

    const { finalValue: finalState } = await consumeGenerator(executeConsolidationPlan(state, mockWalletClient));

    expect(finalState.status).toBe("paused");
    expect(finalState.results["step-1"].status).toBe("failed");

    // Check the error details (original error) instead of the user-friendly message
    const errorDetails = finalState.results["step-1"].error?.details;
    expect(errorDetails instanceof Error).toBe(true);
    expect((errorDetails as Error).message).toContain("Cannot execute bridge with zero input amounts");

    // Verify executeCCTPBurn was never called
    expect(executeCCTPBurn).not.toHaveBeenCalled();
  });
});

describe("shouldSkipStep", () => {
  test("step with no input token provenance should not skip", () => {
    const step: TransactionStep = {
      id: "step-1",
      type: "swap",
      status: "pending",
      chainId: 1,
      inputTokens: [makeToken("0x789" as Address, 500n, 1)], // No provenance
      outputToken: makeToken("0x123" as Address, 1000n, 1),
    };
    const results: Record<string, StepResult> = {};

    expect(shouldSkipStep(step, results)).toBe(false);
  });

  test("step with all successful provenance steps should not skip", () => {
    const step: TransactionStep = {
      id: "step-2",
      type: "swap",
      status: "pending",
      chainId: 1,
      inputTokens: [makeToken("0x789" as Address, 500n, 1, { provenance: "step-1" })],
      outputToken: makeToken("0x123" as Address, 1000n, 1),
    };
    const results: Record<string, StepResult> = {
      "step-1": { stepId: "step-1", status: "success", chainId: 1 },
    };

    expect(shouldSkipStep(step, results)).toBe(false);
  });

  test("step with all failed provenance steps should skip", () => {
    const step: TransactionStep = {
      id: "step-2",
      type: "swap",
      status: "pending",
      chainId: 1,
      inputTokens: [makeToken("0x789" as Address, 500n, 1, { provenance: "step-1" })],
      outputToken: makeToken("0x123" as Address, 1000n, 1),
    };
    const results: Record<string, StepResult> = {
      "step-1": { stepId: "step-1", status: "failed", chainId: 1 },
    };

    expect(shouldSkipStep(step, results)).toBe(true);
  });

  test("step with all skipped provenance steps should skip", () => {
    const step: TransactionStep = {
      id: "step-2",
      type: "swap",
      status: "pending",
      chainId: 1,
      inputTokens: [makeToken("0x789" as Address, 500n, 1, { provenance: "step-1" })],
      outputToken: makeToken("0x123" as Address, 1000n, 1),
    };
    const results: Record<string, StepResult> = {
      "step-1": { stepId: "step-1", status: "skipped", chainId: 1 },
    };

    expect(shouldSkipStep(step, results)).toBe(true);
  });

  test("step with at least one successful provenance should not skip", () => {
    const step: TransactionStep = {
      id: "step-3",
      type: "claim",
      status: "pending",
      chainId: 1,
      inputTokens: [
        makeToken("0x789" as Address, 500n, 1, { provenance: "step-1" }),
        makeToken("0x789" as Address, 300n, 1, { provenance: "step-2" }),
      ],
      outputToken: makeToken("0x123" as Address, 800n, 1),
    };
    const results: Record<string, StepResult> = {
      "step-1": { stepId: "step-1", status: "success", chainId: 1 },
      "step-2": { stepId: "step-2", status: "failed", chainId: 1 },
    };

    expect(shouldSkipStep(step, results)).toBe(false);
  });

  test("step with all provenance steps failed should skip", () => {
    const step: TransactionStep = {
      id: "step-3",
      type: "claim",
      status: "pending",
      chainId: 1,
      inputTokens: [
        makeToken("0x789" as Address, 500n, 1, { provenance: "step-1" }),
        makeToken("0x789" as Address, 300n, 1, { provenance: "step-2" }),
      ],
      outputToken: makeToken("0x123" as Address, 800n, 1),
    };
    const results: Record<string, StepResult> = {
      "step-1": { stepId: "step-1", status: "failed", chainId: 1 },
      "step-2": { stepId: "step-2", status: "failed", chainId: 1 },
    };

    expect(shouldSkipStep(step, results)).toBe(true);
  });
});

describe("Additional edge cases for complete coverage", () => {
  const USDC_ADDRESS = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address;
  const DAI_ADDRESS = "0x6B175474E89094C44Da98b954EedeAC495271d0F" as Address;

  let mockWalletClient: WalletClient<HttpTransport, Chain, Account>;

  beforeEach(() => {
    vi.clearAllMocks();

    mockWalletClient = {
      account: { address: WALLET } as Account,
      chain: { id: 1 } as Chain,
    } as WalletClient<HttpTransport, Chain, Account>;

    vi.mocked(getSwapQuote).mockResolvedValue(makeToken(USDC_ADDRESS, 1000000n, 1));
    vi.mocked(executeOdosSwapOrTransfer).mockResolvedValue({ amount: 1000000n, transactionHash: "0xswap" });
    vi.mocked(executeCCTPBurn).mockResolvedValue(["0xburn", 1]);
    vi.mocked(retrieveAttestations).mockResolvedValue([
      {
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
      },
    ]);
    vi.mocked(executeCCTPMint).mockResolvedValue(["0xmint", []]);
  });

  test("bridge with heterogeneous tokens - different token addresses", async () => {
    const bridgeStep: TransactionStep = {
      id: "bridge-1",
      type: "bridge",
      status: "pending",
      chainId: 1,
      inputTokens: [
        makeToken(USDC_ADDRESS, 1000000n, 1),
        makeToken(DAI_ADDRESS, 2000000n, 1), // Different token!
      ],
      outputToken: makeToken(USDC_ADDRESS, 3000000n, 10),
    };

    const state: ConsolidationState = {
      id: "test",
      plan: [bridgeStep],
      currentStepIndex: 0,
      status: "ready",
      results: {},
      sourceTokens: [],
      destinationToken: makeToken(USDC_ADDRESS, 0n, 10),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      hasSubsequentExecution: false,
    };

    const { finalValue: finalState } = await consumeGenerator(executeConsolidationPlan(state, mockWalletClient));

    expect(finalState.status).toBe("paused");
    expect(finalState.results["bridge-1"].status).toBe("failed");
    const errorDetails = finalState.results["bridge-1"].error?.details;
    expect(errorDetails).toBeInstanceOf(Error);
    expect((errorDetails as Error).message).toContain("Cannot combine heterogeneous input tokens");
    expect((errorDetails as Error).message).toContain("token:");
  });

  test("bridge with heterogeneous tokens - different chain IDs", async () => {
    const bridgeStep: TransactionStep = {
      id: "bridge-1",
      type: "bridge",
      status: "pending",
      chainId: 1,
      inputTokens: [
        makeToken(USDC_ADDRESS, 1000000n, 1),
        makeToken(USDC_ADDRESS, 2000000n, 137), // Different chain!
      ],
      outputToken: makeToken(USDC_ADDRESS, 3000000n, 10),
    };

    const state: ConsolidationState = {
      id: "test",
      plan: [bridgeStep],
      currentStepIndex: 0,
      status: "ready",
      results: {},
      sourceTokens: [],
      destinationToken: makeToken(USDC_ADDRESS, 0n, 10),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      hasSubsequentExecution: false,
    };

    const { finalValue: finalState } = await consumeGenerator(executeConsolidationPlan(state, mockWalletClient));

    expect(finalState.status).toBe("paused");
    expect(finalState.results["bridge-1"].status).toBe("failed");
    const errorDetails = finalState.results["bridge-1"].error?.details;
    expect(errorDetails).toBeInstanceOf(Error);
    expect((errorDetails as Error).message).toContain("Cannot combine heterogeneous input tokens");
    expect((errorDetails as Error).message).toContain("chainId:");
  });

  test("bridge with heterogeneous tokens - different wallet addresses", async () => {
    const WALLET_2 = "0x2234567890123456789012345678901234567890" as Address;

    const bridgeStep: TransactionStep = {
      id: "bridge-1",
      type: "bridge",
      status: "pending",
      chainId: 1,
      inputTokens: [
        makeToken(USDC_ADDRESS, 1000000n, 1),
        makeToken(USDC_ADDRESS, 2000000n, 1, { walletAddress: WALLET_2 }), // Different wallet!
      ],
      outputToken: makeToken(USDC_ADDRESS, 3000000n, 10),
    };

    const state: ConsolidationState = {
      id: "test",
      plan: [bridgeStep],
      currentStepIndex: 0,
      status: "ready",
      results: {},
      sourceTokens: [],
      destinationToken: makeToken(USDC_ADDRESS, 0n, 10),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      hasSubsequentExecution: false,
    };

    const { finalValue: finalState } = await consumeGenerator(executeConsolidationPlan(state, mockWalletClient));

    expect(finalState.status).toBe("paused");
    expect(finalState.results["bridge-1"].status).toBe("failed");
    const errorDetails = finalState.results["bridge-1"].error?.details;
    expect(errorDetails).toBeInstanceOf(Error);
    expect((errorDetails as Error).message).toContain("Cannot combine heterogeneous input tokens");
    expect((errorDetails as Error).message).toContain("wallet:");
  });

  test("resume from 'executing' status - recovery scenario", async () => {
    const step1: TransactionStep = {
      id: "step-1",
      type: "swap",
      status: "pending",
      chainId: 1,
      inputTokens: [makeToken(USDC_ADDRESS, 1000000n, 1)],
      outputToken: makeToken(USDC_ADDRESS, 1000000n, 1),
    };

    const state: ConsolidationState = {
      id: "test",
      plan: [step1],
      currentStepIndex: 0,
      status: "executing", // Resume from executing status
      results: {},
      sourceTokens: [],
      destinationToken: makeToken(USDC_ADDRESS, 0n, 1),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      hasSubsequentExecution: false,
    };

    const { finalValue: finalState } = await consumeGenerator(executeConsolidationPlan(state, mockWalletClient));

    expect(finalState.status).toBe("completed");
    expect(finalState.results["step-1"].status).toBe("success");
  });

  test("resume execution from middle of plan - currentStepIndex > 0", async () => {
    const step1: TransactionStep = {
      id: "step-1",
      type: "swap",
      status: "success",
      chainId: 1,
      inputTokens: [makeToken(USDC_ADDRESS, 1000000n, 1)],
      outputToken: makeToken(USDC_ADDRESS, 900000n, 1),
      transactionHash: "0xhash1",
    };

    const step2: TransactionStep = {
      id: "step-2",
      type: "bridge",
      status: "pending",
      chainId: 1,
      inputTokens: [makeToken(USDC_ADDRESS, 900000n, 1, { provenance: "step-1" })],
      outputToken: makeToken(USDC_ADDRESS, 900000n, 10),
    };

    const state: ConsolidationState = {
      id: "test",
      plan: [step1, step2],
      currentStepIndex: 1, // Start from step 2
      status: "paused",
      results: {
        "step-1": {
          stepId: "step-1",
          status: "success",
          chainId: 1,
          transactionHash: "0xhash1",
          actualOutput: makeToken(USDC_ADDRESS, 900000n, 1, { provenance: "step-1" }),
        },
      },
      sourceTokens: [],
      destinationToken: makeToken(USDC_ADDRESS, 0n, 10),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      hasSubsequentExecution: false,
    };

    vi.mocked(executeCCTPBurn).mockResolvedValueOnce(["0xbridge", 1]);

    const { finalValue: finalState } = await consumeGenerator(executeConsolidationPlan(state, mockWalletClient));

    expect(finalState.status).toBe("completed");
    expect(finalState.results["step-1"].status).toBe("success"); // Should stay success
    expect(finalState.results["step-2"].status).toBe("success"); // Should be executed
  });

  test("skip step when dependency is already skipped - cascading skip", async () => {
    const step1: TransactionStep = {
      id: "step-1",
      type: "swap",
      status: "skipped",
      chainId: 1,
      inputTokens: [makeToken(USDC_ADDRESS, 1000000n, 1)],
      outputToken: makeToken(USDC_ADDRESS, 1000000n, 1),
    };

    const step2: TransactionStep = {
      id: "step-2",
      type: "bridge",
      status: "pending",
      chainId: 1,
      inputTokens: [makeToken(USDC_ADDRESS, 1000000n, 1, { provenance: "step-1" })],
      outputToken: makeToken(USDC_ADDRESS, 1000000n, 10),
    };

    const step3: TransactionStep = {
      id: "step-3",
      type: "swap",
      status: "pending",
      chainId: 10,
      inputTokens: [makeToken(DAI_ADDRESS, 500000n, 10)],
      outputToken: makeToken(USDC_ADDRESS, 450000n, 10),
    };

    const state: ConsolidationState = {
      id: "test",
      plan: [step1, step2, step3],
      currentStepIndex: 1, // Start from step 2 since step 1 is already processed
      status: "paused",
      results: {
        "step-1": {
          stepId: "step-1",
          status: "skipped",
          chainId: 1,
          skipReason: "Previous step failed",
        },
      },
      sourceTokens: [],
      destinationToken: makeToken(USDC_ADDRESS, 0n, 10),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      hasSubsequentExecution: true,
    };

    const { finalValue: finalState } = await consumeGenerator(executeConsolidationPlan(state, mockWalletClient));

    expect(finalState.status).toBe("partial");
    expect(finalState.results["step-1"].status).toBe("skipped");
    expect(finalState.results["step-2"].status).toBe("skipped");
    expect(finalState.results["step-2"].skipReason).toContain("skipped step step-1");
    expect(finalState.results["step-3"].status).toBe("success");
  });

  test("execution skips already completed steps", async () => {
    const step1: TransactionStep = {
      id: "step-1",
      type: "swap",
      status: "success",
      chainId: 1,
      inputTokens: [makeToken(USDC_ADDRESS, 1000000n, 1)],
      outputToken: makeToken(USDC_ADDRESS, 900000n, 1),
      transactionHash: "0xhash1",
      executedAt: Date.now(),
    };

    const step2: TransactionStep = {
      id: "step-2",
      type: "bridge",
      status: "pending",
      chainId: 1,
      inputTokens: [makeToken(USDC_ADDRESS, 900000n, 1, { provenance: "step-1" })],
      outputToken: makeToken(USDC_ADDRESS, 900000n, 10),
    };

    const state: ConsolidationState = {
      id: "test",
      plan: [step1, step2],
      currentStepIndex: 0, // Start from beginning
      status: "ready",
      results: {
        "step-1": {
          stepId: "step-1",
          status: "success",
          chainId: 1,
          transactionHash: "0xhash1",
          actualOutput: makeToken(USDC_ADDRESS, 900000n, 1, { provenance: "step-1" }),
        },
      },
      sourceTokens: [],
      destinationToken: makeToken(USDC_ADDRESS, 0n, 10),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      hasSubsequentExecution: false,
    };

    vi.mocked(executeCCTPBurn).mockResolvedValueOnce(["0xbridge", 1]);

    // Execute step 1 should NOT be called again (already successful)
    vi.mocked(executeOdosSwapOrTransfer).mockClear();

    const { finalValue: finalState } = await consumeGenerator(executeConsolidationPlan(state, mockWalletClient));

    expect(finalState.status).toBe("completed");
    expect(finalState.results["step-1"].status).toBe("success");
    expect(finalState.results["step-2"].status).toBe("success");
    // Verify step 1 was NOT re-executed
    expect(executeOdosSwapOrTransfer).not.toHaveBeenCalled();
  });

  test("execution skips already failed steps", async () => {
    const step1: TransactionStep = {
      id: "step-1",
      type: "swap",
      status: "failed",
      chainId: 1,
      inputTokens: [makeToken(USDC_ADDRESS, 1000000n, 1)],
      outputToken: makeToken(USDC_ADDRESS, 900000n, 1),
    };

    const step2: TransactionStep = {
      id: "step-2",
      type: "swap",
      status: "pending",
      chainId: 1,
      inputTokens: [makeToken(DAI_ADDRESS, 500000n, 1)],
      outputToken: makeToken(USDC_ADDRESS, 450000n, 1),
    };

    const state: ConsolidationState = {
      id: "test",
      plan: [step1, step2],
      currentStepIndex: 0,
      status: "paused",
      results: {
        "step-1": {
          stepId: "step-1",
          status: "failed",
          chainId: 1,
        },
      },
      sourceTokens: [],
      destinationToken: makeToken(USDC_ADDRESS, 0n, 1),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      hasSubsequentExecution: true,
    };

    const { finalValue: finalState } = await consumeGenerator(executeConsolidationPlan(state, mockWalletClient));

    expect(finalState.status).toBe("partial");
    expect(finalState.results["step-1"].status).toBe("failed");
    expect(finalState.results["step-2"].status).toBe("success");
    // Verify step 1 was NOT re-executed
    expect(executeOdosSwapOrTransfer).toHaveBeenCalledTimes(1); // Only step 2
  });
});
