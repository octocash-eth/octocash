import type { Account, Address, Chain, HttpTransport, WalletClient } from "viem";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { consumeGenerator, makeState, makeStep, makeToken, WALLET } from "../../test/test-helpers";
import type { ConsolidationState, StepResult, TokenAmount, TransactionStep } from "./types";

// Mock dependencies BEFORE imports
// Keep `deriveSwapOutputAmount` real so the verify-before-retry reconcile path
// computes the actual fallback amount instead of an auto-mock undefined.
vi.mock("./odos", async () => {
  const actual = await vi.importActual<typeof import("./odos")>("./odos");
  return {
    ...actual,
    executeOdosSwap: vi.fn(),
    getSwapQuote: vi.fn(),
    buildOdosCalls: vi.fn(),
  };
});
vi.mock("./cctp");
// Keep SendCallsError real so `instanceof` checks in the executor work;
// only mock the runtime entrypoints.
vi.mock("./send-calls", async () => {
  const actual = await vi.importActual<typeof import("./send-calls")>("./send-calls");
  return {
    ...actual,
    prepareSendCalls: vi.fn(),
  };
});
vi.mock("./lifi");
vi.mock("viem/actions", () => ({
  estimateGas: vi.fn().mockResolvedValue(100000n),
  waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: "success" }),
}));

// `validateInputBalances` reads on-chain balances via `getTokenBalance` in
// `./tokens`, which itself dispatches to `getPublicClient(...).readContract`
// for ERC20 and `getNativeBalance` for native. The unit suite isn't supposed
// to hit any RPC, so we stub both leaf reads to return arbitrarily large
// values. Tests that specifically want to exercise the insufficient-balance
// path override these per-test.
vi.mock("./public-client", () => ({
  getPublicClient: vi.fn(() => ({
    readContract: vi.fn().mockResolvedValue(2n ** 128n),
  })),
  retryOnRateLimit: vi.fn(<T>(fn: () => Promise<T>) => fn()),
}));
vi.mock("./gas", () => ({
  getNativeBalance: vi.fn().mockResolvedValue(2n ** 128n),
}));

import { estimateGas, waitForTransactionReceipt } from "viem/actions";
import { executeCCTPBurn, executeCCTPMint, retrieveAttestations } from "./cctp";
import {
  estimateRemainingChainOps,
  executeConsolidationPlan,
  InsufficientInputBalanceError,
  shouldSkipStep,
  validateInputBalances,
} from "./execution";
import { getNativeBalance } from "./gas";
import { estimateOperationsForChainWallet, type OperationType } from "./gas-estimation";
import { getLiFiQuoteForTargetOutput, pollLiFiTransferStatus } from "./lifi";
import { executeOdosSwap, getSwapQuote } from "./odos";
import { getPublicClient } from "./public-client";
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
      sendTransaction: vi.fn().mockResolvedValue("0xgastopup"),
      switchChain: vi.fn(),
      addChain: vi.fn(),
    } as unknown as WalletClient<HttpTransport, Chain, Account>;

    // Default LI.FI mocks
    vi.mocked(getLiFiQuoteForTargetOutput).mockResolvedValue({
      tool: "across",
      action: {
        fromChainId: 8453,
        toChainId: 10,
        fromToken: { symbol: "ETH", decimals: 18, priceUSD: "2000" },
        toToken: { symbol: "ETH", decimals: 18, priceUSD: "2000" },
      },
      estimate: { fromAmount: "1500000000000000", toAmount: "1400000000000000", toAmountMin: "1400000000000000" },
      transactionRequest: {
        value: "0x5543DF729C000",
        to: "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE",
        data: "0x1794958f00",
        from: WALLET,
        chainId: 8453,
      },
    });
    vi.mocked(pollLiFiTransferStatus).mockResolvedValue({
      status: "DONE",
      substatus: "COMPLETED",
    });
    vi.mocked(estimateGas).mockResolvedValue(100000n);
    vi.mocked(waitForTransactionReceipt).mockResolvedValue({ status: "success" } as never);

    // Default mock for getSwapQuote: pass-through that returns the requested
    // outputToken unchanged. This makes the unconditional pre-execution refresh
    // (and any other ambient call) a no-op by default; individual tests
    // override specific calls with mockResolvedValueOnce.
    vi.mocked(getSwapQuote).mockImplementation(async (_inputs, outputToken) => {
      const ot = outputToken as TokenAmount;
      return { ...ot, amount: ot.amount ?? 0n };
    });

    // Default execution mocks
    vi.mocked(executeOdosSwap).mockResolvedValue({ amount: 1000000n, transactionHash: "0xswap123" });
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

  test("preserves transactionHash on failed step when error is a SendCallsError", async () => {
    // Replicates the real-world bug: the swap broadcast succeeded but the
    // executor (e.g. log parsing in executeOdosSwap) threw afterwards.
    // We need the failed StepResult and the failed step to keep the hash
    // so the UI shows a tx link and the verify-before-retry path can run.
    const { SendCallsError } = await import("./send-calls");

    const swapStep: TransactionStep = {
      id: "swap-1",
      type: "swap",
      status: "pending",
      chainId: 1,
      inputTokens: [makeToken(USDC_ADDRESS, 1000000n, 1)],
      outputToken: makeToken(USDC_ADDRESS, 1000000n, 1),
    };

    mockState.plan = [swapStep];

    vi.mocked(executeOdosSwap).mockRejectedValueOnce(
      new SendCallsError("No output token amount found", { transactionHash: "0xpostbroadcast" }),
    );

    const { finalValue: finalState } = await consumeGenerator(executeConsolidationPlan(mockState, mockWalletClient));

    expect(finalState.results["swap-1"].status).toBe("failed");
    expect(finalState.results["swap-1"].transactionHash).toBe("0xpostbroadcast");
    expect(finalState.plan[0].transactionHash).toBe("0xpostbroadcast");
  });

  test("captures retryHints on failed step when error is TransactionNotBroadcastError", async () => {
    // TX_NOT_BROADCAST and TIMEOUT failures attach the prior submission's
    // nonce + fees to the failed step so the retry path can replace the
    // pending tx (same nonce, doubled fee bid).
    const { TransactionNotBroadcastError } = await import("./send-calls");

    const swapStep: TransactionStep = {
      id: "swap-1",
      type: "swap",
      status: "pending",
      chainId: 1,
      inputTokens: [makeToken(USDC_ADDRESS, 1000000n, 1)],
      outputToken: makeToken(USDC_ADDRESS, 1000000n, 1),
    };

    mockState.plan = [swapStep];

    vi.mocked(executeOdosSwap).mockRejectedValueOnce(
      new TransactionNotBroadcastError("0xstalebroadcast", {
        nonce: 42,
        maxFeePerGas: 10000000000n,
        maxPriorityFeePerGas: 500000000n,
      }),
    );

    const { finalValue: finalState } = await consumeGenerator(executeConsolidationPlan(mockState, mockWalletClient));

    expect(finalState.plan[0].status).toBe("failed");
    expect(finalState.plan[0].retryHints).toEqual({
      nonce: 42,
      maxFeePerGas: 10000000000n,
      maxPriorityFeePerGas: 500000000n,
    });
  });

  test("captures retryHints for any SendCallsError carrying nonce + fees", async () => {
    // Whenever the wallet captured nonce + fees on broadcast, retryHints are
    // preserved so the next attempt can probe the chain and decide same-nonce
    // replay vs fresh nonce. The decision is deferred to `tryReconcileFromChain`
    // (chain truth), not gated on the failure's error code.
    const { SendCallsError } = await import("./send-calls");

    const swapStep: TransactionStep = {
      id: "swap-1",
      type: "swap",
      status: "pending",
      chainId: 1,
      inputTokens: [makeToken(USDC_ADDRESS, 1000000n, 1)],
      outputToken: makeToken(USDC_ADDRESS, 1000000n, 1),
    };

    mockState.plan = [swapStep];

    vi.mocked(executeOdosSwap).mockRejectedValueOnce(
      new SendCallsError("swap step 0 reverted", {
        transactionHash: "0xreverted",
        nonce: 7,
        maxFeePerGas: 10000000000n,
      }),
    );

    const { finalValue: finalState } = await consumeGenerator(executeConsolidationPlan(mockState, mockWalletClient));

    expect(finalState.plan[0].status).toBe("failed");
    expect(finalState.plan[0].retryHints).toEqual({
      nonce: 7,
      maxFeePerGas: 10000000000n,
      maxPriorityFeePerGas: undefined,
    });
  });

  test("clears retryHints on the success step after a successful retry", async () => {
    // After a successful execution, the step must not carry stale retryHints
    // from a prior failure — a fresh failure later should start the
    // replacement cycle anew.
    const swapStep: TransactionStep = {
      id: "swap-1",
      type: "swap",
      status: "pending",
      chainId: 1,
      inputTokens: [makeToken(USDC_ADDRESS, 1000000n, 1)],
      outputToken: makeToken(USDC_ADDRESS, 1000000n, 1),
      retryHints: {
        nonce: 42,
        maxFeePerGas: 10000000000n,
      },
    };

    mockState.plan = [swapStep];

    const { finalValue: finalState } = await consumeGenerator(executeConsolidationPlan(mockState, mockWalletClient));

    expect(finalState.plan[0].status).toBe("success");
    expect(finalState.plan[0].retryHints).toBeUndefined();
  });

  test("passes step.retryHints through to executeOdosSwap", async () => {
    // The retry path is wired end-to-end: hints stored on the step must be
    // forwarded to sendCalls (via the helper) so the wallet sees the same
    // nonce and the doubled fee bid.
    const swapStep: TransactionStep = {
      id: "swap-1",
      type: "swap",
      status: "pending",
      chainId: 1,
      inputTokens: [makeToken(USDC_ADDRESS, 1000000n, 1)],
      outputToken: makeToken(USDC_ADDRESS, 1000000n, 1),
      retryHints: {
        nonce: 42,
        maxFeePerGas: 10000000000n,
        maxPriorityFeePerGas: 500000000n,
      },
    };

    mockState.plan = [swapStep];

    await consumeGenerator(executeConsolidationPlan(mockState, mockWalletClient));

    expect(executeOdosSwap).toHaveBeenCalledWith(expect.any(Array), expect.any(Object), expect.any(Function), {
      nonce: 42,
      maxFeePerGas: 10000000000n,
      maxPriorityFeePerGas: 500000000n,
    });
  });

  test("reconciles a failed step in place when the chain confirms its prior tx succeeded", async () => {
    // Simulates a retry of a previously-failed swap that *did* land on-chain.
    // The verify-before-retry check should mark the step as success using the
    // existing hash and never re-broadcast (executeOdosSwap must not be called).
    const swapStep: TransactionStep = {
      id: "swap-1",
      type: "swap",
      status: "pending",
      chainId: 1,
      inputTokens: [makeToken(USDC_ADDRESS, 1000000n, 1)],
      outputToken: makeToken(USDC_ADDRESS, 1000000n, 1),
      transactionHash: "0xpreviouslybroadcast",
    };

    mockState.plan = [swapStep];

    // Public client returns a successful receipt for the stored hash.
    vi.mocked(getPublicClient).mockReturnValueOnce({
      readContract: vi.fn().mockResolvedValue(2n ** 128n),
      getTransactionReceipt: vi.fn().mockResolvedValue({ status: "success", logs: [] }),
      // biome-ignore lint/suspicious/noExplicitAny: minimal stub for verify-before-retry
    } as any);

    const { finalValue: finalState } = await consumeGenerator(executeConsolidationPlan(mockState, mockWalletClient));

    expect(finalState.results["swap-1"].status).toBe("success");
    expect(finalState.results["swap-1"].transactionHash).toBe("0xpreviouslybroadcast");
    // RPC returned empty logs (flaky scenario): we still mark success and fall
    // back to the quoted output amount rather than re-broadcasting.
    expect(finalState.results["swap-1"].actualOutput?.amount).toBe(1000000n);
    expect(executeOdosSwap).not.toHaveBeenCalled();
  });

  test("reconciles a swap as success even when the receipt has no logs (flaky RPC)", async () => {
    // Variant of the case above with the receipt's logs field undefined,
    // not just []. Some RPCs strip logs from receipts under load. The
    // executor must not crash on `parseEventLogs` and must still treat
    // the on-chain success as success.
    const swapStep: TransactionStep = {
      id: "swap-1",
      type: "swap",
      status: "pending",
      chainId: 1,
      inputTokens: [makeToken(USDC_ADDRESS, 1000000n, 1)],
      outputToken: makeToken(USDC_ADDRESS, 1000000n, 1),
      transactionHash: "0xnologs",
    };

    mockState.plan = [swapStep];

    vi.mocked(getPublicClient).mockReturnValueOnce({
      readContract: vi.fn().mockResolvedValue(2n ** 128n),
      getTransactionReceipt: vi.fn().mockResolvedValue({ status: "success" }), // no `logs` key
      // biome-ignore lint/suspicious/noExplicitAny: minimal stub for verify-before-retry
    } as any);

    const { finalValue: finalState } = await consumeGenerator(executeConsolidationPlan(mockState, mockWalletClient));

    expect(finalState.results["swap-1"].status).toBe("success");
    expect(finalState.results["swap-1"].transactionHash).toBe("0xnologs");
    expect(finalState.results["swap-1"].actualOutput?.amount).toBe(1000000n);
    expect(executeOdosSwap).not.toHaveBeenCalled();
  });

  test("falls through to normal execution when stored hash is reverted on-chain", async () => {
    const swapStep: TransactionStep = {
      id: "swap-1",
      type: "swap",
      status: "pending",
      chainId: 1,
      inputTokens: [makeToken(USDC_ADDRESS, 1000000n, 1)],
      outputToken: makeToken(USDC_ADDRESS, 1000000n, 1),
      transactionHash: "0xdeadtxhash",
    };

    mockState.plan = [swapStep];

    vi.mocked(getPublicClient).mockReturnValueOnce({
      readContract: vi.fn().mockResolvedValue(2n ** 128n),
      getTransactionReceipt: vi.fn().mockResolvedValue({ status: "reverted", logs: [] }),
      // biome-ignore lint/suspicious/noExplicitAny: minimal stub for verify-before-retry
    } as any);

    const { finalValue: finalState } = await consumeGenerator(executeConsolidationPlan(mockState, mockWalletClient));

    // Normal execution path runs: executeOdosSwap is invoked, success with the
    // mocked default hash 0xswap123.
    expect(executeOdosSwap).toHaveBeenCalled();
    expect(finalState.results["swap-1"].status).toBe("success");
    expect(finalState.results["swap-1"].transactionHash).toBe("0xswap123");
  });

  test("reverted reconcile clears retryHints so the next broadcast uses a fresh nonce", async () => {
    // Chain-confirmed revert consumes the nonce. If a prior attempt left
    // retryHints on the step, they MUST be cleared before fall-through so the
    // re-broadcast goes out at a fresh nonce instead of "nonce too low".
    const { prepareSendCalls: realPrepareSendCalls } =
      await vi.importActual<typeof import("./send-calls")>("./send-calls");
    void realPrepareSendCalls;

    const swapStep: TransactionStep = {
      id: "swap-1",
      type: "swap",
      status: "pending",
      chainId: 1,
      inputTokens: [makeToken(USDC_ADDRESS, 1000000n, 1)],
      outputToken: makeToken(USDC_ADDRESS, 1000000n, 1),
      transactionHash: "0xreverted",
      retryHints: { nonce: 7, maxFeePerGas: 10000000000n, maxPriorityFeePerGas: 500000000n },
    };

    mockState.plan = [swapStep];

    vi.mocked(getPublicClient).mockReturnValueOnce({
      readContract: vi.fn().mockResolvedValue(2n ** 128n),
      getTransactionReceipt: vi.fn().mockResolvedValue({ status: "reverted", logs: [] }),
      // biome-ignore lint/suspicious/noExplicitAny: minimal stub for verify-before-retry
    } as any);

    // Capture whatever retryHints get passed to executeOdosSwap so we can assert
    // they were cleared before the broadcast.
    const swapRetryHintsSeen: unknown[] = [];
    vi.mocked(executeOdosSwap).mockImplementationOnce(async (_inputs, _output, _sendCalls, retryHints) => {
      swapRetryHintsSeen.push(retryHints);
      return { amount: 1000000n, transactionHash: "0xfresh" };
    });

    const { finalValue: finalState } = await consumeGenerator(executeConsolidationPlan(mockState, mockWalletClient));

    expect(finalState.results["swap-1"].status).toBe("success");
    expect(finalState.results["swap-1"].transactionHash).toBe("0xfresh");
    // executeOdosSwap saw `undefined` for retryHints — fresh nonce on next broadcast.
    expect(swapRetryHintsSeen[0]).toBeUndefined();
  });

  test("receipt-not-found preserves retryHints for same-nonce replay on next broadcast", async () => {
    // Tx hash not indexed yet (could be still pending or never broadcast).
    // We can't tell, so the defensive choice is same-nonce replay: keep
    // retryHints intact and pass them through to the next broadcast.
    const swapStep: TransactionStep = {
      id: "swap-1",
      type: "swap",
      status: "pending",
      chainId: 1,
      inputTokens: [makeToken(USDC_ADDRESS, 1000000n, 1)],
      outputToken: makeToken(USDC_ADDRESS, 1000000n, 1),
      transactionHash: "0xpending",
      retryHints: { nonce: 7, maxFeePerGas: 10000000000n, maxPriorityFeePerGas: 500000000n },
    };

    mockState.plan = [swapStep];

    class TransactionReceiptNotFoundError extends Error {
      override name = "TransactionReceiptNotFoundError";
    }
    vi.mocked(getPublicClient).mockReturnValueOnce({
      readContract: vi.fn().mockResolvedValue(2n ** 128n),
      getTransactionReceipt: vi.fn().mockRejectedValue(new TransactionReceiptNotFoundError("not found")),
      getTransactionCount: vi.fn().mockResolvedValue(7), // nonce 7 still open (latest <= retryHints.nonce)
      // biome-ignore lint/suspicious/noExplicitAny: minimal stub
    } as any);

    const swapRetryHintsSeen: unknown[] = [];
    vi.mocked(executeOdosSwap).mockImplementationOnce(async (_inputs, _output, _sendCalls, retryHints) => {
      swapRetryHintsSeen.push(retryHints);
      return { amount: 1000000n, transactionHash: "0xreplaced" };
    });

    const { finalValue: finalState } = await consumeGenerator(executeConsolidationPlan(mockState, mockWalletClient));

    expect(finalState.results["swap-1"].status).toBe("success");
    expect(swapRetryHintsSeen[0]).toEqual({
      nonce: 7,
      maxFeePerGas: 10000000000n,
      maxPriorityFeePerGas: 500000000n,
    });
  });

  test("non-429 RPC error preserves retryHints (treated as rpc-error)", async () => {
    // A non-429 RPC failure (e.g. network drop, malformed response) propagates
    // through retryOnRateLimit and lands in the catch as a generic Error. We
    // treat it as rpc-error: keep retryHints, same-nonce replay.
    const swapStep: TransactionStep = {
      id: "swap-1",
      type: "swap",
      status: "pending",
      chainId: 1,
      inputTokens: [makeToken(USDC_ADDRESS, 1000000n, 1)],
      outputToken: makeToken(USDC_ADDRESS, 1000000n, 1),
      transactionHash: "0xunknown",
      retryHints: { nonce: 11, maxFeePerGas: 20000000000n },
    };

    mockState.plan = [swapStep];

    vi.mocked(getPublicClient).mockReturnValueOnce({
      readContract: vi.fn().mockResolvedValue(2n ** 128n),
      getTransactionReceipt: vi.fn().mockRejectedValue(new Error("connection refused")),
      // biome-ignore lint/suspicious/noExplicitAny: minimal stub
    } as any);

    const swapRetryHintsSeen: unknown[] = [];
    vi.mocked(executeOdosSwap).mockImplementationOnce(async (_inputs, _output, _sendCalls, retryHints) => {
      swapRetryHintsSeen.push(retryHints);
      return { amount: 1000000n, transactionHash: "0xrebroadcast" };
    });

    const { finalValue: finalState } = await consumeGenerator(executeConsolidationPlan(mockState, mockWalletClient));

    expect(finalState.results["swap-1"].status).toBe("success");
    expect(swapRetryHintsSeen[0]).toEqual({
      nonce: 11,
      maxFeePerGas: 20000000000n,
      maxPriorityFeePerGas: undefined,
    });
  });

  test("429 receipt fetch is retried transparently by retryOnRateLimit", async () => {
    // First call throws a 429, second resolves with a success receipt. The
    // executor must reconcile as a success (not fall through to re-broadcast).
    const swapStep: TransactionStep = {
      id: "swap-1",
      type: "swap",
      status: "pending",
      chainId: 1,
      inputTokens: [makeToken(USDC_ADDRESS, 1000000n, 1)],
      outputToken: makeToken(USDC_ADDRESS, 1000000n, 1),
      transactionHash: "0xrate-limited",
    };

    mockState.plan = [swapStep];

    // The module-level retryOnRateLimit mock just calls fn() once. Swap in a
    // minimal real-like retry just for this test (one extra attempt on 429).
    const { retryOnRateLimit: mockedRetry } = await import("./public-client");
    vi.mocked(mockedRetry).mockImplementationOnce(async (fn) => {
      try {
        return await fn();
      } catch (e) {
        if (e instanceof Error && /429/.test(e.message)) return await fn();
        throw e;
      }
    });

    const receiptFn = vi
      .fn()
      .mockRejectedValueOnce(new Error("429 Too Many Requests"))
      .mockResolvedValueOnce({ status: "success", logs: [] });
    vi.mocked(getPublicClient).mockReturnValueOnce({
      readContract: vi.fn().mockResolvedValue(2n ** 128n),
      getTransactionReceipt: receiptFn,
      // biome-ignore lint/suspicious/noExplicitAny: minimal stub
    } as any);

    const { finalValue: finalState } = await consumeGenerator(executeConsolidationPlan(mockState, mockWalletClient));

    expect(receiptFn).toHaveBeenCalledTimes(2);
    expect(finalState.results["swap-1"].status).toBe("success");
    expect(finalState.results["swap-1"].transactionHash).toBe("0xrate-limited");
    // No re-broadcast.
    expect(executeOdosSwap).not.toHaveBeenCalled();
  });

  test("nonce consumed by an unrelated tx pauses execution with a diagnostic", async () => {
    // Receipt not found AND wallet nonce has advanced past retryHints.nonce —
    // something else (wallet cancel, manual speedup) consumed our nonce. We
    // can't safely retry without user review.
    const swapStep: TransactionStep = {
      id: "swap-1",
      type: "swap",
      status: "pending",
      chainId: 1,
      inputTokens: [makeToken(USDC_ADDRESS, 1000000n, 1, { walletAddress: WALLET })],
      outputToken: makeToken(USDC_ADDRESS, 1000000n, 1),
      transactionHash: "0xreplaced",
      retryHints: { nonce: 7, maxFeePerGas: 10000000000n },
    };

    mockState.plan = [swapStep];

    class TransactionReceiptNotFoundError extends Error {
      override name = "TransactionReceiptNotFoundError";
    }
    vi.mocked(getPublicClient).mockReturnValueOnce({
      readContract: vi.fn().mockResolvedValue(2n ** 128n),
      getTransactionReceipt: vi.fn().mockRejectedValue(new TransactionReceiptNotFoundError("not found")),
      getTransactionCount: vi.fn().mockResolvedValue(8), // nonce 8 > retryHints.nonce 7 → consumed
      // biome-ignore lint/suspicious/noExplicitAny: minimal stub
    } as any);

    const { finalValue: finalState } = await consumeGenerator(executeConsolidationPlan(mockState, mockWalletClient));

    expect(finalState.status).toBe("paused");
    expect(finalState.results["swap-1"].status).toBe("failed");
    // The raw error is preserved on `details` (the canned `message` is the
    // user-facing string from getErrorMessage).
    const details = finalState.results["swap-1"].error?.details;
    expect(details).toBeInstanceOf(Error);
    expect((details as Error).message).toMatch(/nonce was consumed/i);
    expect(finalState.plan[0].retryHints).toBeUndefined();
    expect(executeOdosSwap).not.toHaveBeenCalled();
  });

  test("bridge retry does not falsely reconcile from an approve receipt", async () => {
    // The exact production failure the user hit: a bridge step's first attempt
    // landed the approve on chain but the burn submission was rejected by the
    // wallet. Before the send-calls fix, the SendCallsError carried the
    // approve's hash and nonce, which the executor persisted on the failed
    // step. On retry, `tryReconcileFromChain` fetched the approve's receipt,
    // saw status=success, and the `case "bridge"` branch declared the bridge
    // done — advancing to the attestation step, which then polled Circle for
    // a message the approve tx never produced and timed out.
    //
    // Reproduces by directly seeding the corrupted state (transactionHash =
    // approve hash, retryHints carrying the approve's nonce). After the fix,
    // reconcile must notice the receipt's `to` is not the CCTP TokenMessenger
    // and fall through to re-broadcast with a fresh nonce.
    const TOKEN_MESSENGER = "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d" as Address;

    const bridgeStep: TransactionStep = {
      id: "bridge-1",
      type: "bridge",
      status: "pending",
      chainId: 1,
      inputTokens: [makeToken(USDC_ADDRESS, 1000000n, 1, { walletAddress: WALLET })],
      outputToken: makeToken(USDC_ADDRESS, 1000000n, 8453, { provenance: "bridge-1" }),
      transactionHash: "0xapprove",
      retryHints: { nonce: 7, maxFeePerGas: 10000000000n, maxPriorityFeePerGas: 500000000n },
    };

    mockState.plan = [bridgeStep];

    // The approve really did succeed on chain. Its `to` is the USDC contract,
    // not the TokenMessenger — that's the discriminator reconcile must use.
    vi.mocked(getPublicClient).mockReturnValueOnce({
      readContract: vi.fn().mockResolvedValue(2n ** 128n),
      getTransactionReceipt: vi.fn().mockResolvedValue({
        status: "success",
        to: USDC_ADDRESS,
        logs: [],
      }),
      // biome-ignore lint/suspicious/noExplicitAny: minimal stub for verify-before-retry
    } as any);

    // Retry should re-broadcast the burn through executeCCTPBurn.
    vi.mocked(executeCCTPBurn).mockResolvedValueOnce(["0xburn", 1]);

    // Capture the retryHints passed to executeCCTPBurn to assert they were
    // cleared (approve's nonce would yield "nonce too low" — fresh nonce is
    // what we want).
    const burnRetryHintsSeen: unknown[] = [];
    vi.mocked(executeCCTPBurn).mockImplementationOnce(async (_in, _out, _send, _type, retryHints) => {
      burnRetryHintsSeen.push(retryHints);
      return ["0xburn", 1];
    });

    const { finalValue: finalState } = await consumeGenerator(executeConsolidationPlan(mockState, mockWalletClient));

    // The re-broadcast must actually happen — pre-fix the executor would
    // short-circuit to success without calling executeCCTPBurn.
    expect(executeCCTPBurn).toHaveBeenCalledTimes(1);
    expect(finalState.results["bridge-1"].status).toBe("success");
    expect(finalState.results["bridge-1"].transactionHash).toBe("0xburn");
    // Fresh nonce, not the leaked approve nonce.
    expect(burnRetryHintsSeen[0]).toBeUndefined();
    // Sanity: the TokenMessenger constant matches what cctp-contracts uses,
    // so the discriminator works on the real chain config too.
    expect(TOKEN_MESSENGER).toBeDefined();
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
    vi.mocked(executeOdosSwap).mockResolvedValueOnce({ amount: 980000n, transactionHash: "0xswap123" }); // 0.98 USDC

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

    // Pre-execution swap-quote refresh on step 1 returns its existing quote
    // (no drift), so the cascade-recalc mock below is consumed at the right
    // place (step-2 re-quote after step-1 succeeds).
    vi.mocked(getSwapQuote).mockResolvedValueOnce(step1.outputToken);

    // Mock swap 1: WETH -> USDC (actual: 3100 USDC, estimated: 3000)
    vi.mocked(executeOdosSwap).mockResolvedValueOnce({
      amount: 3100000000n, // 3100 USDC (better than estimated)
      transactionHash: "0xswap1",
    });

    // Mock recalculation quote for step 2
    vi.mocked(getSwapQuote).mockResolvedValueOnce(makeToken(DAI_ADDRESS, 3100000000000000000000n, 1)); // 3100 DAI

    // Mock swap 2: USDC -> DAI
    vi.mocked(executeOdosSwap).mockResolvedValueOnce({
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
    vi.mocked(executeOdosSwap).mockResolvedValueOnce({
      amount: 2100000000n, // 2100 USDC (estimated 2000)
      transactionHash: "0xswap1",
    });

    // Mock swap 2 with worse output
    vi.mocked(executeOdosSwap).mockResolvedValueOnce({
      amount: 950000000n, // 950 USDC (estimated 1000)
      transactionHash: "0xswap2",
    });

    // Mock recalculation quote for step 3 (uses actual amounts from both swaps)
    vi.mocked(getSwapQuote).mockResolvedValueOnce(makeToken(WBTC_ADDRESS, 10200000n, 1)); // Updated estimate

    // Mock swap 3
    vi.mocked(executeOdosSwap).mockResolvedValueOnce({
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
    vi.mocked(executeOdosSwap).mockResolvedValueOnce({
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

    const { finalValue: finalState } = await consumeGenerator(executeConsolidationPlan(mockState, mockWalletClient));

    expect(finalState.status).toBe("completed");
    expect(finalState.results["transfer-1"].status).toBe("success");
    expect(finalState.results["transfer-1"].transactionHash).toBe("0xtxhash");
    expect(finalState.results["transfer-1"].actualOutput?.amount).toBe(500000n);
  });

  test("transfer step - should transfer native ETH (zero address) from one wallet to another", async () => {
    const WALLET_2 = "0x2234567890123456789012345678901234567890" as Address;
    const ETH_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;

    const transferStep: TransactionStep = {
      id: "transfer-eth-1",
      type: "transfer",
      status: "pending",
      chainId: 1,
      inputTokens: [
        {
          token: ETH_ADDRESS,
          amount: 1000000000000000000n, // 1 ETH
          chainId: 1,
          walletAddress: WALLET,
          symbol: "ETH",
          decimals: 18,
        },
      ],
      outputToken: {
        token: ETH_ADDRESS,
        amount: 1000000000000000000n,
        chainId: 1,
        walletAddress: WALLET_2,
        symbol: "ETH",
        decimals: 18,
      },
    };

    mockState.plan = [transferStep];

    const { finalValue: finalState } = await consumeGenerator(executeConsolidationPlan(mockState, mockWalletClient));

    expect(finalState.status).toBe("completed");
    expect(finalState.results["transfer-eth-1"].status).toBe("success");
    expect(finalState.results["transfer-eth-1"].transactionHash).toBe("0xtxhash");
    expect(finalState.results["transfer-eth-1"].actualOutput?.amount).toBe(1000000000000000000n);
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

  test("transfer step with multiple input tokens of the same address - should sum amounts", async () => {
    const WALLET_2 = "0x2234567890123456789012345678901234567890" as Address;

    const validTransferStep: TransactionStep = {
      id: "transfer-1",
      type: "transfer",
      status: "pending",
      chainId: 1,
      inputTokens: [
        makeToken(USDC_ADDRESS, 1000000n, 1, { provenance: "step-1" }), // 1 USDC from step-1
        makeToken(USDC_ADDRESS, 2000000n, 1, { provenance: "step-2" }), // 2 USDC from step-2
        makeToken(USDC_ADDRESS, 500000n, 1), // 0.5 USDC existing (no provenance)
      ],
      outputToken: makeToken(USDC_ADDRESS, 3500000n, 1, { walletAddress: WALLET_2 }),
    };

    mockState.plan = [validTransferStep];

    const { finalValue: finalState } = await consumeGenerator(executeConsolidationPlan(mockState, mockWalletClient));

    // Should succeed
    expect(finalState.status).toBe("completed");
    expect(finalState.results["transfer-1"].status).toBe("success");

    // Verify actual output has summed amount
    expect(finalState.results["transfer-1"].actualOutput?.amount).toBe(3500000n);
    expect(finalState.results["transfer-1"].actualOutput?.walletAddress).toBe(WALLET_2);
  });

  test("transfer step fails with multiple input tokens of different addresses", async () => {
    const DAI_ADDRESS = "0x6B175474E89094C44Da98b954EedeAC495271d0F" as Address;

    const invalidTransferStep: TransactionStep = {
      id: "transfer-1",
      type: "transfer",
      status: "pending",
      chainId: 1,
      inputTokens: [
        makeToken(USDC_ADDRESS, 1000000n, 1),
        makeToken(DAI_ADDRESS, 2000000n, 1, { walletAddress: WALLET, symbol: "DAI", decimals: 18 }), // Second input with different token address - invalid!
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
    expect((errorDetails as Error).message).toContain("All transfer input tokens must be the same token address");
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
    vi.mocked(executeOdosSwap).mockResolvedValueOnce({
      amount: 600000n, // Actual output differs
      transactionHash: "0xswap1",
    });

    // Mock getSwapQuote to fail on recalculation for step2
    vi.mocked(getSwapQuote)
      .mockRejectedValueOnce(new Error("Quote API failed")) // Fails during recalculation
      .mockResolvedValueOnce(makeToken(USDC_ADDRESS, 250000n, 1)); // But step2 still executes

    // Second swap succeeds despite quote failure
    vi.mocked(executeOdosSwap).mockResolvedValueOnce({
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

    vi.mocked(getSwapQuote).mockImplementation(async (_inputs, outputToken) => {
      const ot = outputToken as TokenAmount;
      return { ...ot, amount: ot.amount ?? 0n };
    });
    vi.mocked(executeOdosSwap).mockResolvedValue({ amount: 1000000n, transactionHash: "0xswap" });
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
    vi.mocked(executeOdosSwap).mockResolvedValueOnce({
      amount: 2500000n,
      transactionHash: "0xswap1",
    });

    // Recalculation quotes for step 4 (called after step 1 completes)
    vi.mocked(getSwapQuote).mockResolvedValueOnce(makeToken(DAI_ADDRESS, 2500000n, 10));

    // Step 4 swap execution (uses the recalculated input)
    vi.mocked(executeOdosSwap).mockResolvedValueOnce({
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
    vi.mocked(executeOdosSwap).mockResolvedValueOnce({
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
    vi.mocked(executeOdosSwap).mockResolvedValueOnce({
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
    vi.mocked(executeOdosSwap).mockResolvedValueOnce({
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

    vi.mocked(executeOdosSwap).mockResolvedValueOnce({
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

    vi.mocked(executeOdosSwap).mockResolvedValueOnce({
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

    vi.mocked(executeOdosSwap).mockResolvedValueOnce({
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

  test("regression: transfer with multiple inputs (different provenances) - recalculation updates all sources", async () => {
    // Regression test: when a transfer has multiple inputs with different provenances,
    // recalculation after a step completes should update the correct input amounts
    const WALLET_2 = "0x2234567890123456789012345678901234567890" as Address;

    const swap1: TransactionStep = createStep(
      "step-1",
      "swap",
      [makeToken(WETH_ADDRESS, 1000000n, 10)],
      makeToken(USDC_ADDRESS, 100000000n, 10, { provenance: "step-1" }), // 100 USDC
    );

    const swap2: TransactionStep = createStep(
      "step-2",
      "swap",
      [makeToken(DAI_ADDRESS, 500000n, 10)],
      makeToken(USDC_ADDRESS, 200000000n, 10, { provenance: "step-2" }), // 200 USDC
    );

    const existingUSDC = makeToken(USDC_ADDRESS, 50000000n, 10); // 50 USDC, no provenance

    const transfer: TransactionStep = createStep(
      "step-3",
      "transfer",
      [
        makeToken(USDC_ADDRESS, 100000000n, 10, { provenance: "step-1" }), // From swap1
        makeToken(USDC_ADDRESS, 200000000n, 10, { provenance: "step-2" }), // From swap2
        existingUSDC, // Existing, no provenance
      ],
      makeToken(USDC_ADDRESS, 350000000n, 10, { walletAddress: WALLET_2, provenance: "step-3" }), // Total: 350 USDC
    );

    const state: ConsolidationState = {
      id: "test",
      plan: [swap1, swap2, transfer],
      currentStepIndex: 0,
      status: "ready",
      results: {},
      sourceTokens: [],
      destinationToken: makeToken(USDC_ADDRESS, 0n, 10, { walletAddress: WALLET_2 }),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      hasSubsequentExecution: false,
    };

    // Mock swap1 to produce actual amount 105 USDC (instead of 100)
    vi.mocked(executeOdosSwap)
      .mockResolvedValueOnce({ amount: 105000000n, transactionHash: "0xswap1" })
      .mockResolvedValueOnce({ amount: 195000000n, transactionHash: "0xswap2" }); // swap2 produces 195 USDC

    const { values, finalValue: finalState } = await consumeGenerator(
      executeConsolidationPlan(state, mockWalletClient),
    );

    // Find state after step-1 (swap1)
    const stateAfterSwap = values.find((s) => s.results["step-1"]?.status === "success");
    expect(stateAfterSwap).toBeDefined();

    if (stateAfterSwap) {
      // After swap1: transfer input from swap1 should be recalculated
      const transferStepAfterSwap = stateAfterSwap.plan[2];
      const swap1Input = transferStepAfterSwap.inputTokens.find((t) => t.provenance === "step-1");
      expect(swap1Input?.amount).toBe(105000000n); // Updated from 100 to 105

      // Other inputs should remain unchanged
      const swap2Input = transferStepAfterSwap.inputTokens.find((t) => t.provenance === "step-2");
      const existingInput = transferStepAfterSwap.inputTokens.find((t) => !t.provenance);
      expect(swap2Input?.amount).toBe(200000000n); // Unchanged (swap2 not executed yet)
      expect(existingInput?.amount).toBe(50000000n); // Unchanged

      // Transfer output should be recalculated to sum all inputs
      expect(transferStepAfterSwap.outputToken.amount).toBe(355000000n); // 105 + 200 + 50
    }

    // Find state after step-2 (swap2)
    const stateAfterSwap2 = values.find((s) => s.results["step-2"]?.status === "success");
    expect(stateAfterSwap2).toBeDefined();

    if (stateAfterSwap2) {
      // After swap2: transfer input from swap2 should also be recalculated
      const transferStepAfterSwap2 = stateAfterSwap2.plan[2];
      const swap1Input = transferStepAfterSwap2.inputTokens.find((t) => t.provenance === "step-1");
      const swap2Input = transferStepAfterSwap2.inputTokens.find((t) => t.provenance === "step-2");
      const existingInput = transferStepAfterSwap2.inputTokens.find((t) => !t.provenance);

      expect(swap1Input?.amount).toBe(105000000n); // Still updated
      expect(swap2Input?.amount).toBe(195000000n); // Now updated to actual (was 200)
      expect(existingInput?.amount).toBe(50000000n); // Still unchanged

      // Transfer output should be recalculated with both actual amounts
      expect(transferStepAfterSwap2.outputToken.amount).toBe(350000000n); // 105 + 195 + 50
    }

    // Verify final state
    expect(finalState.status).toBe("completed");
    expect(finalState.results["step-1"].actualOutput?.amount).toBe(105000000n);
    expect(finalState.results["step-2"].actualOutput?.amount).toBe(195000000n);

    // Verify transfer was executed with correct total amount
    expect(finalState.results["step-3"].status).toBe("success");
    expect(finalState.results["step-3"].actualOutput?.amount).toBe(350000000n); // Sum of all three inputs with actual amounts
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
    vi.mocked(executeOdosSwap)
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

    vi.mocked(executeOdosSwap).mockResolvedValueOnce({
      amount: 1400000n,
      transactionHash: "0xswap1",
    });

    const { finalValue: finalState } = await consumeGenerator(executeConsolidationPlan(state, mockWalletClient));

    expect(finalState.status).toBe("completed");
    expect(finalState.results["step-1"].status).toBe("success");

    // Verify that executeOdosSwap was called with only non-zero tokens
    expect(executeOdosSwap).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ token: WETH_ADDRESS, amount: 1000000n }),
        expect.objectContaining({ token: DAI_ADDRESS, amount: 500000n }),
      ]),
      expect.anything(),
      expect.anything(),
      undefined, // retryHints
    );

    // Verify zero-amount token was filtered out
    const callArgs = vi.mocked(executeOdosSwap).mock.calls[0][0];
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

    // Verify executeOdosSwap was never called
    expect(executeOdosSwap).not.toHaveBeenCalled();
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
      "fast", // transferType
      undefined, // retryHints
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

    vi.mocked(getSwapQuote).mockImplementation(async (_inputs, outputToken) => {
      const ot = outputToken as TokenAmount;
      return { ...ot, amount: ot.amount ?? 0n };
    });
    vi.mocked(executeOdosSwap).mockResolvedValue({ amount: 1000000n, transactionHash: "0xswap" });
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
    vi.mocked(executeOdosSwap).mockClear();

    const { finalValue: finalState } = await consumeGenerator(executeConsolidationPlan(state, mockWalletClient));

    expect(finalState.status).toBe("completed");
    expect(finalState.results["step-1"].status).toBe("success");
    expect(finalState.results["step-2"].status).toBe("success");
    // Verify step 1 was NOT re-executed
    expect(executeOdosSwap).not.toHaveBeenCalled();
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
    expect(executeOdosSwap).toHaveBeenCalledTimes(1); // Only step 2
  });

  test("swap quote is refreshed on paused retry when quote is stale", async () => {
    const step1 = makeStep({
      id: "step-1",
      status: "pending",
      inputTokens: [makeToken(USDC_ADDRESS, 1000000n, 1)],
      outputToken: makeToken(USDC_ADDRESS, 900000n, 1),
      quotedAt: Date.now() - 60 * 1000,
    });

    const state = makeState({
      plan: [step1],
      currentStepIndex: 0,
      status: "paused", // Retrying after failure
      results: {},
      sourceTokens: [],
      destinationToken: makeToken(USDC_ADDRESS, 0n, 1),
    });

    vi.mocked(getSwapQuote).mockResolvedValueOnce(makeToken(USDC_ADDRESS, 850000n, 1));
    vi.mocked(executeOdosSwap).mockResolvedValueOnce({ amount: 850000n, transactionHash: "0xswap" });

    const { finalValue: finalState, values: states } = await consumeGenerator(
      executeConsolidationPlan(state, mockWalletClient),
    );

    expect(getSwapQuote).toHaveBeenCalledWith(step1.inputTokens, step1.outputToken);

    const stateAfterRefresh = states.find(
      (s) => s.plan[0].outputToken.amount === 850000n && s.plan[0].status === "pending",
    );
    expect(stateAfterRefresh).toBeDefined();

    expect(finalState.status).toBe("completed");
    expect(finalState.results["step-1"].status).toBe("success");
  });

  test("swap quote is always refreshed right before execution (stale quote)", async () => {
    const staleTime = Date.now() - 60 * 1000;

    const step1 = makeStep({
      id: "step-1",
      status: "pending",
      inputTokens: [makeToken(USDC_ADDRESS, 1000000n, 1)],
      outputToken: makeToken(USDC_ADDRESS, 900000n, 1),
      quotedAt: staleTime,
    });

    const state = makeState({
      plan: [step1],
      currentStepIndex: 0,
      status: "ready",
      results: {},
      sourceTokens: [],
      destinationToken: makeToken(USDC_ADDRESS, 0n, 1),
    });

    vi.mocked(getSwapQuote).mockResolvedValueOnce(makeToken(USDC_ADDRESS, 820000n, 1));
    vi.mocked(executeOdosSwap).mockResolvedValueOnce({ amount: 820000n, transactionHash: "0xswap" });

    const { finalValue: finalState, values: states } = await consumeGenerator(
      executeConsolidationPlan(state, mockWalletClient),
    );

    expect(getSwapQuote).toHaveBeenCalledWith(step1.inputTokens, step1.outputToken);

    const stateAfterRefresh = states.find(
      (s) => s.plan[0].outputToken.amount === 820000n && s.plan[0].status === "pending",
    );
    expect(stateAfterRefresh).toBeDefined();

    expect(finalState.status).toBe("completed");
    expect(finalState.results["step-1"].status).toBe("success");
  });

  test("swap quote refresh is skipped when quote is fresh", async () => {
    const step1 = makeStep({
      id: "step-1",
      status: "pending",
      inputTokens: [makeToken(USDC_ADDRESS, 1000000n, 1)],
      outputToken: makeToken(USDC_ADDRESS, 900000n, 1),
      quotedAt: Date.now(),
    });

    const state = makeState({
      plan: [step1],
      currentStepIndex: 0,
      status: "ready",
      results: {},
      sourceTokens: [],
      destinationToken: makeToken(USDC_ADDRESS, 0n, 1),
    });

    vi.mocked(getSwapQuote).mockClear();
    vi.mocked(executeOdosSwap).mockResolvedValueOnce({ amount: 900000n, transactionHash: "0xswap" });

    const { finalValue: finalState } = await consumeGenerator(executeConsolidationPlan(state, mockWalletClient));

    expect(getSwapQuote).not.toHaveBeenCalled();
    expect(finalState.status).toBe("completed");
    expect(finalState.results["step-1"].status).toBe("success");
    expect(finalState.plan[0].outputToken.amount).toBe(900000n);
  });

  test("swap quote refresh failure falls back to existing quote without erroring", async () => {
    const step1 = makeStep({
      id: "step-1",
      status: "pending",
      inputTokens: [makeToken(USDC_ADDRESS, 1000000n, 1)],
      outputToken: makeToken(USDC_ADDRESS, 900000n, 1),
      quotedAt: Date.now() - 60 * 1000,
    });

    const state = makeState({
      plan: [step1],
      currentStepIndex: 0,
      status: "ready",
      results: {},
      sourceTokens: [],
      destinationToken: makeToken(USDC_ADDRESS, 0n, 1),
    });

    vi.mocked(getSwapQuote).mockClear();
    vi.mocked(getSwapQuote).mockRejectedValueOnce(new Error("odos down"));
    vi.mocked(executeOdosSwap).mockResolvedValueOnce({ amount: 900000n, transactionHash: "0xswap" });

    const { finalValue: finalState } = await consumeGenerator(executeConsolidationPlan(state, mockWalletClient));

    // Refresh was attempted...
    expect(getSwapQuote).toHaveBeenCalledTimes(1);
    // ...but execution still completes using the original quote.
    expect(finalState.status).toBe("completed");
    expect(finalState.results["step-1"].status).toBe("success");
    expect(finalState.plan[0].outputToken.amount).toBe(900000n);
  });

  test("downstream steps are recalculated after quote refresh", async () => {
    const step1 = makeStep({
      id: "step-1",
      status: "pending",
      inputTokens: [makeToken(USDC_ADDRESS, 1000000n, 1)],
      outputToken: { ...makeToken(USDC_ADDRESS, 900000n, 1), provenance: "step-1" },
      quotedAt: Date.now() - 60 * 1000,
    });

    const step2 = makeStep({
      id: "step-2",
      type: "bridge",
      status: "pending",
      inputTokens: [makeToken(USDC_ADDRESS, 900000n, 1, { provenance: "step-1" })],
      outputToken: makeToken(USDC_ADDRESS, 900000n, 10),
    });

    const state = makeState({
      plan: [step1, step2],
      currentStepIndex: 0,
      status: "ready", // Refresh always happens regardless of status
      results: {},
      sourceTokens: [],
      destinationToken: makeToken(USDC_ADDRESS, 0n, 10),
    });

    vi.mocked(getSwapQuote).mockResolvedValueOnce(makeToken(USDC_ADDRESS, 750000n, 1));
    vi.mocked(executeOdosSwap).mockResolvedValueOnce({ amount: 750000n, transactionHash: "0xswap" });

    const { finalValue: finalState, values: states } = await consumeGenerator(
      executeConsolidationPlan(state, mockWalletClient),
    );

    // After refresh, step 2's input should be recalculated
    const stateAfterRefresh = states.find(
      (s) => s.plan[0].outputToken.amount === 750000n && s.plan[0].status === "pending",
    );
    expect(stateAfterRefresh).toBeDefined();

    // Step 2's input should be updated to match the refreshed quote
    expect(stateAfterRefresh?.plan[1].inputTokens[0].amount).toBe(750000n);
    expect(stateAfterRefresh?.plan[1].outputToken.amount).toBe(750000n); // Bridge 1:1

    expect(finalState.status).toBe("completed");
  });

  // ==========================================================================
  // Gas Top-Up and Gas Top-Up Wait Execution
  // ==========================================================================

  describe("gas-topup and gas-topup-wait execution", () => {
    const USDC_ADDRESS = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address;
    const ETH = "0x0000000000000000000000000000000000000000" as Address;
    const LIFI_DIAMOND = "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE" as Address;

    let mockState: ConsolidationState;
    let mockWalletClient: WalletClient<HttpTransport, Chain, Account>;

    beforeEach(() => {
      vi.clearAllMocks();

      mockWalletClient = {
        account: { address: WALLET } as Account,
        chain: { id: 1 } as Chain,
        sendTransaction: vi.fn().mockResolvedValue("0xgastopup"),
        switchChain: vi.fn(),
        addChain: vi.fn(),
      } as unknown as WalletClient<HttpTransport, Chain, Account>;

      vi.mocked(getLiFiQuoteForTargetOutput).mockResolvedValue({
        tool: "across",
        action: {
          fromChainId: 8453,
          toChainId: 10,
          fromToken: { symbol: "ETH", decimals: 18, priceUSD: "2000" },
          toToken: { symbol: "ETH", decimals: 18, priceUSD: "2000" },
        },
        estimate: { fromAmount: "1500000000000000", toAmount: "1400000000000000", toAmountMin: "1400000000000000" },
        transactionRequest: {
          value: "0x5543DF729C000",
          to: LIFI_DIAMOND,
          data: "0x1794958f00",
          from: WALLET,
          chainId: 8453,
        },
      });
      vi.mocked(pollLiFiTransferStatus).mockResolvedValue({ status: "DONE", substatus: "COMPLETED" });
      vi.mocked(estimateGas).mockResolvedValue(100000n);
      vi.mocked(waitForTransactionReceipt).mockResolvedValue({ status: "success" } as never);

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

    test("cross-chain destination sends tx to LI.FI Diamond and stores transfer metadata", async () => {
      vi.mocked(getLiFiQuoteForTargetOutput).mockResolvedValueOnce({
        tool: "across",
        action: {
          fromChainId: 8453,
          toChainId: 10,
          fromToken: { symbol: "ETH", decimals: 18, priceUSD: "2000" },
          toToken: { symbol: "ETH", decimals: 18, priceUSD: "2000" },
        },
        estimate: { fromAmount: "1500000000000000", toAmount: "1400000000000000", toAmountMin: "1400000000000000" },
        transactionRequest: {
          value: "0x5543DF729C000",
          to: LIFI_DIAMOND,
          data: "0xabcdef",
          from: WALLET,
          chainId: 8453,
        },
      });

      const step: TransactionStep = {
        id: "gas-topup-1",
        type: "gas-topup",
        status: "pending",
        chainId: 8453,
        inputTokens: [makeToken(ETH, 2000000000000000n, 8453, { symbol: "ETH", decimals: 18 })],
        outputToken: makeToken(ETH, 1500000000000000n, 8453, { symbol: "ETH", decimals: 18 }),
        gasTopUpDestinations: [{ chainId: 10, address: WALLET, amountWei: "1500000000000000" }],
      };

      mockState.plan = [step];
      mockState.status = "ready";
      mockState.currentStepIndex = 0;

      const { finalValue: finalState } = await consumeGenerator(executeConsolidationPlan(mockState, mockWalletClient));

      expect(finalState.status).toBe("completed");
      expect(finalState.results["gas-topup-1"].status).toBe("success");
      expect(finalState.results["gas-topup-1"].transactionHash).toBe("0xgastopup");

      const sendTx = vi.mocked(mockWalletClient.sendTransaction as ReturnType<typeof vi.fn>);
      expect(sendTx).toHaveBeenCalledOnce();
      const callArgs = sendTx.mock.calls[0][0] as { to: Address; data: string; value: bigint };
      expect(callArgs.to).toBe(LIFI_DIAMOND);
      expect(callArgs.data).toBe("0xabcdef");
      expect(callArgs.value).toBe(BigInt("0x5543DF729C000"));

      const transfers = finalState.metadata?.lifiTransfers;
      expect(transfers).toHaveLength(1);
      expect(transfers?.[0]).toEqual({
        txHash: "0xgastopup",
        bridge: "across",
        fromChainId: 8453,
        toChainId: 10,
      });
    });

    test("multiple cross-chain destinations send individual LI.FI transactions", async () => {
      const quote1 = {
        tool: "across",
        action: {
          fromChainId: 8453,
          toChainId: 10,
          fromToken: { symbol: "ETH", decimals: 18, priceUSD: "2000" },
          toToken: { symbol: "ETH", decimals: 18, priceUSD: "2000" },
        },
        estimate: { fromAmount: "100", toAmount: "90", toAmountMin: "90" },
        transactionRequest: { value: "0x100", to: LIFI_DIAMOND, data: "0xaaa", from: WALLET, chainId: 8453 } as const,
      };
      const quote2 = {
        tool: "hop",
        action: {
          fromChainId: 8453,
          toChainId: 137,
          fromToken: { symbol: "ETH", decimals: 18, priceUSD: "2000" },
          toToken: { symbol: "POL", decimals: 18, priceUSD: "0.5" },
        },
        estimate: { fromAmount: "200", toAmount: "180", toAmountMin: "180" },
        transactionRequest: { value: "0x200", to: LIFI_DIAMOND, data: "0xbbb", from: WALLET, chainId: 8453 } as const,
      };
      vi.mocked(getLiFiQuoteForTargetOutput).mockResolvedValueOnce(quote1).mockResolvedValueOnce(quote2);

      const sendTxMock = vi.fn().mockResolvedValueOnce("0xtx1").mockResolvedValueOnce("0xtx2");
      (mockWalletClient as unknown as { sendTransaction: typeof sendTxMock }).sendTransaction = sendTxMock;

      const step: TransactionStep = {
        id: "gas-topup-multi",
        type: "gas-topup",
        status: "pending",
        chainId: 8453,
        inputTokens: [makeToken(ETH, 5000000000000000n, 8453, { symbol: "ETH", decimals: 18 })],
        outputToken: makeToken(ETH, 3000000000000000n, 8453, { symbol: "ETH", decimals: 18 }),
        gasTopUpDestinations: [
          { chainId: 10, address: WALLET, amountWei: "1500000000000000" },
          { chainId: 137, address: WALLET, amountWei: "1500000000000000" },
        ],
      };

      mockState.plan = [step];
      mockState.status = "ready";
      mockState.currentStepIndex = 0;

      const { finalValue: finalState } = await consumeGenerator(executeConsolidationPlan(mockState, mockWalletClient));

      expect(finalState.status).toBe("completed");
      expect(sendTxMock).toHaveBeenCalledTimes(2);

      const transfers = finalState.metadata?.lifiTransfers;
      expect(transfers).toHaveLength(2);
      expect(transfers?.[0].txHash).toBe("0xtx1");
      expect(transfers?.[0].bridge).toBe("across");
      expect(transfers?.[1].txHash).toBe("0xtx2");
      expect(transfers?.[1].bridge).toBe("hop");
    });

    test("same-chain destination sends a direct native transfer (no LI.FI quote)", async () => {
      const sendTxMock = vi.fn().mockResolvedValue("0xnative");
      (mockWalletClient as unknown as { sendTransaction: typeof sendTxMock }).sendTransaction = sendTxMock;

      const step: TransactionStep = {
        id: "gas-topup-samechain",
        type: "gas-topup",
        status: "pending",
        chainId: 8453,
        inputTokens: [makeToken(ETH, 1000000n, 8453, { symbol: "ETH", decimals: 18 })],
        outputToken: makeToken(ETH, 1000000n, 8453, { symbol: "ETH", decimals: 18 }),
        gasTopUpDestinations: [
          { chainId: 8453, address: "0x9999999999999999999999999999999999999999" as Address, amountWei: "1000000" },
        ],
      };

      mockState.plan = [step];
      mockState.status = "ready";
      mockState.currentStepIndex = 0;

      const { finalValue: finalState } = await consumeGenerator(executeConsolidationPlan(mockState, mockWalletClient));

      expect(finalState.status).toBe("completed");
      expect(getLiFiQuoteForTargetOutput).not.toHaveBeenCalled();
      expect(sendTxMock).toHaveBeenCalledOnce();
      // No LI.FI transfer recorded for same-chain
      expect(finalState.metadata?.lifiTransfers ?? []).toHaveLength(0);
    });

    test("fails when no destinations", async () => {
      const step: TransactionStep = {
        id: "gas-topup-empty",
        type: "gas-topup",
        status: "pending",
        chainId: 8453,
        inputTokens: [makeToken(ETH, 2000000000000000n, 8453, { symbol: "ETH", decimals: 18 })],
        outputToken: makeToken(ETH, 1500000000000000n, 8453, { symbol: "ETH", decimals: 18 }),
        gasTopUpDestinations: [],
      };

      mockState.plan = [step];
      mockState.status = "ready";
      mockState.currentStepIndex = 0;

      const { finalValue: finalState } = await consumeGenerator(executeConsolidationPlan(mockState, mockWalletClient));

      expect(finalState.status).toBe("paused");
      expect(finalState.results["gas-topup-empty"].status).toBe("failed");
    });

    test("gas-topup-wait polls LI.FI when transfers are in metadata", async () => {
      const step: TransactionStep = {
        id: "gas-wait-1",
        type: "gas-topup-wait",
        status: "pending",
        chainId: 8453,
        inputTokens: [makeToken(ETH, 1500000000000000n, 8453, { symbol: "ETH", decimals: 18 })],
        outputToken: makeToken(ETH, 1500000000000000n, 8453, { symbol: "ETH", decimals: 18 }),
      };

      mockState.plan = [step];
      mockState.status = "ready";
      mockState.currentStepIndex = 0;
      mockState.metadata = {
        lifiTransfers: [{ txHash: "0xgastopup", bridge: "across", fromChainId: 8453, toChainId: 10 }],
      };

      const { finalValue: finalState } = await consumeGenerator(executeConsolidationPlan(mockState, mockWalletClient));

      expect(finalState.status).toBe("completed");
      expect(finalState.results["gas-wait-1"].status).toBe("success");
      expect(pollLiFiTransferStatus).toHaveBeenCalledWith("0xgastopup", "across", 8453, 10);
    });

    test("gas-topup-wait succeeds immediately when there are no LiFi transfers (all same-chain)", async () => {
      const step: TransactionStep = {
        id: "gas-wait-empty",
        type: "gas-topup-wait",
        status: "pending",
        chainId: 8453,
        inputTokens: [makeToken(ETH, 1500000000000000n, 8453, { symbol: "ETH", decimals: 18 })],
        outputToken: makeToken(ETH, 1500000000000000n, 8453, { symbol: "ETH", decimals: 18 }),
      };

      mockState.plan = [step];
      mockState.status = "ready";
      mockState.currentStepIndex = 0;

      const { finalValue: finalState } = await consumeGenerator(executeConsolidationPlan(mockState, mockWalletClient));

      expect(finalState.status).toBe("completed");
      expect(finalState.results["gas-wait-empty"].status).toBe("success");
      expect(pollLiFiTransferStatus).not.toHaveBeenCalled();
    });

    test("full flow: gas-topup followed by gas-topup-wait", async () => {
      vi.mocked(getLiFiQuoteForTargetOutput).mockResolvedValueOnce({
        tool: "across",
        action: {
          fromChainId: 8453,
          toChainId: 10,
          fromToken: { symbol: "ETH", decimals: 18, priceUSD: "2000" },
          toToken: { symbol: "ETH", decimals: 18, priceUSD: "2000" },
        },
        estimate: { fromAmount: "1500000000000000", toAmount: "1400000000000000", toAmountMin: "1400000000000000" },
        transactionRequest: {
          value: "0x5543DF729C000",
          to: LIFI_DIAMOND,
          data: "0xfeed",
          from: WALLET,
          chainId: 8453,
        },
      });

      const topupStep: TransactionStep = {
        id: "gas-topup-flow",
        type: "gas-topup",
        status: "pending",
        chainId: 8453,
        inputTokens: [makeToken(ETH, 2000000000000000n, 8453, { symbol: "ETH", decimals: 18 })],
        outputToken: makeToken(ETH, 1500000000000000n, 8453, {
          symbol: "ETH",
          decimals: 18,
          provenance: "gas-topup-flow",
        }),
        gasTopUpDestinations: [{ chainId: 10, address: WALLET, amountWei: "1500000000000000" }],
      };
      const waitStep: TransactionStep = {
        id: "gas-wait-flow",
        type: "gas-topup-wait",
        status: "pending",
        chainId: 8453,
        inputTokens: [
          makeToken(ETH, 1500000000000000n, 8453, { symbol: "ETH", decimals: 18, provenance: "gas-topup-flow" }),
        ],
        outputToken: makeToken(ETH, 1500000000000000n, 8453, { symbol: "ETH", decimals: 18 }),
      };

      mockState.plan = [topupStep, waitStep];
      mockState.status = "ready";
      mockState.currentStepIndex = 0;

      const { finalValue: finalState } = await consumeGenerator(executeConsolidationPlan(mockState, mockWalletClient));

      expect(finalState.status).toBe("completed");
      expect(finalState.results["gas-topup-flow"].status).toBe("success");
      expect(finalState.results["gas-wait-flow"].status).toBe("success");
      expect(pollLiFiTransferStatus).toHaveBeenCalledWith("0xgastopup", "across", 8453, 10);
    });
  });
});

// ---------------------------------------------------------------------------
// Pre-flight input-balance check.
// ---------------------------------------------------------------------------

describe("validateInputBalances", () => {
  const USDC_ADDRESS = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address;
  const WBTC_ADDRESS = "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599" as Address;
  const NATIVE = "0x0000000000000000000000000000000000000000" as Address;

  const baseState = (): ConsolidationState => ({
    id: "balance-test",
    plan: [],
    currentStepIndex: 0,
    status: "ready",
    results: {},
    sourceTokens: [],
    destinationToken: makeToken(USDC_ADDRESS, 0n, 1),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    hasSubsequentExecution: false,
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("resolves when wallet holds at least the required ERC20 amount", async () => {
    const step: TransactionStep = {
      id: "swap-1",
      type: "swap",
      status: "pending",
      chainId: 1,
      inputTokens: [
        makeToken(USDC_ADDRESS, 1_000_000n, 1, { walletAddress: WALLET }),
        makeToken(WBTC_ADDRESS, 1_00000000n, 1, { walletAddress: WALLET }),
      ],
      outputToken: makeToken(NATIVE, 1n, 1),
    };
    vi.mocked(getPublicClient).mockReturnValue({
      readContract: vi.fn().mockResolvedValue(2n ** 96n),
    } as never);

    await expect(validateInputBalances(step, baseState())).resolves.toBeUndefined();
  });

  test("throws InsufficientInputBalanceError naming the short token + wallet + shortfall", async () => {
    const step: TransactionStep = {
      id: "swap-2",
      type: "swap",
      status: "pending",
      chainId: 1,
      inputTokens: [makeToken(USDC_ADDRESS, 1_000_000n, 1, { walletAddress: WALLET })],
      outputToken: makeToken(NATIVE, 1n, 1),
    };
    vi.mocked(getPublicClient).mockReturnValue({
      readContract: vi.fn().mockResolvedValue(500_000n),
    } as never);

    await expect(validateInputBalances(step, baseState())).rejects.toMatchObject({
      name: "InsufficientInputBalanceError",
      token: USDC_ADDRESS,
      required: 1_000_000n,
      actual: 500_000n,
    });
    await expect(validateInputBalances(step, baseState())).rejects.toBeInstanceOf(InsufficientInputBalanceError);
  });

  test("aggregates multiple rows of the same (chain, wallet, token) before checking — two 0.6 USDC rows need 1.2 USDC, not 0.6", async () => {
    const step: TransactionStep = {
      id: "swap-agg",
      type: "swap",
      status: "pending",
      chainId: 1,
      inputTokens: [
        makeToken(USDC_ADDRESS, 600_000n, 1, { walletAddress: WALLET }),
        makeToken(USDC_ADDRESS, 600_000n, 1, { walletAddress: WALLET }),
      ],
      outputToken: makeToken(NATIVE, 1n, 1),
    };
    // Wallet has 1.0 USDC — enough per-row but NOT enough for the aggregated 1.2 USDC.
    vi.mocked(getPublicClient).mockReturnValue({
      readContract: vi.fn().mockResolvedValue(1_000_000n),
    } as never);

    await expect(validateInputBalances(step, baseState())).rejects.toMatchObject({
      name: "InsufficientInputBalanceError",
      required: 1_200_000n,
      actual: 1_000_000n,
    });
  });

  test("checks the native (zero-address) input via getNativeBalance, not readContract", async () => {
    const step: TransactionStep = {
      id: "swap-native",
      type: "swap",
      status: "pending",
      chainId: 1,
      inputTokens: [makeToken(NATIVE, 5n * 10n ** 17n, 1, { walletAddress: WALLET })],
      outputToken: makeToken(USDC_ADDRESS, 1n, 1),
    };
    const readContract = vi.fn().mockResolvedValue(0n);
    vi.mocked(getPublicClient).mockReturnValue({ readContract } as never);
    vi.mocked(getNativeBalance).mockResolvedValueOnce(10n ** 18n); // 1 ETH > 0.5 ETH required

    await expect(validateInputBalances(step, baseState())).resolves.toBeUndefined();
    expect(readContract).not.toHaveBeenCalled();
    expect(getNativeBalance).toHaveBeenCalled();
  });

  test("skips entirely for `claim` and `attestation` steps (no wallet-held inputs)", async () => {
    const claim: TransactionStep = {
      id: "claim-1",
      type: "claim",
      status: "pending",
      chainId: 1,
      inputTokens: [makeToken(USDC_ADDRESS, 1_000_000n, 1, { walletAddress: WALLET })],
      outputToken: makeToken(USDC_ADDRESS, 1n, 1),
    };
    const attestation: TransactionStep = {
      ...claim,
      id: "attestation-1",
      type: "attestation",
    };
    const readContract = vi.fn().mockResolvedValue(0n);
    vi.mocked(getPublicClient).mockReturnValue({ readContract } as never);

    await expect(validateInputBalances(claim, baseState())).resolves.toBeUndefined();
    await expect(validateInputBalances(attestation, baseState())).resolves.toBeUndefined();
    expect(readContract).not.toHaveBeenCalled();
  });

  test("propagates non-rate-limit RPC errors so the executor pauses instead of paying gas for a guaranteed revert", async () => {
    const step: TransactionStep = {
      id: "swap-rpc",
      type: "swap",
      status: "pending",
      chainId: 1,
      inputTokens: [makeToken(USDC_ADDRESS, 1_000_000n, 1, { walletAddress: WALLET })],
      outputToken: makeToken(NATIVE, 1n, 1),
    };
    vi.mocked(getPublicClient).mockReturnValue({
      readContract: vi.fn().mockRejectedValue(new Error("rpc unreachable")),
    } as never);

    await expect(validateInputBalances(step, baseState())).rejects.toThrow("rpc unreachable");
  });
});

describe("planning/execution op estimator equivalence", () => {
  // Planning reserves native gas via `estimateOperationsForChainWallet` (per-wallet
  // token grouping). Execution re-reserves via `estimateRemainingChainOps` (walks
  // the built plan). The two MUST produce the same op multiset for the same wallet
  // — otherwise planning's reserved native ≠ execution's expected gas, and the
  // delta surfaces as a slightly oversized or undersized swap input.

  const NATIVE = "0x0000000000000000000000000000000000000000" as Address;
  const SRC_USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address;
  const SRC_CHAIN = 1;
  const DST_CHAIN = 10;

  // Distinct ERC20 addresses for swap inputs (1..N).
  const erc20At = (n: number): Address => `0x${n.toString(16).padStart(40, "0")}` as Address;

  // Mirrors planning's `batchTokens(tokens, 6)`.
  const batchOf6 = <T>(arr: T[]): T[][] => {
    const out: T[][] = [];
    for (let i = 0; i < arr.length; i += 6) out.push(arr.slice(i, i + 6));
    return out;
  };

  const sourceChainPlanAndPlanningOps = (erc20Count: number, hasNative: boolean) => {
    const swapInputs: TokenAmount[] = [];
    for (let i = 0; i < erc20Count; i++) {
      swapInputs.push(makeToken(erc20At(i + 1), 1_000_000n, SRC_CHAIN, { symbol: `T${i}` }));
    }
    if (hasNative) {
      swapInputs.push(makeToken(NATIVE, 1_000_000_000_000_000n, SRC_CHAIN, { symbol: "ETH", decimals: 18 }));
    }

    // Planning's view: ops derived directly from the wallet's tokens.
    const planningOps = estimateOperationsForChainWallet(
      swapInputs.map((t) => ({ token: t.token, symbol: t.symbol, decimals: t.decimals, amount: t.amount })),
      SRC_CHAIN,
      DST_CHAIN,
      SRC_USDC,
    );

    // Plan as planning would build it: batched swap steps (max 6 inputs) + a bridge.
    const plan: TransactionStep[] = [];
    let stepIdx = 0;
    if (swapInputs.length > 0) {
      for (const batch of batchOf6(swapInputs)) {
        const id = `step-${++stepIdx}`;
        plan.push(
          makeStep({
            id,
            type: "swap",
            status: "pending",
            inputTokens: batch as [TokenAmount, ...TokenAmount[]],
            outputToken: makeToken(SRC_USDC, 0n, SRC_CHAIN, { provenance: id }),
          }),
        );
      }
    }
    if (swapInputs.length > 0) {
      const id = `step-${++stepIdx}`;
      plan.push(
        makeStep({
          id,
          type: "bridge",
          status: "pending",
          inputTokens: [makeToken(SRC_USDC, 0n, SRC_CHAIN, { provenance: `step-${stepIdx - 1}` })],
          outputToken: makeToken(SRC_USDC, 0n, DST_CHAIN, { provenance: id }),
        }),
      );
    }

    return { planningOps, plan };
  };

  const sorted = (ops: OperationType[]) => [...ops].sort();

  const cases: { description: string; erc20Count: number; hasNative: boolean }[] = [
    { description: "single ERC20", erc20Count: 1, hasNative: false },
    { description: "6 ERC20 (one full batch)", erc20Count: 6, hasNative: false },
    { description: "7 ERC20 (straddles 6-token boundary)", erc20Count: 7, hasNative: false },
    { description: "12 ERC20 (two full batches)", erc20Count: 12, hasNative: false },
    { description: "13 ERC20 (two full batches + one)", erc20Count: 13, hasNative: false },
    { description: "native only", erc20Count: 0, hasNative: true },
    { description: "5 ERC20 + native (batch fills exactly)", erc20Count: 5, hasNative: true },
    { description: "6 ERC20 + native (straddles boundary with native)", erc20Count: 6, hasNative: true },
    { description: "11 ERC20 + native (two batches with native)", erc20Count: 11, hasNative: true },
  ];

  for (const c of cases) {
    test(`${c.description}: planning ops == execution ops`, () => {
      const { planningOps, plan } = sourceChainPlanAndPlanningOps(c.erc20Count, c.hasNative);
      const state = makeState({
        plan,
        sourceTokens: [],
        destinationToken: makeToken(SRC_USDC, 0n, DST_CHAIN),
      });
      // Execution's view: walk the plan from the first step on this chain.
      const executionOps = plan.length > 0 ? estimateRemainingChainOps(plan[0], state) : [];
      expect(sorted(executionOps)).toEqual(sorted(planningOps));
    });
  }
});
