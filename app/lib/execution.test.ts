import type { Account, Address, Chain, HttpTransport, WalletClient } from "viem";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { consumeGenerator, makeStep, makeToken, WALLET } from "../../test/helpers";
import type { ConsolidationState, StepResult, TokenAmount, TransactionStep } from "./types";

// Mock dependencies BEFORE imports
vi.mock("./odos");
vi.mock("./cctp");

import { executeCCTPBurn, executeCCTPMint, retrieveAttestations } from "./cctp";
import { adaptStepForPartialDependencies, executeConsolidationPlan, shouldSkipStep } from "./execution";
import { executeOdosSwapOrTransfer, getSwapQuote } from "./odos";

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
      dependsOn: [],
      partialDependency: false,
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
      dependsOn: [],
      partialDependency: false,
    };

    const step2: TransactionStep = {
      id: "step-2",
      type: "bridge",
      status: "pending",
      chainId: 1,
      inputTokens: [makeToken(USDC_ADDRESS, 1000000n, 1)],
      outputToken: makeToken(USDC_ADDRESS, 1000000n, 1),
      dependsOn: ["step-1"],
      partialDependency: false,
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
      dependsOn: [],
      partialDependency: false,
    };

    const step2: TransactionStep = {
      id: "step-2",
      type: "bridge",
      status: "pending",
      chainId: 1,
      inputTokens: [makeToken(USDC_ADDRESS, 1000000n, 1)],
      outputToken: makeToken(USDC_ADDRESS, 1000000n, 1),
      dependsOn: ["step-1"], // Depends on failed step
      partialDependency: false,
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
      dependsOn: [],
      partialDependency: false,
    };

    const step2: TransactionStep = {
      id: "step-2",
      type: "bridge",
      status: "pending",
      chainId: 1,
      inputTokens: [makeToken(USDC_ADDRESS, 1000000n, 1, { provenance: "step-1" })], // Based on step-1 estimate
      outputToken: makeToken(USDC_ADDRESS, 1000000n, 1),
      dependsOn: ["step-1"],
      partialDependency: false,
    };

    mockState.plan = [step1, step2];

    // Step-1 returns different actual amount (0.98 USDC instead of 1 USDC)
    vi.mocked(executeOdosSwapOrTransfer).mockResolvedValueOnce({ amount: 980000n, transactionHash: "0xswap123" }); // 0.98 USDC

    const { finalValue: finalState } = await consumeGenerator(executeConsolidationPlan(mockState, mockWalletClient));

    // Step-2 input should be recalculated to use actual from step-1
    expect(finalState.plan[1].inputTokens[0].amount).toBe(980000n); // Updated to actual
  });

  test("partial dependency adaptation - attestation adapts when some bridges fail", async () => {
    const bridge1: TransactionStep = {
      id: "bridge-1",
      type: "bridge",
      status: "pending",
      chainId: 137,
      inputTokens: [makeToken(USDC_ADDRESS, 500000n, 137)],
      outputToken: makeToken(USDC_ADDRESS, 500000n, 1),
      dependsOn: [],
      partialDependency: false,
    };

    const bridge2: TransactionStep = {
      id: "bridge-2",
      type: "bridge",
      status: "pending",
      chainId: 10,
      inputTokens: [makeToken(USDC_ADDRESS, 500000n, 10)],
      outputToken: makeToken(USDC_ADDRESS, 500000n, 1),
      dependsOn: [],
      partialDependency: false,
    };

    const attestation: TransactionStep = {
      id: "attestation-1",
      type: "attestation",
      status: "pending",
      chainId: 1,
      inputTokens: [bridge1.outputToken, bridge2.outputToken],
      outputToken: makeToken(USDC_ADDRESS, 0n, 1),
      dependsOn: ["bridge-1", "bridge-2"], // Depends on both bridges
      partialDependency: true, // Can adapt to partial dependencies
    };

    mockState.plan = [bridge1, bridge2, attestation];
    mockState.hasSubsequentExecution = true;

    vi.mocked(executeCCTPBurn)
      .mockResolvedValueOnce(["0xabc", 137]) // Bridge 1 succeeds
      .mockRejectedValueOnce(new Error("Bridge failed")); // Bridge 2 fails

    const { finalValue: finalState } = await consumeGenerator(executeConsolidationPlan(mockState, mockWalletClient));

    expect(finalState.results["bridge-1"].status).toBe("success");
    expect(finalState.results["bridge-2"].status).toBe("failed");
    expect(finalState.results["attestation-1"].status).toBe("success"); // Adapted, not skipped
    expect(finalState.plan[2].dependsOn).toEqual(["bridge-1"]); // Adapted to only successful dependency
    expect(finalState.plan[2].adaptedFrom).toEqual(["bridge-1", "bridge-2"]); // Tracks original
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
      dependsOn: [],
      partialDependency: false,
    };

    mockState.plan = [transferStep];

    // Mock prepareSendCalls to return a mock function
    const _mockSendCalls = vi.fn().mockResolvedValue(["0xtransfer123", []]);
    // Override the wallet client to provide our mock
    mockWalletClient.sendCalls = vi.fn().mockResolvedValue({ id: "test-id" });
    mockWalletClient.waitForCallsStatus = vi.fn().mockResolvedValue({
      status: "success",
      receipts: [{ transactionHash: "0xtransfer123", logs: [] }],
    });
    mockWalletClient.switchChain = vi.fn();

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
      dependsOn: ["bridge-1"],
      partialDependency: false,
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
      dependsOn: [],
      partialDependency: false,
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
      dependsOn: [],
      partialDependency: false,
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
      dependsOn: [],
      partialDependency: false,
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
      dependsOn: [],
      partialDependency: false,
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
      dependsOn: [],
      partialDependency: false,
    };

    const step2: TransactionStep = {
      id: "step-2",
      type: "swap",
      status: "pending",
      chainId: 1,
      inputTokens: [makeToken(USDC_ADDRESS, 500000n, 1)],
      outputToken: makeToken(USDC_ADDRESS, 250000n, 1),
      dependsOn: ["step-1"],
      partialDependency: false,
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
    dependsOn: string[],
    inputTokens: [TokenAmount, ...TokenAmount[]],
    outputToken: TokenAmount,
  ): TransactionStep => ({
    id,
    type,
    status: "pending",
    chainId: inputTokens[0].chainId,
    inputTokens,
    outputToken,
    dependsOn,
    partialDependency: false,
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
      [],
      [makeToken(WETH_ADDRESS, 1000000n, 1)],
      makeToken(USDC_ADDRESS, 2000000n, 1),
    );

    const step2: TransactionStep = createStep(
      "step-2",
      "bridge",
      ["step-1"],
      [makeToken(USDC_ADDRESS, 2000000n, 1, { provenance: "step-1" })],
      makeToken(USDC_ADDRESS, 2000000n, 10),
    );

    const step3: TransactionStep = createStep(
      "step-3",
      "claim",
      ["step-2"],
      [makeToken(USDC_ADDRESS, 2000000n, 10, { provenance: "step-2" })],
      makeToken(USDC_ADDRESS, 2000000n, 10),
    );

    const step4: TransactionStep = createStep(
      "step-4",
      "swap",
      ["step-3"],
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
      [],
      [makeToken(WETH_ADDRESS, 1000000n, 1)],
      makeToken(USDC_ADDRESS, 2000000n, 1),
    );

    const step2: TransactionStep = createStep(
      "step-2",
      "swap",
      ["step-1"],
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
      [],
      [makeToken(WETH_ADDRESS, 1000000n, 1)],
      makeToken(USDC_ADDRESS, 2000000n, 1),
    );

    const step2: TransactionStep = createStep(
      "step-2",
      "transfer",
      ["step-1"],
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
      [],
      [makeToken(WETH_ADDRESS, 1000000n, 1)],
      makeToken(USDC_ADDRESS, 2000000n, 1),
    );

    const step2: TransactionStep = createStep(
      "step-2",
      "swap",
      [],
      [makeToken(DAI_ADDRESS, 3000000n, 1)],
      makeToken(USDC_ADDRESS, 3000000n, 1),
    );

    const step3: TransactionStep = createStep(
      "step-3",
      "bridge",
      ["step-1"],
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
      [],
      [makeToken(USDC_ADDRESS, 2000000n, 1)],
      makeToken(USDC_ADDRESS, 2000000n, 10),
    );

    const step2: TransactionStep = createStep(
      "step-2",
      "attestation",
      ["step-1"],
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
      [],
      [makeToken(WETH_ADDRESS, 1000000n, 1)],
      makeToken(USDC_ADDRESS, 2000000n, 1),
    );

    const step2: TransactionStep = createStep(
      "step-2",
      "swap",
      ["step-1"],
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
      [],
      [makeToken(WETH_ADDRESS, 1000000n, 1)],
      makeToken(USDC_ADDRESS, 2000000n, 1),
    );

    const step2: TransactionStep = createStep(
      "step-2",
      "swap",
      ["step-1"],
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
      [],
      [makeToken(WETH_ADDRESS, 1000000n, 1)],
      makeToken(USDC_ADDRESS, 1000000n, 1),
    );

    const step2: TransactionStep = createStep(
      "step-2",
      "bridge",
      ["step-1"],
      [makeToken(USDC_ADDRESS, 1000000n, 1, { provenance: "step-1" })],
      makeToken(USDC_ADDRESS, 1000000n, 10),
    );

    const step3: TransactionStep = createStep(
      "step-3",
      "claim",
      ["step-2"],
      [makeToken(USDC_ADDRESS, 1000000n, 10, { provenance: "step-2" })],
      makeToken(USDC_ADDRESS, 1000000n, 10),
    );

    const step4: TransactionStep = createStep(
      "step-4",
      "transfer",
      ["step-3"],
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
      [],
      [makeToken(WETH_ADDRESS, 1000000n, 10)],
      makeToken(USDC_ADDRESS, 784000000n, 10, { provenance: "step-1" }), // Has provenance
    );

    const swap2: TransactionStep = createStep(
      "step-2",
      "swap",
      [],
      [makeToken(DAI_ADDRESS, 500000n, 10)],
      makeToken(USDC_ADDRESS, 201000000n, 10, { provenance: "step-2" }), // Has provenance
    );

    const bridge: TransactionStep = createStep(
      "step-3",
      "bridge",
      ["step-1", "step-2"], // Depends on both swaps for skip management
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
});

describe("shouldSkipStep", () => {
  const makeStep = (id: string, dependsOn: string[] = [], partialDependency = false): TransactionStep => ({
    id,
    type: "swap",
    status: "pending",
    chainId: 1,
    inputTokens: [makeToken("0x789" as Address, 500n, 1)],
    outputToken: makeToken("0x123" as Address, 1000n, 1, {
      walletAddress: "0x456" as Address,
      symbol: "USDC",
      decimals: 6,
    }),
    dependsOn,
    partialDependency,
  });

  test("step with no dependencies should not skip", () => {
    const step = makeStep("step-1");
    const results: Record<string, StepResult> = {};

    expect(shouldSkipStep(step, results)).toBe(false);
  });

  test("step with all successful dependencies should not skip", () => {
    const step = makeStep("step-2", ["step-1"]);
    const results: Record<string, StepResult> = {
      "step-1": { stepId: "step-1", status: "success", chainId: 1 },
    };

    expect(shouldSkipStep(step, results)).toBe(false);
  });

  test("step with failed dependency should skip", () => {
    const step = makeStep("step-2", ["step-1"]);
    const results: Record<string, StepResult> = {
      "step-1": { stepId: "step-1", status: "failed", chainId: 1 },
    };

    expect(shouldSkipStep(step, results)).toBe(true);
  });

  test("step with skipped dependency should skip", () => {
    const step = makeStep("step-2", ["step-1"]);
    const results: Record<string, StepResult> = {
      "step-1": { stepId: "step-1", status: "skipped", chainId: 1 },
    };

    expect(shouldSkipStep(step, results)).toBe(true);
  });

  test("partial dependency step with at least one success should not skip", () => {
    const step = makeStep("step-3", ["step-1", "step-2"], true);
    const results: Record<string, StepResult> = {
      "step-1": { stepId: "step-1", status: "success", chainId: 1 },
      "step-2": { stepId: "step-2", status: "failed", chainId: 1 },
    };

    expect(shouldSkipStep(step, results)).toBe(false);
  });

  test("partial dependency step with all failed should skip", () => {
    const step = makeStep("step-3", ["step-1", "step-2"], true);
    const results: Record<string, StepResult> = {
      "step-1": { stepId: "step-1", status: "failed", chainId: 1 },
      "step-2": { stepId: "step-2", status: "failed", chainId: 1 },
    };

    expect(shouldSkipStep(step, results)).toBe(true);
  });
});

describe("adaptStepForPartialDependencies", () => {
  test("non-partial dependency step should not be adapted", () => {
    const step = makeStep("step-1", ["dep-1", "dep-2"], false);
    const results: Record<string, StepResult> = {
      "dep-1": { stepId: "dep-1", status: "success", chainId: 1 },
      "dep-2": { stepId: "dep-2", status: "failed", chainId: 1 },
    };

    const adapted = adaptStepForPartialDependencies(step, results);
    expect(adapted).toBe(step); // Same reference
  });

  test("partial dependency step with all successful deps should not be adapted", () => {
    const step = makeStep("step-1", ["dep-1", "dep-2"], true);
    const results: Record<string, StepResult> = {
      "dep-1": { stepId: "dep-1", status: "success", chainId: 1 },
      "dep-2": { stepId: "dep-2", status: "success", chainId: 1 },
    };

    const adapted = adaptStepForPartialDependencies(step, results);
    expect(adapted).toBe(step); // Same reference
  });

  test("partial dependency step should filter to only successful deps", () => {
    const step = makeStep("step-1", ["dep-1", "dep-2", "dep-3"], true);
    const results: Record<string, StepResult> = {
      "dep-1": { stepId: "dep-1", status: "success", chainId: 1 },
      "dep-2": { stepId: "dep-2", status: "failed", chainId: 1 },
      "dep-3": { stepId: "dep-3", status: "success", chainId: 1 },
    };

    const adapted = adaptStepForPartialDependencies(step, results);
    expect(adapted.dependsOn).toEqual(["dep-1", "dep-3"]);
    expect(adapted.adaptedFrom).toEqual(["dep-1", "dep-2", "dep-3"]);
  });

  test("partial dependency step should preserve original in adaptedFrom", () => {
    const step = makeStep("step-1", ["dep-1", "dep-2"], true);
    const results: Record<string, StepResult> = {
      "dep-1": { stepId: "dep-1", status: "success", chainId: 1 },
      "dep-2": { stepId: "dep-2", status: "skipped", chainId: 1 },
    };

    const adapted = adaptStepForPartialDependencies(step, results);
    expect(adapted.dependsOn).toEqual(["dep-1"]);
    expect(adapted.adaptedFrom).toEqual(["dep-1", "dep-2"]);
  });
});
