import type { Address, Hex } from "viem";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { ConsolidationState, SafeProposalRecord, TransactionStep } from "./types";

vi.mock("./api/safe-transaction-service", () => ({
  getSafeTx: vi.fn(),
  proposeSafeTx: vi.fn(),
}));
vi.mock("./safe", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./safe")>()),
  readSafeInfo: vi.fn(),
  signSafeTx: vi.fn(),
}));
vi.mock("./send-calls", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./send-calls")>()),
  prepareSendCalls: vi.fn(),
  switchChain: vi.fn(),
}));
vi.mock("./public-client", () => ({
  getPublicClient: vi.fn(),
  retryOnRateLimit: (fn: () => unknown) => fn(),
}));
// Make the confirmation-wait sleep instantaneous so poll loops advance
// without fake timers.
vi.mock("./cctp", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./cctp")>()),
  abortableSleep: vi.fn().mockResolvedValue(undefined),
}));

import { getSafeTx, proposeSafeTx } from "./api/safe-transaction-service";
import { getPublicClient } from "./public-client";
import { approvedHashSignature, readSafeInfo, signSafeTx } from "./safe";
import { prepareStepSendCalls, type SafeStepHooks } from "./safe-send-calls";
import { prepareSendCalls, SendCallsError } from "./send-calls";

const SAFE = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Address;
const OWNER = "0x1111111111111111111111111111111111111111" as Address;
const CO_SIGNER = "0x2222222222222222222222222222222222222222" as Address;
const EOA = "0x3333333333333333333333333333333333333333" as Address;
const CALLS = [{ to: EOA, data: "0xabcdef" as Hex, value: 0n }];

const walletClient = { account: { address: OWNER } } as never;

function makeStep(threshold: number, withExecution = true): TransactionStep {
  return {
    id: "step-1",
    type: "swap",
    status: "executing",
    chainId: 10,
    inputTokens: [{ token: EOA, amount: 10n, chainId: 10, walletAddress: SAFE, symbol: "AAA", decimals: 18 }],
    outputToken: { token: EOA, amount: 5n, chainId: 10, walletAddress: SAFE, symbol: "USDC", decimals: 6 },
    ...(withExecution
      ? {
          execution: {
            via: "safe" as const,
            safeAddress: SAFE,
            ownerAddress: OWNER,
            threshold,
            safeVersion: "1.4.1",
            batchId: "batch-1",
          },
        }
      : {}),
  };
}

function makeState(step: TransactionStep, proposal?: SafeProposalRecord): ConsolidationState {
  return {
    id: "c1",
    plan: [step],
    currentStepIndex: 0,
    status: "executing",
    results: {},
    sourceTokens: [],
    destinationToken: step.outputToken,
    ...(proposal ? { metadata: { safe: { proposals: { "batch-1": proposal } } } } : {}),
    createdAt: 0,
    updatedAt: 0,
  };
}

function makeHooks(state: ConsolidationState): SafeStepHooks & { persisted: SafeProposalRecord[] } {
  const persisted: SafeProposalRecord[] = [];
  return {
    persisted,
    getProposal: () => state.metadata?.safe?.proposals?.["batch-1"],
    persistProposal: (record) => {
      persisted.push(record);
      state.metadata = { ...state.metadata, safe: { proposals: { "batch-1": record } } };
    },
    onProgress: vi.fn(),
  };
}

const eoaSend = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prepareSendCalls).mockReturnValue(eoaSend);
  eoaSend.mockResolvedValue(["0xexechash", [[]]]);
  vi.mocked(readSafeInfo).mockResolvedValue({
    address: SAFE,
    owners: [OWNER, CO_SIGNER],
    threshold: 1,
    nonce: 7,
    version: "1.4.1",
  });
  vi.mocked(signSafeTx).mockResolvedValue("0x5170" as Hex);
  vi.mocked(getSafeTx).mockResolvedValue(null);
  vi.mocked(proposeSafeTx).mockResolvedValue(undefined);
  vi.mocked(getPublicClient).mockReturnValue({
    getTransactionReceipt: vi.fn().mockResolvedValue({ status: "success", logs: [{ address: EOA }] }),
  } as never);
});

describe("prepareStepSendCalls routing", () => {
  test("steps without an execution tag take the EOA path untouched", async () => {
    const step = makeStep(1, false);
    const state = makeState(step);
    const sendCalls = prepareStepSendCalls(walletClient, step, state, makeHooks(state));

    await sendCalls("swap", 10, EOA, CALLS, "atomic-steps", undefined);

    expect(eoaSend).toHaveBeenCalledWith("swap", 10, EOA, CALLS, "atomic-steps", undefined);
    expect(readSafeInfo).not.toHaveBeenCalled();
  });

  test("non-Safe senders on a tagged step (e.g. owner-EOA claims) also pass through", async () => {
    const step = makeStep(1);
    const state = makeState(step);
    const sendCalls = prepareStepSendCalls(walletClient, step, state, makeHooks(state));

    await sendCalls("mint", 10, OWNER, CALLS, "atomic-multicall", undefined);

    expect(eoaSend).toHaveBeenCalledWith("mint", 10, OWNER, CALLS, "atomic-multicall", undefined);
    expect(readSafeInfo).not.toHaveBeenCalled();
  });
});

describe("1/1 fast path", () => {
  test("executes immediately via approved-hash: no signature popup, no service round-trip", async () => {
    const step = makeStep(1);
    const state = makeState(step);
    const hooks = makeHooks(state);
    const sendCalls = prepareStepSendCalls(walletClient, step, state, hooks);

    const [hash] = await sendCalls("swap", 10, SAFE, CALLS, "atomic-steps", undefined);

    expect(hash).toBe("0xexechash");
    expect(signSafeTx).not.toHaveBeenCalled();
    expect(proposeSafeTx).not.toHaveBeenCalled();
    // The one on-chain tx is execTransaction to the Safe, sent by the owner.
    const [txId, chainId, from, calls] = eoaSend.mock.calls[0];
    expect([txId, chainId, from]).toEqual(["swap", 10, OWNER]);
    expect(calls[0].to).toBe(SAFE);
    expect(calls[0].data).toContain("6a761202"); // execTransaction selector
    // Approved-hash sentinel for the executing owner is embedded in the calldata.
    expect(calls[0].data).toContain(approvedHashSignature(OWNER).slice(2, 42).toLowerCase());
    expect(hooks.persisted.at(-1)).toMatchObject({ status: "executed", executedTxHash: "0xexechash" });
  });

  test("connected non-owner is rejected before any transaction", async () => {
    vi.mocked(readSafeInfo).mockResolvedValue({
      address: SAFE,
      owners: [CO_SIGNER],
      threshold: 1,
      nonce: 7,
      version: "1.4.1",
    });
    const step = makeStep(1);
    const state = makeState(step);
    const sendCalls = prepareStepSendCalls(walletClient, step, state, makeHooks(state));

    await expect(sendCalls("swap", 10, SAFE, CALLS, "atomic-steps", undefined)).rejects.toThrow(/SafeNotOwnerError/);
    expect(eoaSend).not.toHaveBeenCalled();
  });
});

describe("N-of-M propose-and-wait", () => {
  test("signs, proposes, waits for the co-signer, then executes with both signatures", async () => {
    vi.mocked(readSafeInfo).mockResolvedValue({
      address: SAFE,
      owners: [OWNER, CO_SIGNER],
      threshold: 2,
      nonce: 7,
      version: "1.4.1",
    });
    // First poll: only our confirmation; second poll: co-signer confirmed.
    vi.mocked(getSafeTx)
      .mockResolvedValueOnce({
        safeTxHash: "0x00" as Hex,
        nonce: 7,
        to: EOA,
        value: "0",
        data: "0x",
        operation: 0,
        isExecuted: false,
        isSuccessful: null,
        transactionHash: null,
        confirmations: [{ owner: OWNER, signature: "0x5170" as Hex, signatureType: "EOA" }],
        confirmationsRequired: 2,
      })
      .mockResolvedValueOnce({
        safeTxHash: "0x00" as Hex,
        nonce: 7,
        to: EOA,
        value: "0",
        data: "0x",
        operation: 0,
        isExecuted: false,
        isSuccessful: null,
        transactionHash: null,
        confirmations: [
          { owner: OWNER, signature: "0x5170" as Hex, signatureType: "EOA" },
          { owner: CO_SIGNER, signature: `0x${"11".repeat(65)}` as Hex, signatureType: "EOA" },
        ],
        confirmationsRequired: 2,
      });

    const step = makeStep(2);
    const state = makeState(step);
    const hooks = makeHooks(state);
    const sendCalls = prepareStepSendCalls(walletClient, step, state, hooks);

    const [hash] = await sendCalls("swap", 10, SAFE, CALLS, "atomic-steps", undefined);

    expect(hash).toBe("0xexechash");
    expect(signSafeTx).toHaveBeenCalledTimes(1);
    expect(proposeSafeTx).toHaveBeenCalledTimes(1);
    const proposePayload = vi.mocked(proposeSafeTx).mock.calls[0][2];
    expect(proposePayload).toMatchObject({ nonce: 7, sender: OWNER, signature: "0x5170" });
    // Proposal persisted BEFORE the wait; final record executed.
    expect(hooks.persisted[0]).toMatchObject({ status: "proposed", safeNonce: 7, threshold: 2 });
    expect(hooks.persisted.at(-1)).toMatchObject({ status: "executed" });
    // The exec calldata carries the co-signer's signature too.
    const execData = eoaSend.mock.calls[0][3][0].data as string;
    expect(execData).toContain("11".repeat(65));
  });

  test("detects execution by someone else and settles from their receipt", async () => {
    vi.mocked(readSafeInfo).mockResolvedValue({
      address: SAFE,
      owners: [OWNER, CO_SIGNER],
      threshold: 2,
      nonce: 7,
      version: "1.4.1",
    });
    vi.mocked(getSafeTx).mockResolvedValue({
      safeTxHash: "0x00" as Hex,
      nonce: 7,
      to: EOA,
      value: "0",
      data: "0x",
      operation: 0,
      isExecuted: true,
      isSuccessful: true,
      transactionHash: "0xsomeoneelse" as Hex,
      confirmations: [],
      confirmationsRequired: 2,
    });

    const step = makeStep(2);
    const state = makeState(step);
    const hooks = makeHooks(state);
    const sendCalls = prepareStepSendCalls(walletClient, step, state, hooks);

    const [hash] = await sendCalls("swap", 10, SAFE, CALLS, "atomic-steps", undefined);

    expect(hash).toBe("0xsomeoneelse");
    expect(eoaSend).not.toHaveBeenCalled();
    expect(hooks.persisted.at(-1)).toMatchObject({ status: "executed", executedTxHash: "0xsomeoneelse" });
  });

  test("resume: a persisted proposal whose nonce was consumed is superseded", async () => {
    const record: SafeProposalRecord = {
      chainId: 10,
      safeAddress: SAFE,
      stepIds: ["step-1"],
      safeTxHash: `0x${"aa".repeat(32)}` as Hex,
      safeNonce: 6,
      tx: { to: EOA, value: "0", data: "0xabcdef", operation: 0 },
      threshold: 2,
      confirmations: [{ owner: OWNER, signature: "0x5170" as Hex }],
      executor: OWNER,
      proposedAt: 0,
      status: "proposed",
    };
    // On-chain nonce (7) has advanced past the record's (6).
    const step = makeStep(2);
    const state = makeState(step, record);
    const hooks = makeHooks(state);
    const sendCalls = prepareStepSendCalls(walletClient, step, state, hooks);

    await expect(sendCalls("swap", 10, SAFE, CALLS, "atomic-steps", undefined)).rejects.toThrow(
      /SafeTxSupersededError/,
    );
    expect(hooks.persisted.at(-1)).toMatchObject({ status: "superseded" });
    expect(eoaSend).not.toHaveBeenCalled();
  });

  test("resume: a still-pending proposal re-enters the wait and executes once confirmed", async () => {
    const record: SafeProposalRecord = {
      chainId: 10,
      safeAddress: SAFE,
      stepIds: ["step-1"],
      safeTxHash: `0x${"aa".repeat(32)}` as Hex,
      safeNonce: 7,
      tx: { to: EOA, value: "0", data: "0xabcdef", operation: 0 },
      threshold: 2,
      confirmations: [{ owner: OWNER, signature: "0x5170" as Hex }],
      executor: OWNER,
      proposedAt: 0,
      status: "proposed",
    };
    vi.mocked(getSafeTx).mockResolvedValue({
      safeTxHash: record.safeTxHash,
      nonce: 7,
      to: EOA,
      value: "0",
      data: "0xabcdef",
      operation: 0,
      isExecuted: false,
      isSuccessful: null,
      transactionHash: null,
      confirmations: [
        { owner: OWNER, signature: "0x5170" as Hex, signatureType: "EOA" },
        { owner: CO_SIGNER, signature: `0x${"22".repeat(65)}` as Hex, signatureType: "EOA" },
      ],
      confirmationsRequired: 2,
    });

    const step = makeStep(2);
    const state = makeState(step, record);
    const hooks = makeHooks(state);
    const sendCalls = prepareStepSendCalls(walletClient, step, state, hooks);

    const [hash] = await sendCalls("swap", 10, SAFE, CALLS, "atomic-steps", undefined);

    expect(hash).toBe("0xexechash");
    // No re-sign, no re-propose: the stored proposal carried our signature.
    expect(signSafeTx).not.toHaveBeenCalled();
    expect(proposeSafeTx).not.toHaveBeenCalled();
  });
});

describe("stale-proposal refresh", () => {
  test("1/1: an estimate-revert rebuilds fresh calls and executes the replacement immediately", async () => {
    eoaSend
      .mockRejectedValueOnce(new SendCallsError("Transaction would revert: GS013"))
      .mockResolvedValueOnce(["0xfreshhash", [[]]]);
    const rebuildCalls = vi.fn().mockResolvedValue([{ to: EOA, data: "0xfresh" as Hex, value: 0n }]);

    const step = makeStep(1);
    const state = makeState(step);
    const hooks = { ...makeHooks(state), rebuildCalls };
    const sendCalls = prepareStepSendCalls(walletClient, step, state, hooks);

    const [hash] = await sendCalls("swap", 10, SAFE, CALLS, "atomic-steps", undefined);

    expect(hash).toBe("0xfreshhash");
    expect(rebuildCalls).toHaveBeenCalledTimes(1);
    expect(eoaSend).toHaveBeenCalledTimes(2);
  });

  test("N-of-M: an estimate-revert proposes freshly-quoted calldata at the same nonce and pauses", async () => {
    vi.mocked(readSafeInfo).mockResolvedValue({
      address: SAFE,
      owners: [OWNER, CO_SIGNER],
      threshold: 2,
      nonce: 7,
      version: "1.4.1",
    });
    const record: SafeProposalRecord = {
      chainId: 10,
      safeAddress: SAFE,
      stepIds: ["step-1"],
      safeTxHash: `0x${"aa".repeat(32)}` as Hex,
      safeNonce: 7,
      tx: { to: EOA, value: "0", data: "0xstale", operation: 0 },
      threshold: 2,
      confirmations: [
        { owner: OWNER, signature: "0x5170" as Hex },
        { owner: CO_SIGNER, signature: `0x${"22".repeat(65)}` as Hex },
      ],
      executor: OWNER,
      proposedAt: 0,
      status: "proposed",
    };
    vi.mocked(getSafeTx).mockResolvedValue(null);
    eoaSend.mockRejectedValueOnce(new SendCallsError("Transaction would revert: GS013"));
    const rebuildCalls = vi.fn().mockResolvedValue([{ to: EOA, data: "0xfresh" as Hex, value: 0n }]);

    const step = makeStep(2);
    const state = makeState(step, record);
    const hooks = { ...makeHooks(state), rebuildCalls };
    const sendCalls = prepareStepSendCalls(walletClient, step, state, hooks);

    await expect(sendCalls("swap", 10, SAFE, CALLS, "atomic-steps", undefined)).rejects.toThrow(
      /SafeTxSupersededError.*replaced with freshly-quoted calldata/s,
    );
    // The replacement was signed and proposed at the SAME Safe nonce.
    expect(proposeSafeTx).toHaveBeenCalledTimes(1);
    expect(vi.mocked(proposeSafeTx).mock.calls[0][2]).toMatchObject({ nonce: 7 });
    expect(hooks.persisted.at(-1)).toMatchObject({ status: "proposed", safeNonce: 7 });
  });
});
