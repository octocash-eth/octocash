import type { Account, Address, Chain, HttpTransport, WalletClient } from "viem";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { tokenMessenger } from "~/data/cctp-contracts";
import { consumeGenerator, WALLET } from "../../test/test-helpers";
import type { ConsolidationState, TransactionStep } from "./types";

// The reconcile probe for smart-account steps must be LOG-based: the outer tx
// is a UserOperation via the ERC-4337 EntryPoint, so the receipt's `to` is
// never the target contract — and outer success doesn't imply inner success.
vi.mock("./delora");
vi.mock("./cctp");
vi.mock("./omnibridge");
vi.mock("./gas-refuel");
vi.mock("./send-calls", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./send-calls")>()),
  prepareSendCalls: vi.fn(() => vi.fn()),
}));
vi.mock("./public-client", () => ({
  getPublicClient: vi.fn(),
  retryOnRateLimit: vi.fn(<T>(fn: () => Promise<T>) => fn()),
}));
vi.mock("./gas", () => ({
  getNativeBalance: vi.fn().mockResolvedValue(2n ** 128n),
}));

import { executeCCTPBurn } from "./cctp";
import { executeConsolidationPlan } from "./execution";
import { getPublicClient } from "./public-client";

const SMART = "0x4444444444444444444444444444444444444444" as Address;
const ENTRY_POINT_V07 = "0x0000000071727De22E5E9d8BAf0edAc6f37da032" as Address;
const USDC_OP = "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85" as Address;

const walletClient = {
  account: { address: WALLET },
  chain: { id: 10 },
} as unknown as WalletClient<HttpTransport, Chain, Account>;

function makeBridgeState(): ConsolidationState {
  const step: TransactionStep = {
    id: "step-1",
    type: "bridge",
    status: "pending",
    chainId: 10,
    inputTokens: [
      { token: USDC_OP, amount: 5_000_000n, chainId: 10, walletAddress: SMART, symbol: "USDC", decimals: 6 },
    ],
    outputToken: { token: USDC_OP, amount: 5_000_000n, chainId: 1, walletAddress: SMART, symbol: "USDC", decimals: 6 },
    transactionHash: "0xprioruserop",
    execution: { via: "smart", smartAddress: SMART, atomic: true, batchId: "smart-batch-step-1" },
  };
  return {
    id: "c1",
    plan: [step],
    currentStepIndex: 0,
    status: "ready",
    results: {},
    sourceTokens: step.inputTokens,
    destinationToken: step.outputToken,
    accounts: {
      [SMART.toLowerCase()]: {
        kind: "smart",
        address: SMART,
        deployments: { 10: { chainId: 10, atomic: "supported" }, 1: { chainId: 1, atomic: "supported" } },
        fetchedAt: 0,
      },
    },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function mockReceipt(logs: { address: Address }[]) {
  vi.mocked(getPublicClient).mockReturnValue({
    getTransactionReceipt: vi.fn().mockResolvedValue({
      status: "success",
      to: ENTRY_POINT_V07, // outer tx target is the EntryPoint, never the TokenMessenger
      logs,
    }),
    readContract: vi.fn().mockResolvedValue(2n ** 128n),
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(executeCCTPBurn).mockResolvedValue(["0xfreshburn", 10]);
});

describe("smart-account reconcile (UserOp receipts)", () => {
  test("a mined UserOp with TokenMessenger logs reconciles as success — no re-broadcast", async () => {
    mockReceipt([{ address: tokenMessenger[10] as Address }, { address: USDC_OP }]);
    const state = makeBridgeState();

    const { finalValue } = await consumeGenerator(executeConsolidationPlan(state, walletClient));

    expect(finalValue.results["step-1"]).toMatchObject({ status: "success", transactionHash: "0xprioruserop" });
    expect(executeCCTPBurn).not.toHaveBeenCalled();
  });

  test("a mined UserOp WITHOUT TokenMessenger logs (inner revert / unrelated tx) re-executes fresh", async () => {
    // Outer receipt succeeded — but no event from the TokenMessenger means
    // the burn never happened. The old `to`-based discriminator would have
    // false-positived here; the log-based one correctly retries.
    mockReceipt([{ address: USDC_OP }]);
    const state = makeBridgeState();

    const { finalValue } = await consumeGenerator(executeConsolidationPlan(state, walletClient));

    expect(executeCCTPBurn).toHaveBeenCalledTimes(1);
    expect(finalValue.results["step-1"]).toMatchObject({ status: "success", transactionHash: "0xfreshburn" });
  });
});
