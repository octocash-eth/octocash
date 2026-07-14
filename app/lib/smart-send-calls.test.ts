import type { Address, Hex } from "viem";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { SendCallsBundleRecord, SmartStepExecution } from "./types";

vi.mock("./send-calls", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./send-calls")>()),
  sendCallsBundle: vi.fn(),
  switchChain: vi.fn(),
}));
vi.mock("./public-client", () => ({
  getPublicClient: vi.fn(),
  retryOnRateLimit: (fn: () => unknown) => fn(),
}));

import { getPublicClient } from "./public-client";
import { SendCallsError, sendCallsBundle, switchChain } from "./send-calls";
import { type SmartStepHooks, sendCallsViaSmart } from "./smart-send-calls";

const SMART = "0x4444444444444444444444444444444444444444" as Address;
const TARGET = "0x5555555555555555555555555555555555555555" as Address;
const CALLS = [
  { to: TARGET, data: "0xaaaa" as Hex },
  { to: TARGET, data: "0xbbbb" as Hex },
];

const getCallsStatusMock = vi.fn();
const client = { account: { address: SMART }, getCallsStatus: getCallsStatusMock } as never;

const execution = (atomic: boolean): SmartStepExecution => ({
  via: "smart",
  smartAddress: SMART,
  atomic,
  batchId: "batch-1",
});

function makeHooks(existing?: SendCallsBundleRecord): SmartStepHooks & { persisted: SendCallsBundleRecord[] } {
  const persisted: SendCallsBundleRecord[] = [];
  let current = existing;
  return {
    persisted,
    getBundle: () => current,
    persistBundle: (record) => {
      persisted.push(record);
      current = record;
    },
    onProgress: vi.fn(),
  };
}

const record = (overrides: Partial<SendCallsBundleRecord> = {}): SendCallsBundleRecord => ({
  id: "bundle-1",
  chainId: 10,
  account: SMART,
  stepIds: ["step-1"],
  atomic: true,
  sentAt: 0,
  status: "sent",
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(sendCallsBundle).mockResolvedValue(["0xbundlehash" as Hex, [[]]]);
  getCallsStatusMock.mockReset();
  vi.mocked(getPublicClient).mockReturnValue({
    getTransactionReceipt: vi.fn().mockResolvedValue({ status: "success", logs: [{ address: TARGET }] }),
  } as never);
});

describe("sendCallsViaSmart", () => {
  test("atomic: all calls go out as ONE forceAtomic bundle", async () => {
    const hooks = makeHooks();
    const [hash] = await sendCallsViaSmart({
      client,
      txId: "swap",
      chainId: 10,
      execution: execution(true),
      stepIds: ["step-1"],
      calls: CALLS,
      mode: "atomic-steps",
      hooks,
    });

    expect(hash).toBe("0xbundlehash");
    expect(switchChain).toHaveBeenCalledWith(client, 10);
    expect(sendCallsBundle).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendCallsBundle).mock.calls[0][1]).toMatchObject({
      from: SMART,
      forceAtomic: true,
      calls: CALLS,
    });
  });

  test("sequential: one single-call bundle per call when atomic isn't supported", async () => {
    const hooks = makeHooks();
    await sendCallsViaSmart({
      client,
      txId: "swap",
      chainId: 10,
      execution: execution(false),
      stepIds: ["step-1"],
      calls: CALLS,
      mode: "atomic-steps",
      hooks,
    });

    expect(sendCallsBundle).toHaveBeenCalledTimes(2);
    expect(vi.mocked(sendCallsBundle).mock.calls[0][1]).toMatchObject({ forceAtomic: false, calls: [CALLS[0]] });
    expect(vi.mocked(sendCallsBundle).mock.calls[1][1]).toMatchObject({ forceAtomic: false, calls: [CALLS[1]] });
  });

  test("degrades to sequential once when the wallet refuses atomicity", async () => {
    const atomicityError = Object.assign(new Error("wallet does not support atomic execution"), {
      name: "AtomicityNotSupportedError",
    });
    vi.mocked(sendCallsBundle)
      .mockRejectedValueOnce(atomicityError)
      .mockResolvedValue(["0xseq" as Hex, [[]]]);

    const hooks = makeHooks();
    const [hash] = await sendCallsViaSmart({
      client,
      txId: "swap",
      chainId: 10,
      execution: execution(true),
      stepIds: ["step-1"],
      calls: CALLS,
      mode: "atomic-steps",
      hooks,
    });

    expect(hash).toBe("0xseq");
    // 1 refused atomic attempt + 2 sequential sub-bundles.
    expect(sendCallsBundle).toHaveBeenCalledTimes(3);
    expect(vi.mocked(sendCallsBundle).mock.calls[1][1]).toMatchObject({ forceAtomic: false, calls: [CALLS[0]] });
  });

  test("atomic-multicall mode keeps the Multicall3 wrapper (CCTP destinationCaller)", async () => {
    const hooks = makeHooks();
    await sendCallsViaSmart({
      client,
      txId: "mint",
      chainId: 10,
      execution: execution(true),
      stepIds: ["step-1"],
      calls: CALLS,
      mode: "atomic-multicall",
      hooks,
    });

    const sent = vi.mocked(sendCallsBundle).mock.calls[0][1];
    expect(sent.calls).toHaveLength(1);
    expect(sent.calls[0].to).toBe("0xcA11bde05977b3631167028862bE2a173976CA11");
    expect(sent.calls[0].data).toContain("82ad56cb"); // aggregate3 selector
  });

  test("resume: a pending bundle re-enters the wait on the same id, no re-send", async () => {
    getCallsStatusMock.mockResolvedValue({ status: "pending" });
    const hooks = makeHooks(record());

    const [hash] = await sendCallsViaSmart({
      client,
      txId: "swap",
      chainId: 10,
      execution: execution(true),
      stepIds: ["step-1"],
      calls: CALLS,
      mode: "atomic-steps",
      hooks,
    });

    expect(hash).toBe("0xbundlehash");
    expect(sendCallsBundle).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendCallsBundle).mock.calls[0][1]).toMatchObject({ existingBundleId: "bundle-1" });
  });

  test("resume: an already-executed bundle settles from its receipts without sending", async () => {
    getCallsStatusMock.mockResolvedValue({
      status: "success",
      receipts: [{ status: "success", transactionHash: "0xminedhash" }],
    });
    const hooks = makeHooks(record());

    const [hash, logs] = await sendCallsViaSmart({
      client,
      txId: "swap",
      chainId: 10,
      execution: execution(true),
      stepIds: ["step-1"],
      calls: CALLS,
      mode: "atomic-steps",
      hooks,
    });

    expect(hash).toBe("0xminedhash");
    expect(logs.flat()[0]).toMatchObject({ address: TARGET });
    expect(sendCallsBundle).not.toHaveBeenCalled();
    expect(hooks.persisted.at(-1)).toMatchObject({ status: "confirmed", transactionHash: "0xminedhash" });
  });

  test("resume: unknown wallet-scoped id falls back to the persisted tx hash", async () => {
    getCallsStatusMock.mockRejectedValue(new Error("unknown bundle id"));
    const hooks = makeHooks(record({ transactionHash: "0xanchored" as Hex }));

    const [hash] = await sendCallsViaSmart({
      client,
      txId: "swap",
      chainId: 10,
      execution: execution(true),
      stepIds: ["step-1"],
      calls: CALLS,
      mode: "atomic-steps",
      hooks,
    });

    expect(hash).toBe("0xanchored");
    expect(sendCallsBundle).not.toHaveBeenCalled();
  });

  test("resume: unknown id with NO anchor pauses recoverably — never blind-resends", async () => {
    getCallsStatusMock.mockRejectedValue(new Error("unknown bundle id"));
    const hooks = makeHooks(record());

    await expect(
      sendCallsViaSmart({
        client,
        txId: "swap",
        chainId: 10,
        execution: execution(true),
        stepIds: ["step-1"],
        calls: CALLS,
        mode: "atomic-steps",
        hooks,
      }),
    ).rejects.toThrow(/Cannot verify the previous call bundle/);
    expect(sendCallsBundle).not.toHaveBeenCalled();
  });

  test("resume: a definitively failed bundle falls through to a fresh attempt", async () => {
    getCallsStatusMock.mockResolvedValue({
      status: "failure",
      receipts: [],
    });
    const hooks = makeHooks(record());

    const [hash] = await sendCallsViaSmart({
      client,
      txId: "swap",
      chainId: 10,
      execution: execution(true),
      stepIds: ["step-1"],
      calls: CALLS,
      mode: "atomic-steps",
      hooks,
    });

    expect(hash).toBe("0xbundlehash");
    expect(sendCallsBundle).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendCallsBundle).mock.calls[0][1]).not.toHaveProperty("existingBundleId", "bundle-1");
  });

  test("sequential resume: a confirmed mid-way sub-bundle resumes at the NEXT call", async () => {
    getCallsStatusMock.mockResolvedValue({
      status: "success",
      receipts: [{ status: "success", transactionHash: "0xcall0" }],
    });
    const hooks = makeHooks(record({ atomic: false, callIndex: 0 }));

    await sendCallsViaSmart({
      client,
      txId: "swap",
      chainId: 10,
      execution: execution(false),
      stepIds: ["step-1"],
      calls: CALLS,
      mode: "atomic-steps",
      hooks,
    });

    // Only call index 1 is re-sent — call 0 already mined.
    expect(sendCallsBundle).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendCallsBundle).mock.calls[0][1]).toMatchObject({ calls: [CALLS[1]] });
  });

  test("errors from the bundle primitive keep their SendCallsError identity", async () => {
    vi.mocked(sendCallsBundle).mockRejectedValue(
      new SendCallsError("swap call bundle failed", { bundleId: "bundle-x" }),
    );
    const hooks = makeHooks();

    await expect(
      sendCallsViaSmart({
        client,
        txId: "swap",
        chainId: 10,
        execution: execution(true),
        stepIds: ["step-1"],
        calls: CALLS,
        mode: "atomic-steps",
        hooks,
      }),
    ).rejects.toMatchObject({ name: "SendCallsError", bundleId: "bundle-x" });
  });
});
