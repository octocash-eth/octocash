import type { Account, Address, Chain, Hex, HttpTransport, WalletClient } from "viem";
import type { WaitForTransactionReceiptReturnType } from "viem/actions";
import { beforeEach, describe, expect, type Mock, test, vi } from "vitest";
import { prepareSendCalls, switchChain } from "./send-calls";

// Mock the estimateGas and getTransactionCount functions
vi.mock("viem/actions", async () => {
  const actual = await vi.importActual("viem/actions");
  return {
    ...actual,
    estimateGas: vi.fn(),
    getTransactionCount: vi.fn().mockResolvedValue(0),
  };
});

// Mock public-client for fee estimation
vi.mock("./public-client", () => ({
  getPublicClient: vi.fn().mockReturnValue({
    estimateFeesPerGas: vi.fn().mockResolvedValue({
      maxFeePerGas: 20000000000n,
      maxPriorityFeePerGas: 1000000000n,
    }),
  }),
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
  });
});
