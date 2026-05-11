import type { Account, Address, Chain, Hex, HttpTransport, WalletClient } from "viem";
import type { WaitForTransactionReceiptReturnType } from "viem/actions";
import { afterEach, beforeEach, describe, expect, type Mock, test, vi } from "vitest";
import {
  NonceConsumedByForeignTxError,
  type StallInfo,
  StuckTransactionError,
  sendAndWaitWithResend,
} from "./wait-with-resend";

// Mock the viem actions used by the lib. `getTransaction` is queried by the
// stall timer; `getTransactionReceipt` powers `inspectNonceOccupancy`'s
// "ours vs foreign" check.
vi.mock("viem/actions", async () => {
  const actual = await vi.importActual("viem/actions");
  return {
    ...actual,
    estimateGas: vi.fn(),
    getTransactionCount: vi.fn().mockResolvedValue(0),
    getTransaction: vi.fn(),
    getTransactionReceipt: vi.fn(),
  };
});

// Public-client mock. We stub `estimateFeesPerGas` (replacement-fee math)
// and `call` (used by the simulation that decides StallKind).
const publicClientMock = {
  estimateFeesPerGas: vi.fn().mockResolvedValue({
    maxFeePerGas: 20000000000n,
    maxPriorityFeePerGas: 1000000000n,
  }),
  call: vi.fn(),
};

vi.mock("./public-client", () => ({
  getPublicClient: vi.fn(() => publicClientMock),
}));

import { estimateGas, getTransaction, getTransactionCount, getTransactionReceipt } from "viem/actions";

const ADDR_FROM = "0x0000000000000000000000000000000000000000" as Address;
const ADDR_TO = "0x1111111111111111111111111111111111111111" as Address;

const createMockWalletClient = () =>
  ({
    switchChain: vi.fn().mockResolvedValue(undefined),
    addChain: vi.fn().mockResolvedValue(undefined),
    sendTransaction: vi.fn().mockResolvedValue("0xmocktxhash"),
  }) as unknown as WalletClient<HttpTransport, Chain, Account>;

const createMockReceipt = (
  status: "success" | "reverted",
  logs: unknown[] = [],
  transactionHash: Hex = "0xmocktxhash" as Hex,
): WaitForTransactionReceiptReturnType =>
  ({
    status,
    logs,
    transactionHash,
    blockHash: "0x1111111111111111111111111111111111111111111111111111111111111111" as Hex,
    blockNumber: 12345n,
    from: ADDR_FROM,
    to: ADDR_TO,
    gasUsed: 100000n,
    cumulativeGasUsed: 100000n,
    effectiveGasPrice: 1000000000n,
    type: "eip1559",
    contractAddress: null,
    logsBloom: "0x0" as Hex,
    transactionIndex: 0,
  }) as WaitForTransactionReceiptReturnType;

const defaultChain = { id: 1, name: "mainnet" } as unknown as Chain;

describe("wait-with-resend", () => {
  let mockClient: WalletClient<HttpTransport, Chain, Account>;
  let mockWaitForReceipt: Mock;

  beforeEach(() => {
    mockClient = createMockWalletClient();
    mockWaitForReceipt = vi.fn();
    vi.mocked(estimateGas).mockReset();
    vi.mocked(estimateGas).mockResolvedValue(100000n);
    vi.mocked(getTransactionCount).mockReset();
    vi.mocked(getTransactionCount).mockResolvedValue(0);
    vi.mocked(getTransaction).mockReset();
    vi.mocked(getTransactionReceipt).mockReset();
    publicClientMock.estimateFeesPerGas.mockReset();
    publicClientMock.estimateFeesPerGas.mockResolvedValue({
      maxFeePerGas: 20000000000n,
      maxPriorityFeePerGas: 1000000000n,
    });
    publicClientMock.call.mockReset();
    // Default: simulation passes -> kind: "resend" unless a test overrides.
    publicClientMock.call.mockResolvedValue({});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // A WaitForTransactionReceiptTimeoutError-shaped error: viem's real
  // timeout error has `name === "WaitForTransactionReceiptTimeoutError"`,
  // which `sendAndWaitWithResend` converts into StuckTransactionError.
  const makeViemTimeoutError = () => {
    const err = new Error("Timed out while waiting for receipt");
    (err as { name: string }).name = "WaitForTransactionReceiptTimeoutError";
    return err;
  };

  describe("stall detection", () => {
    test("fires onStall after stallAfterMs when tx is missing from public RPC", async () => {
      vi.useFakeTimers();
      const onStall = vi.fn();

      vi.mocked(mockClient.sendTransaction).mockResolvedValueOnce("0xstucktxhash");
      vi.mocked(getTransaction).mockRejectedValue(new Error("TransactionNotFoundError"));
      mockWaitForReceipt.mockImplementation(() => new Promise(() => {}));

      void sendAndWaitWithResend(
        mockClient,
        mockWaitForReceipt,
        { account: ADDR_FROM, to: ADDR_TO, data: "0x" as Hex, chain: defaultChain },
        { txId: "test-tx", stepIndex: 0, options: { stallAfterMs: 25_000, receiptTimeoutMs: 60_000, onStall } },
      );

      await vi.advanceTimersByTimeAsync(0);
      expect(onStall).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(25_001);

      expect(onStall).toHaveBeenCalledTimes(1);
      expect(onStall).toHaveBeenCalledWith(
        expect.objectContaining({
          txId: "test-tx",
          stepIndex: 0,
          hash: "0xstucktxhash",
          nonce: 0,
          kind: "resend",
          trigger: expect.any(Function),
        }),
      );
    });

    test("does not fire onStall when tx is visible on the public RPC", async () => {
      vi.useFakeTimers();
      const onStall = vi.fn();

      vi.mocked(mockClient.sendTransaction).mockResolvedValueOnce("0xvisibletxhash");
      vi.mocked(getTransaction).mockResolvedValue({
        hash: "0xvisibletxhash",
        nonce: 0,
        from: ADDR_FROM,
      } as never);
      mockWaitForReceipt.mockImplementation(() => new Promise(() => {}));

      void sendAndWaitWithResend(
        mockClient,
        mockWaitForReceipt,
        { account: ADDR_FROM, to: ADDR_TO, data: "0x" as Hex, chain: defaultChain },
        { txId: "test-tx", stepIndex: 0, options: { stallAfterMs: 25_000, receiptTimeoutMs: 60_000, onStall } },
      );

      await vi.advanceTimersByTimeAsync(25_001);
      expect(onStall).not.toHaveBeenCalled();
    });

    test("throws StuckTransactionError when waitForReceipt times out", async () => {
      vi.mocked(mockClient.sendTransaction).mockResolvedValueOnce("0xstucktxhash");
      mockWaitForReceipt.mockRejectedValueOnce(makeViemTimeoutError());

      await expect(
        sendAndWaitWithResend(
          mockClient,
          mockWaitForReceipt,
          { account: ADDR_FROM, to: ADDR_TO, data: "0x" as Hex, chain: defaultChain },
          { txId: "test-tx", stepIndex: 0, options: { receiptTimeoutMs: 1_000 } },
        ),
      ).rejects.toBeInstanceOf(StuckTransactionError);
    });

    test("StallInfo.nonce reflects the nonce used", async () => {
      vi.useFakeTimers();
      const onStall = vi.fn();
      vi.mocked(getTransactionCount).mockResolvedValue(42);
      vi.mocked(mockClient.sendTransaction).mockResolvedValueOnce("0xstuck");
      vi.mocked(getTransaction).mockRejectedValue(new Error("TransactionNotFoundError"));
      mockWaitForReceipt.mockImplementation(() => new Promise(() => {}));

      void sendAndWaitWithResend(
        mockClient,
        mockWaitForReceipt,
        { account: ADDR_FROM, to: ADDR_TO, data: "0x" as Hex, chain: defaultChain },
        { txId: "test-tx", stepIndex: 0, options: { stallAfterMs: 25_000, receiptTimeoutMs: 60_000, onStall } },
      );

      await vi.advanceTimersByTimeAsync(25_001);
      expect(onStall).toHaveBeenCalledWith(expect.objectContaining({ nonce: 42 }));
    });
  });

  describe("simulation -> StallKind discriminator", () => {
    test("sim passes (default) → kind: 'resend'", async () => {
      vi.useFakeTimers();
      vi.mocked(getTransactionCount).mockResolvedValue(7);
      vi.mocked(mockClient.sendTransaction).mockResolvedValueOnce("0xstuck");
      vi.mocked(getTransaction).mockRejectedValue(new Error("TransactionNotFoundError"));
      mockWaitForReceipt.mockImplementation(() => new Promise(() => {}));
      // default: publicClientMock.call resolves -> "passes"
      let captured: StallInfo | undefined;
      const onStall = vi.fn((info: StallInfo) => {
        captured = info;
      });

      void sendAndWaitWithResend(
        mockClient,
        mockWaitForReceipt,
        { account: ADDR_FROM, to: ADDR_TO, data: "0x" as Hex, chain: defaultChain },
        {
          txId: "tx",
          stepIndex: 0,
          options: { stallAfterMs: 25_000, receiptTimeoutMs: 60_000, onStall, rebuildCall: vi.fn() },
        },
      );

      await vi.advanceTimersByTimeAsync(25_001);
      expect(captured?.kind).toBe("resend");
    });

    test("sim reverts AND rebuildCall provided → kind: 'retry'; click invokes rebuildCall", async () => {
      vi.useFakeTimers();
      vi.mocked(getTransactionCount).mockResolvedValue(7);
      vi.mocked(mockClient.sendTransaction).mockResolvedValueOnce("0xstuck").mockResolvedValueOnce("0xretried");
      vi.mocked(getTransaction).mockRejectedValue(new Error("TransactionNotFoundError"));
      // Simulation reverts.
      const revertErr = new Error("execution reverted");
      (revertErr as { name: string }).name = "CallExecutionError";
      publicClientMock.call.mockRejectedValueOnce(revertErr);

      let resolveSecondWait: ((r: WaitForTransactionReceiptReturnType) => void) | undefined;
      mockWaitForReceipt
        .mockImplementationOnce(() => new Promise(() => {}))
        .mockImplementationOnce(
          () =>
            new Promise<WaitForTransactionReceiptReturnType>((resolve) => {
              resolveSecondWait = resolve;
            }),
        );

      const NEW_TO = "0x2222222222222222222222222222222222222222" as Address;
      const NEW_DATA = "0xfeedface" as Hex;
      const rebuildCall = vi.fn().mockResolvedValue({ to: NEW_TO, data: NEW_DATA, value: 0n });

      let captured: StallInfo | undefined;
      const onStall = vi.fn((info: StallInfo) => {
        captured = info;
      });

      const resultPromise = sendAndWaitWithResend(
        mockClient,
        mockWaitForReceipt,
        { account: ADDR_FROM, to: ADDR_TO, data: "0x" as Hex, chain: defaultChain },
        {
          txId: "tx",
          stepIndex: 0,
          options: { stallAfterMs: 25_000, receiptTimeoutMs: 60_000, onStall, rebuildCall },
        },
      );

      await vi.advanceTimersByTimeAsync(25_001);
      expect(captured?.kind).toBe("retry");

      captured?.trigger();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);

      expect(rebuildCall).toHaveBeenCalledWith(0);
      // Replacement broadcast with rebuilt {to, data, value} + same nonce + bumped fees.
      expect(mockClient.sendTransaction).toHaveBeenCalledTimes(2);
      const initialCall = vi.mocked(mockClient.sendTransaction).mock.calls[0][0];
      const retryCall = vi.mocked(mockClient.sendTransaction).mock.calls[1][0];
      expect(retryCall.to).toBe(NEW_TO);
      expect(retryCall.data).toBe(NEW_DATA);
      expect(retryCall.nonce).toBe(initialCall.nonce);
      expect(retryCall.maxFeePerGas as bigint).toBeGreaterThanOrEqual(
        ((initialCall.maxFeePerGas as bigint) * 1125n) / 1000n,
      );

      resolveSecondWait?.(createMockReceipt("success", [], "0xretried" as Hex));
      await vi.advanceTimersByTimeAsync(0);
      const receipt = await resultPromise;
      expect(receipt.transactionHash).toBe("0xretried");
    });

    test("sim reverts but rebuildCall is missing → falls back to kind: 'resend'", async () => {
      vi.useFakeTimers();
      vi.mocked(getTransactionCount).mockResolvedValue(7);
      vi.mocked(mockClient.sendTransaction).mockResolvedValueOnce("0xstuck");
      vi.mocked(getTransaction).mockRejectedValue(new Error("TransactionNotFoundError"));
      const revertErr = new Error("execution reverted");
      (revertErr as { name: string }).name = "CallExecutionError";
      publicClientMock.call.mockRejectedValueOnce(revertErr);
      mockWaitForReceipt.mockImplementation(() => new Promise(() => {}));

      let captured: StallInfo | undefined;
      const onStall = vi.fn((info: StallInfo) => {
        captured = info;
      });

      void sendAndWaitWithResend(
        mockClient,
        mockWaitForReceipt,
        { account: ADDR_FROM, to: ADDR_TO, data: "0x" as Hex, chain: defaultChain },
        { txId: "tx", stepIndex: 0, options: { stallAfterMs: 25_000, receiptTimeoutMs: 60_000, onStall } },
      );

      await vi.advanceTimersByTimeAsync(25_001);
      expect(captured?.kind).toBe("resend");
    });

    test("sim throws non-revert (RPC blip) → defaults to kind: 'resend'", async () => {
      vi.useFakeTimers();
      vi.mocked(getTransactionCount).mockResolvedValue(7);
      vi.mocked(mockClient.sendTransaction).mockResolvedValueOnce("0xstuck");
      vi.mocked(getTransaction).mockRejectedValue(new Error("TransactionNotFoundError"));
      // RPC failure (no "revert" anywhere in the chain).
      publicClientMock.call.mockRejectedValueOnce(new Error("network unreachable"));
      mockWaitForReceipt.mockImplementation(() => new Promise(() => {}));

      let captured: StallInfo | undefined;
      const onStall = vi.fn((info: StallInfo) => {
        captured = info;
      });

      void sendAndWaitWithResend(
        mockClient,
        mockWaitForReceipt,
        { account: ADDR_FROM, to: ADDR_TO, data: "0x" as Hex, chain: defaultChain },
        {
          txId: "tx",
          stepIndex: 0,
          options: { stallAfterMs: 25_000, receiptTimeoutMs: 60_000, onStall, rebuildCall: vi.fn() },
        },
      );

      await vi.advanceTimersByTimeAsync(25_001);
      expect(captured?.kind).toBe("resend");
    });

    test("rebuildCall returns null → no second sendTransaction; receipt-timeout still fires", async () => {
      vi.useFakeTimers();
      vi.mocked(getTransactionCount).mockResolvedValue(7);
      vi.mocked(mockClient.sendTransaction).mockResolvedValueOnce("0xstuck");
      vi.mocked(getTransaction).mockRejectedValue(new Error("TransactionNotFoundError"));
      const revertErr = new Error("execution reverted");
      (revertErr as { name: string }).name = "CallExecutionError";
      publicClientMock.call.mockRejectedValueOnce(revertErr);
      const rebuildCall = vi.fn().mockResolvedValue(null);

      // Hangs forever; we just need to confirm no second sendTransaction.
      mockWaitForReceipt.mockImplementation(() => new Promise(() => {}));

      let captured: StallInfo | undefined;
      void sendAndWaitWithResend(
        mockClient,
        mockWaitForReceipt,
        { account: ADDR_FROM, to: ADDR_TO, data: "0x" as Hex, chain: defaultChain },
        {
          txId: "tx",
          stepIndex: 0,
          options: {
            stallAfterMs: 25_000,
            receiptTimeoutMs: 60_000,
            rebuildCall,
            onStall: (info) => {
              captured = info;
            },
          },
        },
      );

      await vi.advanceTimersByTimeAsync(25_001);
      expect(captured?.kind).toBe("retry");
      captured?.trigger();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);

      expect(rebuildCall).toHaveBeenCalledTimes(1);
      // Only the initial send; the retry was a no-op.
      expect(mockClient.sendTransaction).toHaveBeenCalledTimes(1);
    });
  });

  describe("resend behavior", () => {
    test("re-broadcasts with the same nonce and >=12.5% bumped fees", async () => {
      vi.useFakeTimers();
      // Original used nonce=7. Resend's "did the nonce advance?" probe sees 7
      // (no advancement) so the resend goes through.
      vi.mocked(getTransactionCount).mockResolvedValue(7);
      vi.mocked(mockClient.sendTransaction)
        .mockResolvedValueOnce("0xstucktxhash")
        .mockResolvedValueOnce("0xresendhash");
      vi.mocked(getTransaction).mockRejectedValue(new Error("TransactionNotFoundError"));

      let resolveSecondWait: ((r: WaitForTransactionReceiptReturnType) => void) | undefined;
      mockWaitForReceipt
        .mockImplementationOnce(() => new Promise(() => {}))
        .mockImplementationOnce(
          () =>
            new Promise<WaitForTransactionReceiptReturnType>((resolve) => {
              resolveSecondWait = resolve;
            }),
        );

      let captured: StallInfo | undefined;
      const onStall = vi.fn((info: StallInfo) => {
        captured = info;
      });

      const resultPromise = sendAndWaitWithResend(
        mockClient,
        mockWaitForReceipt,
        { account: ADDR_FROM, to: ADDR_TO, data: "0x" as Hex, chain: defaultChain },
        { txId: "test-tx", stepIndex: 0, options: { stallAfterMs: 25_000, receiptTimeoutMs: 60_000, onStall } },
      );

      await vi.advanceTimersByTimeAsync(25_001);
      expect(captured?.kind).toBe("resend");

      captured?.trigger();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);

      expect(mockClient.sendTransaction).toHaveBeenCalledTimes(2);
      const initialCall = vi.mocked(mockClient.sendTransaction).mock.calls[0][0];
      const resendCall = vi.mocked(mockClient.sendTransaction).mock.calls[1][0];
      expect(resendCall.nonce).toBe(initialCall.nonce);
      expect(resendCall.to).toBe(initialCall.to);

      const initMaxFee = initialCall.maxFeePerGas as bigint;
      const initMaxPrio = initialCall.maxPriorityFeePerGas as bigint;
      const resendMaxFee = resendCall.maxFeePerGas as bigint;
      const resendMaxPrio = resendCall.maxPriorityFeePerGas as bigint;
      expect(resendMaxFee).toBeGreaterThanOrEqual((initMaxFee * 1125n) / 1000n);
      expect(resendMaxPrio).toBeGreaterThanOrEqual((initMaxPrio * 1125n) / 1000n);

      resolveSecondWait?.(createMockReceipt("success", [], "0xresendhash" as Hex));
      await vi.advanceTimersByTimeAsync(0);
      const receipt = await resultPromise;
      expect(receipt.transactionHash).toBe("0xresendhash");
    });

    test("nonce-occupancy 'ours': pre-broadcast probe sees nonce advanced AND a known hash mined → no second sendTransaction", async () => {
      vi.useFakeTimers();
      // Initial probe: 7 (our nonce).
      // Stall-time inspectNonceOccupancy: getTransactionCount returns 8 (advanced).
      // getTransactionReceipt for our initial hash returns a receipt -> "ours".
      vi.mocked(getTransactionCount).mockResolvedValueOnce(7).mockResolvedValueOnce(8);
      vi.mocked(getTransactionReceipt).mockResolvedValueOnce(createMockReceipt("success", [], "0xstucktxhash" as Hex));
      vi.mocked(mockClient.sendTransaction).mockResolvedValueOnce("0xstucktxhash");
      vi.mocked(getTransaction).mockRejectedValue(new Error("TransactionNotFoundError"));

      let resolveWait: ((r: WaitForTransactionReceiptReturnType) => void) | undefined;
      mockWaitForReceipt.mockImplementationOnce(
        () =>
          new Promise<WaitForTransactionReceiptReturnType>((resolve) => {
            resolveWait = resolve;
          }),
      );

      let captured: StallInfo | undefined;
      const onStall = vi.fn((info: StallInfo) => {
        captured = info;
      });

      const resultPromise = sendAndWaitWithResend(
        mockClient,
        mockWaitForReceipt,
        { account: ADDR_FROM, to: ADDR_TO, data: "0x" as Hex, chain: defaultChain },
        { txId: "test-tx", stepIndex: 0, options: { stallAfterMs: 25_000, receiptTimeoutMs: 60_000, onStall } },
      );

      await vi.advanceTimersByTimeAsync(25_001);
      captured?.trigger();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);

      // No second broadcast — our prior tx already mined.
      expect(mockClient.sendTransaction).toHaveBeenCalledTimes(1);

      // Outer wait still resolves (replacement detection in viem returns the
      // mined tx's receipt). We simulate that here.
      resolveWait?.(createMockReceipt("success", [], "0xstucktxhash" as Hex));
      await vi.advanceTimersByTimeAsync(0);
      const receipt = await resultPromise;
      expect(receipt.transactionHash).toBe("0xstucktxhash");
    });

    test("nonce-occupancy 'foreign': nonce advanced AND no known hash receipts → throws NonceConsumedByForeignTxError", async () => {
      vi.useFakeTimers();
      vi.mocked(getTransactionCount).mockResolvedValueOnce(7).mockResolvedValueOnce(8);
      // No receipt for our hash -> the slot is foreign.
      vi.mocked(getTransactionReceipt).mockRejectedValueOnce(new Error("TransactionReceiptNotFoundError"));
      vi.mocked(mockClient.sendTransaction).mockResolvedValueOnce("0xstucktxhash");
      vi.mocked(getTransaction).mockRejectedValue(new Error("TransactionNotFoundError"));
      mockWaitForReceipt.mockImplementation(() => new Promise(() => {}));

      let captured: StallInfo | undefined;
      const onStall = vi.fn((info: StallInfo) => {
        captured = info;
      });

      const resultPromise = sendAndWaitWithResend(
        mockClient,
        mockWaitForReceipt,
        { account: ADDR_FROM, to: ADDR_TO, data: "0x" as Hex, chain: defaultChain },
        { txId: "test-tx", stepIndex: 0, options: { stallAfterMs: 25_000, receiptTimeoutMs: 60_000, onStall } },
      );
      // Synchronously attach a catch handler so the foreign-nonce rejection
      // isn't flagged as unhandled in the microtask between trigger() and
      // the eventual await below.
      const caught = resultPromise.catch((e) => e as Error);

      await vi.advanceTimersByTimeAsync(25_001);
      captured?.trigger();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);

      // No second broadcast.
      expect(mockClient.sendTransaction).toHaveBeenCalledTimes(1);
      expect(await caught).toBeInstanceOf(NonceConsumedByForeignTxError);
    });

    test("post-receipt foreign-hash defense: receipt.transactionHash not in knownHashes → throws", async () => {
      vi.useFakeTimers();
      vi.mocked(getTransactionCount).mockResolvedValue(7);
      vi.mocked(mockClient.sendTransaction).mockResolvedValueOnce("0xinitial");
      // viem's wait resolves with a totally different hash (a foreign tx
      // grabbed (from, nonce)). This is the case the post-receipt check
      // exists to catch.
      mockWaitForReceipt.mockResolvedValueOnce(createMockReceipt("success", [], "0xforeigntx" as Hex));

      const resultPromise = sendAndWaitWithResend(
        mockClient,
        mockWaitForReceipt,
        { account: ADDR_FROM, to: ADDR_TO, data: "0x" as Hex, chain: defaultChain },
        { txId: "test-tx", stepIndex: 0, options: { receiptTimeoutMs: 60_000 } },
      );
      const caught = resultPromise.catch((e) => e as Error);

      await vi.advanceTimersByTimeAsync(0);
      expect(await caught).toBeInstanceOf(NonceConsumedByForeignTxError);
    });

    test("does not call sendTransaction on resend when nonce is undefined", async () => {
      vi.useFakeTimers();
      // Both the wallet RPC and the public-client fallback fail to fetch a
      // nonce -> estimateAndSendTransaction sends with `nonce: undefined`.
      vi.mocked(getTransactionCount).mockRejectedValue(new Error("rpc failure"));
      vi.mocked(mockClient.sendTransaction).mockResolvedValueOnce("0xstuck");
      vi.mocked(getTransaction).mockRejectedValue(new Error("TransactionNotFoundError"));
      mockWaitForReceipt.mockImplementation(() => new Promise(() => {}));

      let captured: StallInfo | undefined;
      const onStall = vi.fn((info: StallInfo) => {
        captured = info;
      });

      void sendAndWaitWithResend(
        mockClient,
        mockWaitForReceipt,
        { account: ADDR_FROM, to: ADDR_TO, data: "0x" as Hex, chain: defaultChain },
        { txId: "test-tx", stepIndex: 0, options: { stallAfterMs: 25_000, receiptTimeoutMs: 60_000, onStall } },
      );

      await vi.advanceTimersByTimeAsync(25_001);
      expect(captured?.nonce).toBeUndefined();
      // Even when the caller blindly invokes trigger, the lib must refuse to
      // broadcast a second tx (it would be a parallel send, not a replacement).
      captured?.trigger();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
      expect(mockClient.sendTransaction).toHaveBeenCalledTimes(1);
    });
  });

  describe("onHashSent", () => {
    test("fires once on the initial send with the broadcast hash", async () => {
      vi.useFakeTimers();
      vi.mocked(getTransactionCount).mockResolvedValue(3);
      vi.mocked(mockClient.sendTransaction).mockResolvedValueOnce("0xinitial");
      mockWaitForReceipt.mockImplementation(() => new Promise(() => {}));
      const onHashSent = vi.fn();

      void sendAndWaitWithResend(
        mockClient,
        mockWaitForReceipt,
        { account: ADDR_FROM, to: ADDR_TO, data: "0x" as Hex, chain: defaultChain },
        { txId: "tx-1", stepIndex: 0, options: { onHashSent } },
      );

      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);

      expect(onHashSent).toHaveBeenCalledTimes(1);
      expect(onHashSent).toHaveBeenCalledWith({
        txId: "tx-1",
        stepIndex: 0,
        hash: "0xinitial",
        nonce: 3,
        account: ADDR_FROM,
        chainId: 1,
      });
    });

    test("fires a second time after a resend with the replacement hash", async () => {
      vi.useFakeTimers();
      vi.mocked(getTransactionCount).mockResolvedValue(7);
      vi.mocked(mockClient.sendTransaction).mockResolvedValueOnce("0xinitial").mockResolvedValueOnce("0xresend");
      vi.mocked(getTransaction).mockRejectedValue(new Error("TransactionNotFoundError"));
      mockWaitForReceipt
        .mockImplementationOnce(() => new Promise(() => {}))
        .mockImplementationOnce(() => new Promise(() => {}));
      const onHashSent = vi.fn();
      let captured: StallInfo | undefined;

      void sendAndWaitWithResend(
        mockClient,
        mockWaitForReceipt,
        { account: ADDR_FROM, to: ADDR_TO, data: "0x" as Hex, chain: defaultChain },
        {
          txId: "tx-1",
          stepIndex: 0,
          options: {
            stallAfterMs: 25_000,
            receiptTimeoutMs: 60_000,
            onHashSent,
            onStall: (info) => {
              captured = info;
            },
          },
        },
      );

      await vi.advanceTimersByTimeAsync(0);
      expect(onHashSent).toHaveBeenCalledTimes(1);
      expect(onHashSent).toHaveBeenLastCalledWith(expect.objectContaining({ hash: "0xinitial" }));

      await vi.advanceTimersByTimeAsync(25_001);
      captured?.trigger();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);

      expect(onHashSent).toHaveBeenCalledTimes(2);
      expect(onHashSent).toHaveBeenLastCalledWith(expect.objectContaining({ hash: "0xresend", nonce: 7 }));
    });

    test("does NOT fire on resend when it short-circuits because our prior broadcast already mined", async () => {
      vi.useFakeTimers();
      // Initial nonce 7; resend's check returns 8 (already advanced) AND
      // getTransactionReceipt finds our initial hash → "ours" path.
      vi.mocked(getTransactionCount).mockResolvedValueOnce(7).mockResolvedValueOnce(8);
      vi.mocked(getTransactionReceipt).mockResolvedValueOnce(createMockReceipt("success", [], "0xinitial" as Hex));
      vi.mocked(mockClient.sendTransaction).mockResolvedValueOnce("0xinitial");
      vi.mocked(getTransaction).mockRejectedValue(new Error("TransactionNotFoundError"));
      let resolveWait: ((r: WaitForTransactionReceiptReturnType) => void) | undefined;
      mockWaitForReceipt.mockImplementationOnce(
        () =>
          new Promise<WaitForTransactionReceiptReturnType>((resolve) => {
            resolveWait = resolve;
          }),
      );
      const onHashSent = vi.fn();
      let captured: StallInfo | undefined;

      const resultPromise = sendAndWaitWithResend(
        mockClient,
        mockWaitForReceipt,
        { account: ADDR_FROM, to: ADDR_TO, data: "0x" as Hex, chain: defaultChain },
        {
          txId: "tx-1",
          stepIndex: 0,
          options: {
            stallAfterMs: 25_000,
            receiptTimeoutMs: 60_000,
            onHashSent,
            onStall: (info) => {
              captured = info;
            },
          },
        },
      );

      await vi.advanceTimersByTimeAsync(25_001);
      captured?.trigger();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);

      // Only the initial fire — the resend was a no-op.
      expect(onHashSent).toHaveBeenCalledTimes(1);

      resolveWait?.(createMockReceipt("success", [], "0xinitial" as Hex));
      await vi.advanceTimersByTimeAsync(0);
      await resultPromise;
    });
  });

  describe("getNextNonce fallback", () => {
    test("falls back to the public RPC when the wallet client's getTransactionCount throws", async () => {
      vi.mocked(getTransactionCount).mockRejectedValueOnce(new Error("wallet failed")).mockResolvedValueOnce(11);
      vi.mocked(mockClient.sendTransaction).mockResolvedValueOnce("0xfallback");
      mockWaitForReceipt.mockResolvedValueOnce(createMockReceipt("success", [], "0xfallback" as Hex));

      await sendAndWaitWithResend(
        mockClient,
        mockWaitForReceipt,
        { account: ADDR_FROM, to: ADDR_TO, data: "0x" as Hex, chain: defaultChain },
        { txId: "tx-1", stepIndex: 0, options: { receiptTimeoutMs: 5_000 } },
      );

      expect(mockClient.sendTransaction).toHaveBeenCalledWith(expect.objectContaining({ nonce: 11 }));
    });

    test("returns undefined when both wallet and public RPC fail", async () => {
      vi.mocked(getTransactionCount).mockRejectedValue(new Error("rpc failure"));
      vi.mocked(mockClient.sendTransaction).mockResolvedValueOnce("0xnoboth");
      mockWaitForReceipt.mockResolvedValueOnce(createMockReceipt("success", [], "0xnoboth" as Hex));

      await sendAndWaitWithResend(
        mockClient,
        mockWaitForReceipt,
        { account: ADDR_FROM, to: ADDR_TO, data: "0x" as Hex, chain: defaultChain },
        { txId: "tx-1", stepIndex: 0, options: { receiptTimeoutMs: 5_000 } },
      );

      expect(mockClient.sendTransaction).toHaveBeenCalledWith(expect.objectContaining({ nonce: undefined }));
    });
  });
});
