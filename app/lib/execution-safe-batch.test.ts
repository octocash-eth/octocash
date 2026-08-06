import type { Account, Address, Chain, HttpTransport, WalletClient } from "viem";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { consumeGenerator, WALLET } from "../../test/test-helpers";
import type { ConsolidationState, TokenAmount, TransactionStep } from "./types";

// Mock dependencies BEFORE imports. The Safe send path itself is exercised in
// safe-send-calls.test.ts; here we mock it to test the GROUP orchestration in
// execution.ts: one submission for the whole batch, shared results, atomic
// failure, per-member output attribution.
vi.mock("./delora", async () => {
  const actual = await vi.importActual<typeof import("./delora")>("./delora");
  return {
    ...actual,
    buildDeloraCalls: vi.fn(),
    simulateSwapDelivery: vi.fn(),
    getSwapQuote: vi.fn(),
    executeDeloraSwap: vi.fn(),
  };
});
vi.mock("./cctp");
vi.mock("./omnibridge");
vi.mock("./gas-refuel");
vi.mock("./safe-send-calls", async () => {
  const actual = await vi.importActual<typeof import("./safe-send-calls")>("./safe-send-calls");
  return {
    ...actual,
    prepareStepSendCalls: vi.fn(),
  };
});
vi.mock("./public-client", () => ({
  getPublicClient: vi.fn(() => ({
    readContract: vi.fn().mockResolvedValue(2n ** 128n),
  })),
  retryOnRateLimit: vi.fn(<T>(fn: () => Promise<T>) => fn()),
}));
vi.mock("./gas", () => ({
  getNativeBalance: vi.fn().mockResolvedValue(2n ** 128n),
}));

import { buildDeloraCalls, deriveSwapOutputAmount, simulateSwapDelivery } from "./delora";
import { executeConsolidationPlan } from "./execution";
import { prepareStepSendCalls } from "./safe-send-calls";
import { SendCallsError } from "./send-calls";

const SAFE = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Address;
const OWNER = WALLET;
const TOKEN_A = "0x00000000000000000000000000000000000000aa" as Address;
const TOKEN_B = "0x00000000000000000000000000000000000000bb" as Address;
const USDC_OP = "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85" as Address;

const walletClient = {
  account: { address: OWNER } as Account,
  chain: { id: 10 } as Chain,
} as unknown as WalletClient<HttpTransport, Chain, Account>;

const execution = (batchId: string) => ({
  via: "safe" as const,
  safeAddress: SAFE,
  ownerAddress: OWNER,
  threshold: 1,
  safeVersion: "1.4.1",
  batchId,
});

function swapStep(id: string, token: Address, amountIn: bigint, quotedOut: bigint): TransactionStep {
  const input: TokenAmount = {
    token,
    amount: amountIn,
    chainId: 10,
    walletAddress: SAFE,
    symbol: "TKN",
    decimals: 18,
  };
  return {
    id,
    type: "swap",
    status: "pending",
    chainId: 10,
    inputTokens: [input],
    outputToken: { token: USDC_OP, amount: quotedOut, chainId: 10, walletAddress: SAFE, symbol: "USDC", decimals: 6 },
    quotedAt: Date.now(), // fresh, so the pre-step re-quote is skipped
    execution: execution("batch-x"),
  };
}

function makeGroupState(steps: TransactionStep[]): ConsolidationState {
  return {
    id: "c1",
    plan: steps,
    currentStepIndex: 0,
    status: "ready",
    results: {},
    sourceTokens: steps.flatMap((s) => s.inputTokens),
    destinationToken: steps[0].outputToken,
    accounts: {
      [SAFE.toLowerCase()]: {
        kind: "safe",
        address: SAFE,
        ownerAddress: OWNER,
        deployments: {
          10: { chainId: 10, owners: [OWNER], threshold: 1, nonce: 0, version: "1.4.1", controlled: true },
        },
        fetchedAt: 0,
      },
    },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

const sendCallsMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prepareStepSendCalls).mockReturnValue(sendCallsMock);
  vi.mocked(buildDeloraCalls).mockImplementation(async (tokensIn) => ({
    calls: [
      { to: tokensIn[0].token, data: "0xa9059cbb" as const }, // approve stand-in
      { to: "0x00000000000000000000000000000000000000ff" as Address, data: "0x12345678" as const }, // swap stand-in
    ],
    minOutputAmount: 1n,
    expectedOutputAmount: 1n,
  }));
  vi.mocked(simulateSwapDelivery).mockResolvedValue(undefined);
  sendCallsMock.mockResolvedValue(["0xgrouptx", [[]]]);
});

describe("Safe batch group execution", () => {
  test("two independent swaps execute as ONE submission and share the tx hash", async () => {
    const stepA = swapStep("step-1", TOKEN_A, 10n ** 18n, 1_000_000n);
    const stepB = swapStep("step-2", TOKEN_B, 2n * 10n ** 18n, 3_000_000n);
    const state = makeGroupState([stepA, stepB]);

    const { finalValue } = await consumeGenerator(executeConsolidationPlan(state, walletClient));

    // One Safe submission carrying all four inner calls (2 approve+swap pairs).
    expect(sendCallsMock).toHaveBeenCalledTimes(1);
    const [txId, chainId, from, calls] = sendCallsMock.mock.calls[0];
    expect([txId, chainId, from]).toEqual(["batch", 10, SAFE]);
    expect(calls).toHaveLength(4);
    expect(calls[0].to).toBe(TOKEN_A);
    expect(calls[2].to).toBe(TOKEN_B);

    expect(finalValue.status).toBe("completed");
    expect(finalValue.results["step-1"]).toMatchObject({ status: "success", transactionHash: "0xgrouptx" });
    expect(finalValue.results["step-2"]).toMatchObject({ status: "success", transactionHash: "0xgrouptx" });
    // Same-output-token members split the derived total proportionally to
    // their planned amounts (no Transfer logs in the mock receipt, so
    // deriveSwapOutputAmount falls back to the quoted amount of the token).
    const derived = deriveSwapOutputAmount([], stepA.outputToken);
    const totalPlanned = 4_000_000n;
    expect(finalValue.results["step-1"].actualOutput?.amount).toBe((derived * 1_000_000n) / totalPlanned);
    expect(finalValue.results["step-2"].actualOutput?.amount).toBe(derived - (derived * 1_000_000n) / totalPlanned);
  });

  test("a group failure fails every member and pauses the plan", async () => {
    sendCallsMock.mockRejectedValue(
      new SendCallsError("Transaction would revert: GS013", { transactionHash: "0xdead" }),
    );
    const stepA = swapStep("step-1", TOKEN_A, 10n ** 18n, 1_000_000n);
    const stepB = swapStep("step-2", TOKEN_B, 2n * 10n ** 18n, 3_000_000n);
    const state = makeGroupState([stepA, stepB]);

    const { finalValue } = await consumeGenerator(executeConsolidationPlan(state, walletClient));

    expect(finalValue.status).toBe("paused");
    expect(finalValue.results["step-1"]).toMatchObject({ status: "failed", transactionHash: "0xdead" });
    expect(finalValue.results["step-2"]).toMatchObject({ status: "failed", transactionHash: "0xdead" });
    expect(finalValue.plan.every((s) => s.status === "failed")).toBe(true);
  });

  test("singleton groups keep the plain per-step path", async () => {
    const stepA = swapStep("step-1", TOKEN_A, 10n ** 18n, 1_000_000n);
    stepA.execution = execution("batch-solo");
    const state = makeGroupState([stepA]);

    // The single-step path routes through executeDeloraSwap, which builds and
    // sends via the (mocked) router itself.
    const { executeDeloraSwap } = await import("./delora");
    vi.mocked(executeDeloraSwap).mockResolvedValue({ amount: 999_000n, transactionHash: "0xsolo" });
    vi.mocked(await import("./delora").then((m) => m.getSwapQuote)).mockResolvedValue(stepA.outputToken);

    const { finalValue } = await consumeGenerator(executeConsolidationPlan(state, walletClient));

    expect(finalValue.status).toBe("completed");
    expect(vi.mocked(executeDeloraSwap)).toHaveBeenCalledTimes(1);
    expect(sendCallsMock).not.toHaveBeenCalled();
    expect(finalValue.results["step-1"]).toMatchObject({ status: "success", transactionHash: "0xsolo" });
  });
});
