import type { Account, Address, Chain, Hex, HttpTransport, WalletClient } from "viem";
import type { WaitForTransactionReceiptReturnType } from "viem/actions";
import { beforeEach, describe, expect, type Mock, test, vi } from "vitest";
import { prepareSendCalls, SendCallsError, switchChain, TransactionNotBroadcastError } from "./send-calls";

// Mock the estimateGas and getTransactionCount functions
vi.mock("viem/actions", async () => {
  const actual = await vi.importActual("viem/actions");
  return {
    ...actual,
    estimateGas: vi.fn(),
    getTransactionCount: vi.fn().mockResolvedValue(0),
  };
});

// Mock public-client for fee estimation and mempool watchdog. The default
// `getTransaction` mock returns a non-null value so existing tests behave as
// if the tx is immediately visible in the mempool (watchdog exits early).
// Mempool-watchdog tests override `getTransaction` per case.
const mockPublicClient = {
  estimateFeesPerGas: vi.fn().mockResolvedValue({
    maxFeePerGas: 20000000000n,
    maxPriorityFeePerGas: 1000000000n,
  }),
  getTransaction: vi.fn().mockResolvedValue({ hash: "0xseen" }),
};
vi.mock("./public-client", () => ({
  getPublicClient: vi.fn(() => mockPublicClient),
  retryOnRateLimit: vi.fn((fn: () => unknown) => fn()),
}));

// Import mocked actions
import { estimateGas, getTransactionCount } from "viem/actions";

// Mock wallet client helper
const createMockWalletClient = () => {
  return {
    switchChain: vi.fn().mockResolvedValue(undefined),
    addChain: vi.fn().mockResolvedValue(undefined),
    sendTransaction: vi.fn().mockResolvedValue("0xmocktxhash"),
    sendCalls: vi.fn().mockResolvedValue({ id: "mock-call-id" }),
    waitForCallsStatus: vi.fn().mockResolvedValue({
      status: "success",
      receipts: [
        {
          transactionHash: "0xmocktxhash",
          logs: [{ address: "0xtoken", data: "0xdata", topics: ["0xtopic"] }],
        },
      ],
    }),
  } as unknown as WalletClient<HttpTransport, Chain, Account>;
};

// Mock receipt helper
const createMockReceipt = (
  status: "success" | "reverted",
  logs: unknown[] = [],
): WaitForTransactionReceiptReturnType => {
  return {
    status,
    logs,
    transactionHash: "0xmocktxhash",
    blockHash: "0x1111111111111111111111111111111111111111111111111111111111111111" as Hex,
    blockNumber: 12345n,
    from: "0x1111111111111111111111111111111111111111" as Address,
    to: "0x2222222222222222222222222222222222222222" as Address,
    gasUsed: 100000n,
    cumulativeGasUsed: 100000n,
    effectiveGasPrice: 1000000000n,
    type: "eip1559",
    contractAddress: null,
    logsBloom: "0x0" as Hex,
    transactionIndex: 0,
  } as WaitForTransactionReceiptReturnType;
};

describe("sendCalls", () => {
  describe("switchChain", () => {
    test("calls switchChain successfully when available", async () => {
      const client = createMockWalletClient();

      await switchChain(client, 1);

      expect(client.switchChain).toHaveBeenCalledWith({ id: 1 });
      expect(client.addChain).not.toHaveBeenCalled();
    });

    test("falls back to addChain when switchChain fails", async () => {
      const client = createMockWalletClient();
      vi.mocked(client.switchChain).mockRejectedValue(new Error("not added"));

      await switchChain(client, 1);

      expect(client.switchChain).toHaveBeenCalledWith({ id: 1 });
      expect(client.addChain).toHaveBeenCalledTimes(1);
    });
  });

  describe("prepareSendCalls", () => {
    let mockClient: WalletClient<HttpTransport, Chain, Account>;
    let mockWaitForReceipt: Mock;

    beforeEach(() => {
      mockClient = createMockWalletClient();
      mockWaitForReceipt = vi.fn();
      vi.mocked(estimateGas).mockReset();
      vi.mocked(estimateGas).mockResolvedValue(100000n);
      vi.mocked(getTransactionCount).mockReset();
      vi.mocked(getTransactionCount).mockResolvedValue(0);
      // Reset mempool watchdog mock to "tx visible" default.
      mockPublicClient.getTransaction.mockReset();
      mockPublicClient.getTransaction.mockResolvedValue({ hash: "0xseen" });
    });

    describe("empty calls", () => {
      test("skips when no calls are provided", async () => {
        const [tx, logs] = await prepareSendCalls(mockClient)(
          "test",
          1,
          "0x0000000000000000000000000000000000000000",
          [],
        );

        expect(tx).toBe("");
        expect(logs).toEqual([]);
        expect(mockClient.switchChain).not.toHaveBeenCalled();
        expect(mockClient.sendCalls).not.toHaveBeenCalled();
      });
    });

    describe("batch modes", () => {
      describe("atomic-batch", () => {
        test("switches chain and sends calls", async () => {
          vi.mocked(mockClient.waitForCallsStatus).mockResolvedValue({
            status: "success",
            receipts: [
              {
                transactionHash: "0xdeadbeef",
                status: "success",
                blockHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
                blockNumber: 1n,
                gasUsed: 100000n,
                logs: [
                  {
                    address: "0x0000000000000000000000000000000000000000",
                    data: "0x",
                    topics: ["0x"],
                  },
                ],
              },
              {
                transactionHash: "0xdeadbeef",
                status: "success",
                blockHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
                blockNumber: 1n,
                gasUsed: 100000n,
                logs: [],
              },
            ],
          } as unknown as Awaited<ReturnType<WalletClient["waitForCallsStatus"]>>);

          const [tx, logs] = await prepareSendCalls(mockClient)(
            "test",
            1,
            "0x0000000000000000000000000000000000000000",
            [{ to: "0x0000000000000000000000000000000000000000", data: "0x" }],
            "atomic-batch",
          );

          expect(mockClient.switchChain).toHaveBeenCalledWith({ id: 1 });
          expect(mockClient.addChain).not.toHaveBeenCalled();
          expect(mockClient.sendCalls).toHaveBeenCalledWith(
            expect.objectContaining({
              account: "0x0000000000000000000000000000000000000000",
              forceAtomic: true,
            }),
          );
          expect(mockClient.waitForCallsStatus).toHaveBeenCalledWith({ id: "mock-call-id" });
          expect(tx).toBe("0xdeadbeef");
          expect(logs).toEqual([
            [
              {
                address: "0x0000000000000000000000000000000000000000",
                data: "0x",
                topics: ["0x"],
              },
            ],
            [],
          ]);
        });

        test("returns empty logs when no logs are returned", async () => {
          vi.mocked(mockClient.waitForCallsStatus).mockResolvedValue({
            status: "success",
            receipts: [
              {
                transactionHash: "0xdeadbeef",
                status: "success",
                blockHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
                blockNumber: 1n,
                gasUsed: 100000n,
                logs: [],
              },
            ],
          } as unknown as Awaited<ReturnType<WalletClient["waitForCallsStatus"]>>);

          const [tx, logs] = await prepareSendCalls(mockClient)(
            "test",
            1,
            "0x0000000000000000000000000000000000000000",
            [{ to: "0x0000000000000000000000000000000000000000", data: "0x" }],
            "atomic-batch",
          );

          expect(tx).toBe("0xdeadbeef");
          expect(logs).toEqual([[]]);
        });

        test("throws error when atomic transaction reverted", async () => {
          vi.mocked(mockClient.waitForCallsStatus).mockResolvedValue({
            receipts: [
              {
                transactionHash: "0xdeadbeef",
                status: "reverted",
                blockHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
                blockNumber: 1n,
                gasUsed: 100000n,
                logs: [],
              },
            ],
          } as unknown as Awaited<ReturnType<WalletClient["waitForCallsStatus"]>>);

          await expect(
            prepareSendCalls(mockClient)(
              "test",
              1,
              "0x0000000000000000000000000000000000000000",
              [{ to: "0x0000000000000000000000000000000000000000", data: "0x" }],
              "atomic-batch",
            ),
          ).rejects.toThrow("test transaction reverted");
        });

        test("throws when receipts is undefined", async () => {
          vi.mocked(mockClient.waitForCallsStatus).mockResolvedValue({
            id: "test-id",
            atomic: true,
            chainId: 1,
            version: "1.0",
            statusCode: 200,
            status: "success",
            receipts: undefined,
          } as unknown as Awaited<ReturnType<WalletClient["waitForCallsStatus"]>>);

          await expect(
            prepareSendCalls(mockClient)(
              "test",
              1,
              "0x0000000000000000000000000000000000000000",
              [{ to: "0x0000000000000000000000000000000000000000", data: "0x" }],
              "atomic-batch",
            ),
          ).rejects.toThrow("test transaction reverted");
        });

        test("throws when transaction hash is missing", async () => {
          vi.mocked(mockClient.waitForCallsStatus).mockResolvedValue({
            status: "success",
            receipts: [
              {
                status: "success",
                blockHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
                blockNumber: 1n,
                gasUsed: 100000n,
                logs: [],
              } as unknown as NonNullable<Awaited<ReturnType<WalletClient["waitForCallsStatus"]>>["receipts"]>[number],
            ],
          } as unknown as Awaited<ReturnType<WalletClient["waitForCallsStatus"]>>);

          await expect(
            prepareSendCalls(mockClient)(
              "test",
              1,
              "0x0000000000000000000000000000000000000000",
              [{ to: "0x0000000000000000000000000000000000000000", data: "0x" }],
              "atomic-batch",
            ),
          ).rejects.toThrow("test transaction reverted");
        });
      });

      describe("non-atomic-batch", () => {
        test("allows partial success with mixed results", async () => {
          vi.mocked(mockClient.waitForCallsStatus).mockResolvedValue({
            status: "success",
            receipts: [
              {
                transactionHash: "0xdeadbeef",
                status: "success",
                blockHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
                blockNumber: 1n,
                gasUsed: 100000n,
                logs: [],
              },
              {
                transactionHash: "0xdeadbeef",
                status: "reverted",
                blockHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
                blockNumber: 1n,
                gasUsed: 100000n,
                logs: [],
              },
            ],
          } as unknown as Awaited<ReturnType<WalletClient["waitForCallsStatus"]>>);

          await expect(
            prepareSendCalls(mockClient)(
              "test",
              1,
              "0x0000000000000000000000000000000000000000",
              [{ to: "0x0000000000000000000000000000000000000000", data: "0x" }],
              "non-atomic-batch",
            ),
          ).resolves.toEqual(["0xdeadbeef", [[], []]]);

          expect(mockClient.sendCalls).toHaveBeenCalledWith(
            expect.objectContaining({
              forceAtomic: false,
            }),
          );
        });

        test("throws when no receipts returned", async () => {
          vi.mocked(mockClient.waitForCallsStatus).mockResolvedValue({
            status: "failure",
            receipts: [],
          } as unknown as Awaited<ReturnType<WalletClient["waitForCallsStatus"]>>);

          await expect(
            prepareSendCalls(mockClient)(
              "test",
              1,
              "0x0000000000000000000000000000000000000000",
              [{ to: "0x0000000000000000000000000000000000000000", data: "0x" }],
              "non-atomic-batch",
            ),
          ).rejects.toThrow("test transaction failed with no receipts");
        });

        test("throws when receipts is undefined", async () => {
          vi.mocked(mockClient.waitForCallsStatus).mockResolvedValue({
            status: "failure",
            receipts: undefined,
          } as unknown as Awaited<ReturnType<WalletClient["waitForCallsStatus"]>>);

          await expect(
            prepareSendCalls(mockClient)(
              "test",
              1,
              "0x0000000000000000000000000000000000000000",
              [{ to: "0x0000000000000000000000000000000000000000", data: "0x" }],
              "non-atomic-batch",
            ),
          ).rejects.toThrow("test transaction failed with no receipts");
        });

        test("throws when transaction hash is missing", async () => {
          vi.mocked(mockClient.waitForCallsStatus).mockResolvedValue({
            status: "success",
            receipts: [
              {
                status: "success",
                blockHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
                blockNumber: 1n,
                gasUsed: 100000n,
                logs: [],
              } as unknown as NonNullable<Awaited<ReturnType<WalletClient["waitForCallsStatus"]>>["receipts"]>[number],
            ],
          } as unknown as Awaited<ReturnType<WalletClient["waitForCallsStatus"]>>);

          await expect(
            prepareSendCalls(mockClient)(
              "test",
              1,
              "0x0000000000000000000000000000000000000000",
              [{ to: "0x0000000000000000000000000000000000000000", data: "0x" }],
              "non-atomic-batch",
            ),
          ).rejects.toThrow("test transaction failed with no receipts");
        });
      });
    });

    describe("step modes", () => {
      describe("atomic-steps", () => {
        test("executes calls one by one and succeeds", async () => {
          vi.mocked(mockClient.sendTransaction).mockResolvedValueOnce("0xfirst").mockResolvedValueOnce("0xsecond");

          mockWaitForReceipt
            .mockResolvedValueOnce(
              createMockReceipt("success", [
                { address: "0x1111111111111111111111111111111111111111", data: "0x", topics: ["0xa"] },
              ]),
            )
            .mockResolvedValueOnce(
              createMockReceipt("success", [
                { address: "0x2222222222222222222222222222222222222222", data: "0x", topics: ["0xb"] },
              ]),
            );

          const [tx, logs] = await prepareSendCalls(mockClient, mockWaitForReceipt)(
            "test",
            1,
            "0x0000000000000000000000000000000000000000",
            [
              { to: "0x1111111111111111111111111111111111111111", data: "0x" },
              { to: "0x2222222222222222222222222222222222222222", data: "0x" },
            ],
            "atomic-steps",
          );

          expect(mockClient.switchChain).toHaveBeenCalledWith({ id: 1 });
          expect(mockClient.sendTransaction).toHaveBeenCalledTimes(2);
          expect(mockWaitForReceipt).toHaveBeenCalledTimes(2);
          expect(tx).toBe("0xsecond");
          expect(logs).toEqual([
            [{ address: "0x1111111111111111111111111111111111111111", data: "0x", topics: ["0xa"] }],
            [{ address: "0x2222222222222222222222222222222222222222", data: "0x", topics: ["0xb"] }],
          ]);
        });

        test("throws on first failure", async () => {
          vi.mocked(mockClient.sendTransaction)
            .mockResolvedValueOnce("0xfirst")
            .mockRejectedValueOnce(new Error("Second transaction failed"));

          mockWaitForReceipt.mockResolvedValueOnce(
            createMockReceipt("success", [
              { address: "0x1111111111111111111111111111111111111111", data: "0x", topics: ["0xa"] },
            ]),
          );

          await expect(
            prepareSendCalls(mockClient, mockWaitForReceipt)(
              "test",
              1,
              "0x0000000000000000000000000000000000000000",
              [
                { to: "0x1111111111111111111111111111111111111111", data: "0x" },
                { to: "0x2222222222222222222222222222222222222222", data: "0x" },
                { to: "0x3333333333333333333333333333333333333333", data: "0x" },
              ],
              "atomic-steps",
            ),
          ).rejects.toThrow("Second transaction failed");

          expect(mockClient.sendTransaction).toHaveBeenCalledTimes(2);
          expect(mockWaitForReceipt).toHaveBeenCalledTimes(1);
        });

        test("throws when receipt shows reverted status", async () => {
          vi.mocked(mockClient.sendTransaction).mockResolvedValueOnce("0xfirst").mockResolvedValueOnce("0xsecond");

          mockWaitForReceipt
            .mockResolvedValueOnce(
              createMockReceipt("success", [
                { address: "0x1111111111111111111111111111111111111111", data: "0x", topics: ["0xa"] },
              ]),
            )
            .mockResolvedValueOnce(createMockReceipt("reverted"));

          await expect(
            prepareSendCalls(mockClient, mockWaitForReceipt)(
              "test",
              1,
              "0x0000000000000000000000000000000000000000",
              [
                { to: "0x1111111111111111111111111111111111111111", data: "0x" },
                { to: "0x2222222222222222222222222222222222222222", data: "0x" },
              ],
              "atomic-steps",
            ),
          ).rejects.toThrow("test step 1 reverted");

          expect(mockClient.sendTransaction).toHaveBeenCalledTimes(2);
          expect(mockWaitForReceipt).toHaveBeenCalledTimes(2);
        });

        test("passes value parameter in sendTransaction", async () => {
          vi.mocked(mockClient.sendTransaction).mockResolvedValueOnce("0xfirst");
          mockWaitForReceipt.mockResolvedValueOnce(createMockReceipt("success", []));

          await prepareSendCalls(mockClient, mockWaitForReceipt)(
            "test",
            1,
            "0x0000000000000000000000000000000000000000",
            [{ to: "0x1111111111111111111111111111111111111111", data: "0x", value: BigInt(1000) }],
            "atomic-steps",
          );

          expect(mockClient.sendTransaction).toHaveBeenCalledWith(
            expect.objectContaining({
              value: BigInt(1000),
            }),
          );
        });

        test("estimates gas and applies 20% buffer", async () => {
          vi.mocked(mockClient.sendTransaction).mockResolvedValueOnce("0xfirst");
          mockWaitForReceipt.mockResolvedValueOnce(createMockReceipt("success", []));
          vi.mocked(estimateGas).mockResolvedValueOnce(100000n);

          await prepareSendCalls(mockClient, mockWaitForReceipt)(
            "test",
            1,
            "0x0000000000000000000000000000000000000000",
            [{ to: "0x1111111111111111111111111111111111111111", data: "0xabcd" }],
            "atomic-steps",
          );

          expect(estimateGas).toHaveBeenCalledWith(mockClient, {
            account: "0x0000000000000000000000000000000000000000",
            to: "0x1111111111111111111111111111111111111111",
            data: "0xabcd",
            value: undefined,
          });

          expect(mockClient.sendTransaction).toHaveBeenCalledWith(
            expect.objectContaining({
              gas: 120000n, // 100000 * 1.2
            }),
          );
        });

        test("estimates gas for each call separately", async () => {
          vi.mocked(mockClient.sendTransaction).mockResolvedValueOnce("0xfirst").mockResolvedValueOnce("0xsecond");
          mockWaitForReceipt
            .mockResolvedValueOnce(createMockReceipt("success", []))
            .mockResolvedValueOnce(createMockReceipt("success", []));
          vi.mocked(estimateGas).mockResolvedValueOnce(100000n).mockResolvedValueOnce(200000n);

          await prepareSendCalls(mockClient, mockWaitForReceipt)(
            "test",
            1,
            "0x0000000000000000000000000000000000000000",
            [
              { to: "0x1111111111111111111111111111111111111111", data: "0xabcd" },
              { to: "0x2222222222222222222222222222222222222222", data: "0xdef0" },
            ],
            "atomic-steps",
          );

          expect(estimateGas).toHaveBeenCalledTimes(2);
          expect(mockClient.sendTransaction).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({
              gas: 120000n, // 100000 * 1.2
            }),
          );
          expect(mockClient.sendTransaction).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({
              gas: 240000n, // 200000 * 1.2
            }),
          );
        });

        test("continues without gas limit if estimation fails", async () => {
          vi.mocked(mockClient.sendTransaction).mockResolvedValueOnce("0xfirst");
          mockWaitForReceipt.mockResolvedValueOnce(createMockReceipt("success", []));
          vi.mocked(estimateGas).mockRejectedValueOnce(new Error("Gas estimation failed"));

          await prepareSendCalls(mockClient, mockWaitForReceipt)(
            "test",
            1,
            "0x0000000000000000000000000000000000000000",
            [{ to: "0x1111111111111111111111111111111111111111", data: "0xabcd" }],
            "atomic-steps",
          );

          expect(estimateGas).toHaveBeenCalled();
          expect(mockClient.sendTransaction).toHaveBeenCalledWith(
            expect.objectContaining({
              to: "0x1111111111111111111111111111111111111111",
              data: "0xabcd",
            }),
          );
          // gas should not be set or be undefined
          const callArgs = vi.mocked(mockClient.sendTransaction).mock.calls[0][0];
          expect(callArgs.gas).toBeUndefined();
        });

        test("passes an explicit nonce fetched from our public RPC", async () => {
          vi.mocked(getTransactionCount).mockResolvedValueOnce(7).mockResolvedValueOnce(8);
          vi.mocked(mockClient.sendTransaction).mockResolvedValueOnce("0xfirst").mockResolvedValueOnce("0xsecond");
          mockWaitForReceipt
            .mockResolvedValueOnce(createMockReceipt("success", []))
            .mockResolvedValueOnce(createMockReceipt("success", []));

          await prepareSendCalls(mockClient, mockWaitForReceipt)(
            "test",
            1,
            "0x0000000000000000000000000000000000000000",
            [
              { to: "0x1111111111111111111111111111111111111111", data: "0x" },
              { to: "0x2222222222222222222222222222222222222222", data: "0x" },
            ],
            "atomic-steps",
          );

          expect(mockClient.sendTransaction).toHaveBeenNthCalledWith(1, expect.objectContaining({ nonce: 7 }));
          expect(mockClient.sendTransaction).toHaveBeenNthCalledWith(2, expect.objectContaining({ nonce: 8 }));
        });

        test("retries once on nonce-too-low with a refreshed nonce", async () => {
          vi.mocked(getTransactionCount)
            .mockResolvedValueOnce(5) // initial nonce for the only call
            .mockResolvedValueOnce(6); // refreshed nonce after retry
          vi.mocked(mockClient.sendTransaction)
            .mockRejectedValueOnce(new Error("nonce too low"))
            .mockResolvedValueOnce("0xretried");
          mockWaitForReceipt.mockResolvedValueOnce(createMockReceipt("success", []));

          const [tx] = await prepareSendCalls(mockClient, mockWaitForReceipt)(
            "test",
            1,
            "0x0000000000000000000000000000000000000000",
            [{ to: "0x1111111111111111111111111111111111111111", data: "0x" }],
            "atomic-steps",
          );

          expect(tx).toBe("0xretried");
          expect(mockClient.sendTransaction).toHaveBeenCalledTimes(2);
          expect(mockClient.sendTransaction).toHaveBeenNthCalledWith(1, expect.objectContaining({ nonce: 5 }));
          expect(mockClient.sendTransaction).toHaveBeenNthCalledWith(2, expect.objectContaining({ nonce: 6 }));
        });

        test("rethrows nonce-too-low when refreshed nonce did not advance", async () => {
          vi.mocked(getTransactionCount).mockResolvedValue(5);
          vi.mocked(mockClient.sendTransaction).mockRejectedValueOnce(new Error("nonce too low"));

          await expect(
            prepareSendCalls(mockClient, mockWaitForReceipt)(
              "test",
              1,
              "0x0000000000000000000000000000000000000000",
              [{ to: "0x1111111111111111111111111111111111111111", data: "0x" }],
              "atomic-steps",
            ),
          ).rejects.toThrow("nonce too low");

          expect(mockClient.sendTransaction).toHaveBeenCalledTimes(1);
        });

        test("does not retry on non-nonce errors", async () => {
          vi.mocked(getTransactionCount).mockResolvedValue(5);
          vi.mocked(mockClient.sendTransaction).mockRejectedValueOnce(new Error("user rejected"));

          await expect(
            prepareSendCalls(mockClient, mockWaitForReceipt)(
              "test",
              1,
              "0x0000000000000000000000000000000000000000",
              [{ to: "0x1111111111111111111111111111111111111111", data: "0x" }],
              "atomic-steps",
            ),
          ).rejects.toThrow("user rejected");

          expect(mockClient.sendTransaction).toHaveBeenCalledTimes(1);
        });

        test("throws SendCallsError carrying the last broadcast tx hash when waitForReceipt fails", async () => {
          // Simulates the real-world scenario where the wallet successfully
          // broadcasts the swap (we get a hash back) but the RPC poll for the
          // receipt errors out. The caller MUST be able to recover the hash
          // so the verify-before-retry path can reconcile against the chain.
          vi.mocked(mockClient.sendTransaction).mockResolvedValueOnce("0xbroadcasted");
          mockWaitForReceipt.mockRejectedValueOnce(new Error("RPC poll timed out"));

          let caught: unknown;
          try {
            await prepareSendCalls(mockClient, mockWaitForReceipt)(
              "test",
              1,
              "0x0000000000000000000000000000000000000000",
              [{ to: "0x1111111111111111111111111111111111111111", data: "0x" }],
              "atomic-steps",
            );
          } catch (e) {
            caught = e;
          }

          expect(caught).toBeInstanceOf(SendCallsError);
          expect((caught as SendCallsError).transactionHash).toBe("0xbroadcasted");
          expect((caught as SendCallsError).cause).toBeInstanceOf(Error);
        });

        test("throws SendCallsError with hash when receipt status is reverted", async () => {
          vi.mocked(mockClient.sendTransaction).mockResolvedValueOnce("0xreverted");
          mockWaitForReceipt.mockResolvedValueOnce(createMockReceipt("reverted"));

          let caught: unknown;
          try {
            await prepareSendCalls(mockClient, mockWaitForReceipt)(
              "test",
              1,
              "0x0000000000000000000000000000000000000000",
              [{ to: "0x1111111111111111111111111111111111111111", data: "0x" }],
              "atomic-steps",
            );
          } catch (e) {
            caught = e;
          }

          expect(caught).toBeInstanceOf(SendCallsError);
          expect((caught as SendCallsError).transactionHash).toBe("0xreverted");
          expect((caught as SendCallsError).message).toContain("reverted");
        });

        test("SendCallsError carries the nonce + fees used for the failed broadcast", async () => {
          vi.mocked(getTransactionCount).mockResolvedValueOnce(11);
          vi.mocked(mockClient.sendTransaction).mockResolvedValueOnce("0xpending");
          mockWaitForReceipt.mockRejectedValueOnce(new Error("RPC poll timed out"));

          let caught: SendCallsError | undefined;
          try {
            await prepareSendCalls(mockClient, mockWaitForReceipt)(
              "test",
              1,
              "0x0000000000000000000000000000000000000000",
              [{ to: "0x1111111111111111111111111111111111111111", data: "0x" }],
              "atomic-steps",
            );
          } catch (e) {
            caught = e as SendCallsError;
          }

          expect(caught).toBeInstanceOf(SendCallsError);
          expect(caught?.transactionHash).toBe("0xpending");
          expect(caught?.nonce).toBe(11);
          // fast-fee mock returns maxFeePerGas=20gwei boosted ×2.5 → 50gwei
          expect(caught?.maxFeePerGas).toBe(50000000000n);
          expect(caught?.maxPriorityFeePerGas).toBe(2500000000n);
        });
      });

      describe("retryHints", () => {
        test("uses hinted nonce and applies max(hint × 2, currentFast × 2) to fees on first call", async () => {
          vi.mocked(mockClient.sendTransaction).mockResolvedValueOnce("0xreplaced");
          mockWaitForReceipt.mockResolvedValueOnce(createMockReceipt("success", []));

          await prepareSendCalls(mockClient, mockWaitForReceipt)(
            "test",
            1,
            "0x0000000000000000000000000000000000000000",
            [{ to: "0x1111111111111111111111111111111111111111", data: "0x" }],
            "atomic-steps",
            {
              nonce: 42,
              maxFeePerGas: 10000000000n, // 10 gwei, hint × 2 = 20 gwei
              maxPriorityFeePerGas: 500000000n, // 0.5 gwei, hint × 2 = 1 gwei
            },
          );

          // fast-fee mock returns 20gwei × 2.5 = 50gwei (current × 2 = 100gwei),
          // priority 1gwei × 2.5 = 2.5gwei (current × 2 = 5gwei).
          // Hint × 2 = 20gwei / 1gwei → current × 2 wins.
          expect(mockClient.sendTransaction).toHaveBeenCalledWith(
            expect.objectContaining({
              nonce: 42,
              maxFeePerGas: 100000000000n,
              maxPriorityFeePerGas: 5000000000n,
            }),
          );
          // Did not fetch the next nonce — used the hint directly.
          expect(getTransactionCount).not.toHaveBeenCalled();
        });

        test("hinted fee wins when greater than 2× current fast fee", async () => {
          vi.mocked(mockClient.sendTransaction).mockResolvedValueOnce("0xreplaced");
          mockWaitForReceipt.mockResolvedValueOnce(createMockReceipt("success", []));

          await prepareSendCalls(mockClient, mockWaitForReceipt)(
            "test",
            1,
            "0x0000000000000000000000000000000000000000",
            [{ to: "0x1111111111111111111111111111111111111111", data: "0x" }],
            "atomic-steps",
            {
              nonce: 7,
              maxFeePerGas: 80000000000n, // 80 gwei × 2 = 160 gwei (beats current × 2 = 100 gwei)
              maxPriorityFeePerGas: 4000000000n, // 4 gwei × 2 = 8 gwei (beats current × 2 = 5 gwei)
            },
          );

          expect(mockClient.sendTransaction).toHaveBeenCalledWith(
            expect.objectContaining({
              nonce: 7,
              maxFeePerGas: 160000000000n,
              maxPriorityFeePerGas: 8000000000n,
            }),
          );
        });

        test("does not auto-refresh on nonce-too-low when retryHints is active", async () => {
          vi.mocked(mockClient.sendTransaction).mockRejectedValueOnce(new Error("nonce too low"));

          await expect(
            prepareSendCalls(mockClient, mockWaitForReceipt)(
              "test",
              1,
              "0x0000000000000000000000000000000000000000",
              [{ to: "0x1111111111111111111111111111111111111111", data: "0x" }],
              "atomic-steps",
              { nonce: 3, maxFeePerGas: 10000000000n },
            ),
          ).rejects.toThrow("nonce too low");

          // With hints, we must NOT call getTransactionCount to refresh — the
          // verify-before-retry path handles the case where the original mined.
          expect(getTransactionCount).not.toHaveBeenCalled();
          expect(mockClient.sendTransaction).toHaveBeenCalledTimes(1);
        });

        test("applies hints only to first call in a multi-call step", async () => {
          vi.mocked(getTransactionCount).mockResolvedValueOnce(99); // second call uses fresh nonce
          vi.mocked(mockClient.sendTransaction).mockResolvedValueOnce("0xfirst").mockResolvedValueOnce("0xsecond");
          mockWaitForReceipt
            .mockResolvedValueOnce(createMockReceipt("success", []))
            .mockResolvedValueOnce(createMockReceipt("success", []));

          await prepareSendCalls(mockClient, mockWaitForReceipt)(
            "test",
            1,
            "0x0000000000000000000000000000000000000000",
            [
              { to: "0x1111111111111111111111111111111111111111", data: "0x" },
              { to: "0x2222222222222222222222222222222222222222", data: "0x" },
            ],
            "atomic-steps",
            { nonce: 5, maxFeePerGas: 1000000000n },
          );

          expect(mockClient.sendTransaction).toHaveBeenNthCalledWith(1, expect.objectContaining({ nonce: 5 }));
          expect(mockClient.sendTransaction).toHaveBeenNthCalledWith(2, expect.objectContaining({ nonce: 99 }));
        });

        test("applies hints in atomic-multicall mode", async () => {
          mockWaitForReceipt.mockResolvedValue(createMockReceipt("success", []));

          await prepareSendCalls(mockClient, mockWaitForReceipt)(
            "test",
            1,
            "0x3333333333333333333333333333333333333333" as Address,
            [{ to: "0x1111111111111111111111111111111111111111" as Address, data: "0xcalldata1" as Hex }],
            "atomic-multicall",
            { nonce: 17, maxFeePerGas: 10000000000n },
          );

          expect(mockClient.sendTransaction).toHaveBeenCalledWith(expect.objectContaining({ nonce: 17 }));
        });
      });

      describe("non-atomic-steps", () => {
        test("continues on partial failure", async () => {
          vi.mocked(mockClient.sendTransaction)
            .mockResolvedValueOnce("0xfirst")
            .mockRejectedValueOnce(new Error("Transaction failed"))
            .mockResolvedValueOnce("0xthird");

          mockWaitForReceipt
            .mockResolvedValueOnce(
              createMockReceipt("success", [
                { address: "0x1111111111111111111111111111111111111111", data: "0x", topics: ["0xa"] },
              ]),
            )
            .mockResolvedValueOnce(
              createMockReceipt("success", [
                { address: "0x3333333333333333333333333333333333333333", data: "0x", topics: ["0xc"] },
              ]),
            );

          const [tx, logs] = await prepareSendCalls(mockClient, mockWaitForReceipt)(
            "test",
            1,
            "0x0000000000000000000000000000000000000000",
            [
              { to: "0x1111111111111111111111111111111111111111", data: "0x" },
              { to: "0x2222222222222222222222222222222222222222", data: "0x" },
              { to: "0x3333333333333333333333333333333333333333", data: "0x" },
            ],
            "non-atomic-steps",
          );

          expect(mockClient.sendTransaction).toHaveBeenCalledTimes(3);
          expect(mockWaitForReceipt).toHaveBeenCalledTimes(2);
          expect(tx).toBe("0xthird");
          expect(logs).toEqual([
            [{ address: "0x1111111111111111111111111111111111111111", data: "0x", topics: ["0xa"] }],
            [],
            [{ address: "0x3333333333333333333333333333333333333333", data: "0x", topics: ["0xc"] }],
          ]);
        });

        test("returns empty hash when all calls fail before sending", async () => {
          vi.mocked(mockClient.sendTransaction).mockRejectedValue(new Error("All transactions failed"));

          const [tx, logs] = await prepareSendCalls(mockClient, mockWaitForReceipt)(
            "test",
            1,
            "0x0000000000000000000000000000000000000000",
            [
              { to: "0x1111111111111111111111111111111111111111", data: "0x" },
              { to: "0x2222222222222222222222222222222222222222", data: "0x" },
            ],
            "non-atomic-steps",
          );

          expect(mockClient.sendTransaction).toHaveBeenCalledTimes(2);
          expect(mockWaitForReceipt).not.toHaveBeenCalled();
          expect(tx).toBe("");
          expect(logs).toEqual([[], []]);
        });

        test("returns last tx hash even when it reverts", async () => {
          vi.mocked(mockClient.sendTransaction).mockResolvedValueOnce("0xfirst").mockResolvedValueOnce("0xsecond");

          mockWaitForReceipt
            .mockResolvedValueOnce(
              createMockReceipt("success", [
                { address: "0x1111111111111111111111111111111111111111", data: "0x", topics: ["0xa"] },
              ]),
            )
            .mockResolvedValueOnce(createMockReceipt("reverted"));

          const [tx, logs] = await prepareSendCalls(mockClient, mockWaitForReceipt)(
            "test",
            1,
            "0x0000000000000000000000000000000000000000",
            [
              { to: "0x1111111111111111111111111111111111111111", data: "0x" },
              { to: "0x2222222222222222222222222222222222222222", data: "0x" },
            ],
            "non-atomic-steps",
          );

          expect(mockClient.sendTransaction).toHaveBeenCalledTimes(2);
          expect(mockWaitForReceipt).toHaveBeenCalledTimes(2);
          expect(tx).toBe("0xsecond");
          expect(logs).toEqual([
            [{ address: "0x1111111111111111111111111111111111111111", data: "0x", topics: ["0xa"] }],
            [],
          ]);
        });

        test("returns last tx hash when all transactions revert", async () => {
          vi.mocked(mockClient.sendTransaction).mockResolvedValueOnce("0xfirst").mockResolvedValueOnce("0xsecond");

          mockWaitForReceipt
            .mockResolvedValueOnce(createMockReceipt("reverted"))
            .mockResolvedValueOnce(createMockReceipt("reverted"));

          const [tx, logs] = await prepareSendCalls(mockClient, mockWaitForReceipt)(
            "test",
            1,
            "0x0000000000000000000000000000000000000000",
            [
              { to: "0x1111111111111111111111111111111111111111", data: "0x" },
              { to: "0x2222222222222222222222222222222222222222", data: "0x" },
            ],
            "non-atomic-steps",
          );

          expect(mockClient.sendTransaction).toHaveBeenCalledTimes(2);
          expect(mockWaitForReceipt).toHaveBeenCalledTimes(2);
          expect(tx).toBe("0xsecond");
          expect(logs).toEqual([[], []]);
        });

        test("estimates gas with 20% buffer for each call", async () => {
          vi.mocked(mockClient.sendTransaction).mockResolvedValueOnce("0xfirst").mockResolvedValueOnce("0xsecond");
          mockWaitForReceipt
            .mockResolvedValueOnce(createMockReceipt("success", []))
            .mockResolvedValueOnce(createMockReceipt("success", []));
          vi.mocked(estimateGas).mockResolvedValueOnce(150000n).mockResolvedValueOnce(250000n);

          await prepareSendCalls(mockClient, mockWaitForReceipt)(
            "test",
            1,
            "0x0000000000000000000000000000000000000000",
            [
              { to: "0x1111111111111111111111111111111111111111", data: "0xabcd" },
              { to: "0x2222222222222222222222222222222222222222", data: "0xdef0" },
            ],
            "non-atomic-steps",
          );

          expect(estimateGas).toHaveBeenCalledTimes(2);
          expect(mockClient.sendTransaction).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({
              gas: 180000n, // 150000 * 1.2
            }),
          );
          expect(mockClient.sendTransaction).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({
              gas: 300000n, // 250000 * 1.2
            }),
          );
        });

        test("continues execution even when gas estimation fails", async () => {
          vi.mocked(mockClient.sendTransaction).mockResolvedValueOnce("0xfirst").mockResolvedValueOnce("0xsecond");
          mockWaitForReceipt
            .mockResolvedValueOnce(createMockReceipt("success", []))
            .mockResolvedValueOnce(createMockReceipt("success", []));
          vi.mocked(estimateGas)
            .mockRejectedValueOnce(new Error("Gas estimation failed"))
            .mockResolvedValueOnce(200000n);

          const [tx] = await prepareSendCalls(mockClient, mockWaitForReceipt)(
            "test",
            1,
            "0x0000000000000000000000000000000000000000",
            [
              { to: "0x1111111111111111111111111111111111111111", data: "0xabcd" },
              { to: "0x2222222222222222222222222222222222222222", data: "0xdef0" },
            ],
            "non-atomic-steps",
          );

          expect(estimateGas).toHaveBeenCalledTimes(2);
          expect(mockClient.sendTransaction).toHaveBeenCalledTimes(2);
          expect(tx).toBe("0xsecond");

          // First call should not have gas set
          const firstCallArgs = vi.mocked(mockClient.sendTransaction).mock.calls[0][0];
          expect(firstCallArgs.gas).toBeUndefined();

          // Second call should have gas with buffer
          const secondCallArgs = vi.mocked(mockClient.sendTransaction).mock.calls[1][0];
          expect(secondCallArgs.gas).toBe(240000n); // 200000 * 1.2
        });
      });
    });

    describe("multicall modes", () => {
      describe("atomic-multicall", () => {
        test("executes all calls successfully via Multicall3", async () => {
          const mockLogs = [
            {
              address: "0x1111111111111111111111111111111111111111" as Address,
              data: "0xdata1" as Hex,
              topics: ["0xtopic1" as Hex],
            },
            {
              address: "0x2222222222222222222222222222222222222222" as Address,
              data: "0xdata2" as Hex,
              topics: ["0xtopic2" as Hex],
            },
          ];
          mockWaitForReceipt.mockResolvedValue(createMockReceipt("success", mockLogs));

          const sendCalls = prepareSendCalls(mockClient, mockWaitForReceipt);

          const calls = [
            { to: "0x1111111111111111111111111111111111111111" as Address, data: "0xcalldata1" as Hex },
            { to: "0x2222222222222222222222222222222222222222" as Address, data: "0xcalldata2" as Hex },
          ];

          const [txHash, logs] = await sendCalls(
            "test-tx",
            1,
            "0x3333333333333333333333333333333333333333" as Address,
            calls,
            "atomic-multicall",
          );

          expect(txHash).toBe("0xmocktxhash");
          expect(logs).toHaveLength(1);
          expect(logs[0]).toEqual(mockLogs);
          expect(mockClient.sendTransaction).toHaveBeenCalledWith(
            expect.objectContaining({
              to: "0xcA11bde05977b3631167028862bE2a173976CA11",
              data: expect.any(String),
            }),
          );
        });

        test("throws when transaction reverts", async () => {
          mockWaitForReceipt.mockResolvedValue(createMockReceipt("reverted"));

          const sendCalls = prepareSendCalls(mockClient, mockWaitForReceipt);

          const calls = [{ to: "0x1111111111111111111111111111111111111111" as Address, data: "0xcalldata1" as Hex }];

          await expect(
            sendCalls("test-tx", 1, "0x3333333333333333333333333333333333333333" as Address, calls, "atomic-multicall"),
          ).rejects.toThrow("test-tx transaction reverted");
        });

        test("switches to correct chain", async () => {
          mockWaitForReceipt.mockResolvedValue(createMockReceipt("success", []));

          const sendCalls = prepareSendCalls(mockClient, mockWaitForReceipt);

          const calls = [{ to: "0x1111111111111111111111111111111111111111" as Address, data: "0xcalldata1" as Hex }];

          await sendCalls(
            "test-tx",
            10,
            "0x3333333333333333333333333333333333333333" as Address,
            calls,
            "atomic-multicall",
          );

          expect(mockClient.switchChain).toHaveBeenCalledWith({ id: 10 });
        });

        test("estimates gas with 20% buffer for multicall transaction", async () => {
          mockWaitForReceipt.mockResolvedValue(createMockReceipt("success", []));
          vi.mocked(estimateGas).mockResolvedValueOnce(300000n);

          const sendCalls = prepareSendCalls(mockClient, mockWaitForReceipt);

          const calls = [
            { to: "0x1111111111111111111111111111111111111111" as Address, data: "0xcalldata1" as Hex },
            { to: "0x2222222222222222222222222222222222222222" as Address, data: "0xcalldata2" as Hex },
          ];

          await sendCalls(
            "test-tx",
            1,
            "0x3333333333333333333333333333333333333333" as Address,
            calls,
            "atomic-multicall",
          );

          expect(estimateGas).toHaveBeenCalledWith(
            mockClient,
            expect.objectContaining({
              account: "0x3333333333333333333333333333333333333333",
              to: "0xcA11bde05977b3631167028862bE2a173976CA11",
              data: expect.any(String),
            }),
          );

          expect(mockClient.sendTransaction).toHaveBeenCalledWith(
            expect.objectContaining({
              gas: 360000n, // 300000 * 1.2
            }),
          );
        });

        test("continues without gas limit if estimation fails", async () => {
          mockWaitForReceipt.mockResolvedValue(createMockReceipt("success", []));
          vi.mocked(estimateGas).mockRejectedValueOnce(new Error("Gas estimation failed"));

          const sendCalls = prepareSendCalls(mockClient, mockWaitForReceipt);

          const calls = [{ to: "0x1111111111111111111111111111111111111111" as Address, data: "0xcalldata1" as Hex }];

          await sendCalls(
            "test-tx",
            1,
            "0x3333333333333333333333333333333333333333" as Address,
            calls,
            "atomic-multicall",
          );

          expect(estimateGas).toHaveBeenCalled();
          expect(mockClient.sendTransaction).toHaveBeenCalled();

          const callArgs = vi.mocked(mockClient.sendTransaction).mock.calls[0][0];
          expect(callArgs.gas).toBeUndefined();
        });
      });

      describe("non-atomic-multicall", () => {
        test("succeeds with mixed call results", async () => {
          const mockLogs = [
            {
              address: "0x1111111111111111111111111111111111111111" as Address,
              data: "0xdata1" as Hex,
              topics: ["0xtopic1" as Hex],
            },
          ];
          mockWaitForReceipt.mockResolvedValue(createMockReceipt("success", mockLogs));

          const sendCalls = prepareSendCalls(mockClient, mockWaitForReceipt);

          const calls = [
            { to: "0x1111111111111111111111111111111111111111" as Address, data: "0xcalldata1" as Hex },
            { to: "0x2222222222222222222222222222222222222222" as Address, data: "0xcalldata2" as Hex },
          ];

          const [txHash, logs] = await sendCalls(
            "test-tx",
            1,
            "0x3333333333333333333333333333333333333333" as Address,
            calls,
            "non-atomic-multicall",
          );

          expect(txHash).toBe("0xmocktxhash");
          expect(logs).toHaveLength(1);
          expect(logs[0]).toEqual(mockLogs);
        });

        test("succeeds even if all internal calls failed", async () => {
          mockWaitForReceipt.mockResolvedValue(createMockReceipt("success", []));

          const sendCalls = prepareSendCalls(mockClient, mockWaitForReceipt);

          const calls = [
            { to: "0x1111111111111111111111111111111111111111" as Address, data: "0xcalldata1" as Hex },
            { to: "0x2222222222222222222222222222222222222222" as Address, data: "0xcalldata2" as Hex },
          ];

          const [txHash, logs] = await sendCalls(
            "test-tx",
            1,
            "0x3333333333333333333333333333333333333333" as Address,
            calls,
            "non-atomic-multicall",
          );

          expect(txHash).toBe("0xmocktxhash");
          expect(logs).toHaveLength(1);
          expect(logs[0]).toEqual([]);
        });

        test("throws only if transaction reverts", async () => {
          mockWaitForReceipt.mockResolvedValue(createMockReceipt("reverted"));

          const sendCalls = prepareSendCalls(mockClient, mockWaitForReceipt);

          const calls = [{ to: "0x1111111111111111111111111111111111111111" as Address, data: "0xcalldata1" as Hex }];

          await expect(
            sendCalls(
              "test-tx",
              1,
              "0x3333333333333333333333333333333333333333" as Address,
              calls,
              "non-atomic-multicall",
            ),
          ).rejects.toThrow("test-tx transaction reverted");
        });

        test("estimates gas with 20% buffer for multicall transaction", async () => {
          mockWaitForReceipt.mockResolvedValue(createMockReceipt("success", []));
          vi.mocked(estimateGas).mockResolvedValueOnce(400000n);

          const sendCalls = prepareSendCalls(mockClient, mockWaitForReceipt);

          const calls = [
            { to: "0x1111111111111111111111111111111111111111" as Address, data: "0xcalldata1" as Hex },
            { to: "0x2222222222222222222222222222222222222222" as Address, data: "0xcalldata2" as Hex },
          ];

          await sendCalls(
            "test-tx",
            1,
            "0x3333333333333333333333333333333333333333" as Address,
            calls,
            "non-atomic-multicall",
          );

          expect(estimateGas).toHaveBeenCalledWith(
            mockClient,
            expect.objectContaining({
              account: "0x3333333333333333333333333333333333333333",
              to: "0xcA11bde05977b3631167028862bE2a173976CA11",
              data: expect.any(String),
            }),
          );

          expect(mockClient.sendTransaction).toHaveBeenCalledWith(
            expect.objectContaining({
              gas: 480000n, // 400000 * 1.2
            }),
          );
        });

        test("continues without gas limit if estimation fails", async () => {
          mockWaitForReceipt.mockResolvedValue(createMockReceipt("success", []));
          vi.mocked(estimateGas).mockRejectedValueOnce(new Error("Gas estimation failed"));

          const sendCalls = prepareSendCalls(mockClient, mockWaitForReceipt);

          const calls = [{ to: "0x1111111111111111111111111111111111111111" as Address, data: "0xcalldata1" as Hex }];

          await sendCalls(
            "test-tx",
            1,
            "0x3333333333333333333333333333333333333333" as Address,
            calls,
            "non-atomic-multicall",
          );

          expect(estimateGas).toHaveBeenCalled();
          expect(mockClient.sendTransaction).toHaveBeenCalled();

          const callArgs = vi.mocked(mockClient.sendTransaction).mock.calls[0][0];
          expect(callArgs.gas).toBeUndefined();
        });
      });
    });

    describe("mempool watchdog", () => {
      // These tests drive the 60s watchdog with fake timers. They use the
      // atomic-steps path because it's the simplest single-tx code path.
      beforeEach(() => {
        vi.useFakeTimers();
      });

      // Use afterEach via a beforeEach pattern — vitest resets after each test.
      // Restore real timers in a finalizer per test to avoid bleeding into
      // sibling describes.

      test("rejects with TransactionNotBroadcastError when public RPC never sees the tx", async () => {
        try {
          vi.mocked(getTransactionCount).mockResolvedValueOnce(23);
          vi.mocked(mockClient.sendTransaction).mockResolvedValueOnce("0xneverseen");
          // Public RPC always reports the tx as missing.
          mockPublicClient.getTransaction.mockReset();
          mockPublicClient.getTransaction.mockResolvedValue(null);
          // Receipt promise never resolves on its own — watchdog must win.
          mockWaitForReceipt.mockReturnValueOnce(new Promise(() => {}));

          const sendPromise = prepareSendCalls(mockClient, mockWaitForReceipt)(
            "test",
            1,
            "0x0000000000000000000000000000000000000000",
            [{ to: "0x1111111111111111111111111111111111111111", data: "0x" }],
            "atomic-steps",
          );

          // Attach an early handler so the rejection (which fires during timer
          // advancement below) isn't briefly flagged as unhandled by Node.
          const caughtP: Promise<unknown> = sendPromise.then(
            () => new Error("expected sendCalls to reject but it resolved"),
            (e) => e,
          );

          // Drain the 60s watchdog window plus a little slack for poll ticks.
          await vi.advanceTimersByTimeAsync(61_000);

          const caught = await caughtP;

          expect(caught).toBeInstanceOf(SendCallsError);
          expect(caught).toBeInstanceOf(TransactionNotBroadcastError);
          expect((caught as TransactionNotBroadcastError).transactionHash).toBe("0xneverseen");
          // Carries the nonce + fees of the failed submission so the retry
          // path can replace it.
          expect((caught as TransactionNotBroadcastError).nonce).toBe(23);
          expect((caught as TransactionNotBroadcastError).maxFeePerGas).toBe(50000000000n);
          expect((caught as TransactionNotBroadcastError).maxPriorityFeePerGas).toBe(2500000000n);
          expect(mockPublicClient.getTransaction).toHaveBeenCalledWith({ hash: "0xneverseen" });
        } finally {
          vi.useRealTimers();
        }
      });

      test("returns receipt normally when public RPC sees the tx during polling", async () => {
        try {
          vi.mocked(mockClient.sendTransaction).mockResolvedValueOnce("0xvisible");
          // First two polls miss, then the tx becomes visible.
          mockPublicClient.getTransaction.mockReset();
          mockPublicClient.getTransaction
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null)
            .mockResolvedValue({ hash: "0xvisible" });
          mockWaitForReceipt.mockResolvedValueOnce(createMockReceipt("success", []));

          const sendPromise = prepareSendCalls(mockClient, mockWaitForReceipt)(
            "test",
            1,
            "0x0000000000000000000000000000000000000000",
            [{ to: "0x1111111111111111111111111111111111111111", data: "0x" }],
            "atomic-steps",
          );

          await vi.advanceTimersByTimeAsync(15_000);
          const [tx] = await sendPromise;

          expect(tx).toBe("0xvisible");
        } finally {
          vi.useRealTimers();
        }
      });

      test("returns receipt normally when receipt resolves before watchdog deadline", async () => {
        try {
          vi.mocked(mockClient.sendTransaction).mockResolvedValueOnce("0xfast");
          // Even if mempool never reports the tx, a fast receipt wins the race.
          mockPublicClient.getTransaction.mockReset();
          mockPublicClient.getTransaction.mockResolvedValue(null);
          mockWaitForReceipt.mockResolvedValueOnce(createMockReceipt("success", []));

          const sendPromise = prepareSendCalls(mockClient, mockWaitForReceipt)(
            "test",
            1,
            "0x0000000000000000000000000000000000000000",
            [{ to: "0x1111111111111111111111111111111111111111", data: "0x" }],
            "atomic-steps",
          );

          await vi.advanceTimersByTimeAsync(1_000);
          const [tx] = await sendPromise;

          expect(tx).toBe("0xfast");
        } finally {
          vi.useRealTimers();
        }
      });
    });
  });
});
