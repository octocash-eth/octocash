import type { Account, Chain, HttpTransport, WalletClient } from "viem";
import { describe, expect, test, vi } from "vitest";
import { prepareSendCalls, switchChain } from "./send-calls";

describe("sendCalls", () => {
  describe("switchChain", () => {
    test("calls switchChain successfully when available", async () => {
      const client = {
        switchChain: vi.fn().mockResolvedValue(undefined),
        addChain: vi.fn().mockResolvedValue(undefined),
      } as unknown as WalletClient<HttpTransport, Chain, Account>;

      await switchChain(client, 1);

      expect(client.switchChain).toHaveBeenCalledWith({ id: 1 });
      expect(client.addChain).not.toHaveBeenCalled();
    });

    test("falls back to addChain when switchChain fails", async () => {
      const client = {
        switchChain: vi.fn().mockRejectedValue(new Error("not added")),
        addChain: vi.fn().mockResolvedValue(undefined),
      } as unknown as WalletClient<HttpTransport, Chain, Account>;

      await switchChain(client, 1);

      expect(client.switchChain).toHaveBeenCalledWith({ id: 1 });
      expect(client.addChain).toHaveBeenCalledTimes(1);
    });
  });

  describe("prepareSendCalls", () => {
    test("skips when no calls are provided", async () => {
      const client = {
        switchChain: vi.fn().mockResolvedValue(undefined),
        addChain: vi.fn().mockResolvedValue(undefined),
        sendCalls: vi.fn(),
        waitForCallsStatus: vi.fn(),
      } as unknown as WalletClient<HttpTransport, Chain, Account>;

      const [tx, logs] = await prepareSendCalls(client)("test", 1, "0x0000000000000000000000000000000000000000", []);

      expect(tx).toBe("");
      expect(logs).toEqual([]);
      expect(client.switchChain).not.toHaveBeenCalled();
      expect(client.sendCalls).not.toHaveBeenCalled();
      expect(client.waitForCallsStatus).not.toHaveBeenCalled();
    });
    test("switches chain and sends calls", async () => {
      const client = {
        switchChain: vi.fn().mockResolvedValue(undefined),
        addChain: vi.fn().mockResolvedValue(undefined),
        sendCalls: vi.fn().mockResolvedValue({ id: "test-id" }),
        waitForCallsStatus: vi.fn().mockResolvedValue({
          status: "success",
          receipts: [
            {
              transactionHash: "0xdeadbeef",
              status: "success",
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
            },
          ],
        }),
      } as unknown as WalletClient<HttpTransport, Chain, Account>;

      const [tx, logs] = await prepareSendCalls(client)("test", 1, "0x0000000000000000000000000000000000000000", [
        { to: "0x0000000000000000000000000000000000000000", data: "0x" },
      ]);

      expect(client.switchChain).toHaveBeenCalledWith({ id: 1 });
      expect(client.addChain).not.toHaveBeenCalled();
      expect(client.sendCalls).toHaveBeenCalledWith(
        expect.objectContaining({
          account: "0x0000000000000000000000000000000000000000",
          forceAtomic: true,
        }),
      );
      expect(client.waitForCallsStatus).toHaveBeenCalledWith({ id: "test-id" });
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
      const client = {
        switchChain: vi.fn().mockResolvedValue(undefined),
        addChain: vi.fn().mockResolvedValue(undefined),
        sendCalls: vi.fn().mockResolvedValue({ id: "test-id" }),
        waitForCallsStatus: vi.fn().mockResolvedValue({
          status: "success",
          receipts: [
            {
              transactionHash: "0xdeadbeef",
              status: "success",
            },
          ],
        }),
      } as unknown as WalletClient<HttpTransport, Chain, Account>;

      const [tx, logs] = await prepareSendCalls(client)("test", 1, "0x0000000000000000000000000000000000000000", [
        { to: "0x0000000000000000000000000000000000000000", data: "0x" },
      ]);

      expect(tx).toBe("0xdeadbeef");
      expect(logs).toEqual([[]]);
    });

    test("allows to send calls in non-atomic-batch mode", async () => {
      const client = {
        switchChain: vi.fn().mockResolvedValue(undefined),
        addChain: vi.fn().mockResolvedValue(undefined),
        sendCalls: vi.fn().mockResolvedValue({ id: "test-id" }),
        waitForCallsStatus: vi.fn().mockResolvedValue({
          status: "success",
          receipts: [
            { transactionHash: "0xdeadbeef", status: "success", logs: [] },
            { transactionHash: "0xdeadbeef", status: "reverted", logs: [] },
          ],
        }),
      } as unknown as WalletClient<HttpTransport, Chain, Account>;
      await expect(
        prepareSendCalls(client)(
          "test",
          1,
          "0x0000000000000000000000000000000000000000",
          [{ to: "0x0000000000000000000000000000000000000000", data: "0x" }],
          "non-atomic-batch",
        ),
      ).resolves.toEqual(["0xdeadbeef", [[], []]]);
      expect(client.switchChain).toHaveBeenCalledWith({ id: 1 });
      expect(client.addChain).not.toHaveBeenCalled();
      expect(client.sendCalls).toHaveBeenCalledWith(
        expect.objectContaining({
          account: "0x0000000000000000000000000000000000000000",
          forceAtomic: false,
        }),
      );
      expect(client.waitForCallsStatus).toHaveBeenCalledWith({ id: "test-id" });
    });

    test("throws error when atomic transaction reverted", async () => {
      const client = {
        switchChain: vi.fn().mockResolvedValue(undefined),
        addChain: vi.fn().mockResolvedValue(undefined),
        sendCalls: vi.fn().mockResolvedValue({ id: "test-id" }),
        waitForCallsStatus: vi.fn().mockResolvedValue({
          receipts: [{ transactionHash: "0xdeadbeef", status: "reverted", logs: [] }],
        }),
      } as unknown as WalletClient<HttpTransport, Chain, Account>;

      await expect(
        prepareSendCalls(client)("test", 1, "0x0000000000000000000000000000000000000000", [
          { to: "0x0000000000000000000000000000000000000000", data: "0x" },
        ]),
      ).rejects.toThrow("test transaction reverted");
    });

    test("atomic-steps mode executes calls one by one and stops on failure", async () => {
      const client = {
        switchChain: vi.fn().mockResolvedValue(undefined),
        addChain: vi.fn().mockResolvedValue(undefined),
        sendTransaction: vi.fn().mockResolvedValueOnce("0xfirst").mockResolvedValueOnce("0xsecond"),
      } as unknown as WalletClient<HttpTransport, Chain, Account>;

      const mockWaitForReceipt = vi
        .fn()
        .mockResolvedValueOnce({
          status: "success",
          logs: [{ address: "0x1111111111111111111111111111111111111111", data: "0x", topics: ["0xa"] }],
        })
        .mockResolvedValueOnce({
          status: "success",
          logs: [{ address: "0x2222222222222222222222222222222222222222", data: "0x", topics: ["0xb"] }],
        });

      const [tx, logs] = await prepareSendCalls(client, mockWaitForReceipt)(
        "test",
        1,
        "0x0000000000000000000000000000000000000000",
        [
          { to: "0x1111111111111111111111111111111111111111", data: "0x" },
          { to: "0x2222222222222222222222222222222222222222", data: "0x" },
        ],
        "atomic-steps",
      );

      expect(client.switchChain).toHaveBeenCalledWith({ id: 1 });
      expect(client.sendTransaction).toHaveBeenCalledTimes(2);
      expect(mockWaitForReceipt).toHaveBeenCalledTimes(2);
      expect(tx).toBe("0xsecond"); // Returns last transaction hash
      expect(logs).toEqual([
        [{ address: "0x1111111111111111111111111111111111111111", data: "0x", topics: ["0xa"] }],
        [{ address: "0x2222222222222222222222222222222222222222", data: "0x", topics: ["0xb"] }],
      ]);
    });

    test("non-atomic-steps mode continues on partial failure", async () => {
      const client = {
        switchChain: vi.fn().mockResolvedValue(undefined),
        addChain: vi.fn().mockResolvedValue(undefined),
        sendTransaction: vi
          .fn()
          .mockResolvedValueOnce("0xfirst")
          .mockRejectedValueOnce(new Error("Transaction failed"))
          .mockResolvedValueOnce("0xthird"),
      } as unknown as WalletClient<HttpTransport, Chain, Account>;

      const mockWaitForReceipt = vi
        .fn()
        .mockResolvedValueOnce({
          status: "success",
          logs: [{ address: "0x1111111111111111111111111111111111111111", data: "0x", topics: ["0xa"] }],
        })
        .mockResolvedValueOnce({
          status: "success",
          logs: [{ address: "0x3333333333333333333333333333333333333333", data: "0x", topics: ["0xc"] }],
        });

      const [tx, logs] = await prepareSendCalls(client, mockWaitForReceipt)(
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

      expect(client.sendTransaction).toHaveBeenCalledTimes(3);
      expect(mockWaitForReceipt).toHaveBeenCalledTimes(2); // Only called for successful transactions
      expect(tx).toBe("0xthird"); // Returns last successful transaction hash
      expect(logs).toEqual([
        [{ address: "0x1111111111111111111111111111111111111111", data: "0x", topics: ["0xa"] }],
        [], // Failed call has empty logs
        [{ address: "0x3333333333333333333333333333333333333333", data: "0x", topics: ["0xc"] }],
      ]);
    });

    test("non-atomic-steps mode returns empty hash when all calls fail before sending", async () => {
      const client = {
        switchChain: vi.fn().mockResolvedValue(undefined),
        addChain: vi.fn().mockResolvedValue(undefined),
        sendTransaction: vi.fn().mockRejectedValue(new Error("All transactions failed")),
      } as unknown as WalletClient<HttpTransport, Chain, Account>;

      const mockWaitForReceipt = vi.fn();

      const [tx, logs] = await prepareSendCalls(client, mockWaitForReceipt)(
        "test",
        1,
        "0x0000000000000000000000000000000000000000",
        [
          { to: "0x1111111111111111111111111111111111111111", data: "0x" },
          { to: "0x2222222222222222222222222222222222222222", data: "0x" },
        ],
        "non-atomic-steps",
      );

      expect(client.sendTransaction).toHaveBeenCalledTimes(2);
      expect(mockWaitForReceipt).not.toHaveBeenCalled();
      expect(tx).toBe(""); // Returns empty string when all fail
      expect(logs).toEqual([[], []]); // Empty logs for all failed calls
    });

    test("non-atomic-steps mode returns last tx hash even when it reverts", async () => {
      const client = {
        switchChain: vi.fn().mockResolvedValue(undefined),
        addChain: vi.fn().mockResolvedValue(undefined),
        sendTransaction: vi.fn().mockResolvedValueOnce("0xfirst").mockResolvedValueOnce("0xsecond"),
      } as unknown as WalletClient<HttpTransport, Chain, Account>;

      const mockWaitForReceipt = vi
        .fn()
        .mockResolvedValueOnce({
          status: "success",
          logs: [{ address: "0x1111111111111111111111111111111111111111", data: "0x", topics: ["0xa"] }],
        })
        .mockResolvedValueOnce({
          status: "reverted",
          logs: [],
        });

      const [tx, logs] = await prepareSendCalls(client, mockWaitForReceipt)(
        "test",
        1,
        "0x0000000000000000000000000000000000000000",
        [
          { to: "0x1111111111111111111111111111111111111111", data: "0x" },
          { to: "0x2222222222222222222222222222222222222222", data: "0x" },
        ],
        "non-atomic-steps",
      );

      expect(client.sendTransaction).toHaveBeenCalledTimes(2);
      expect(mockWaitForReceipt).toHaveBeenCalledTimes(2);
      expect(tx).toBe("0xsecond"); // Returns last attempted tx even though it reverted
      expect(logs).toEqual([
        [{ address: "0x1111111111111111111111111111111111111111", data: "0x", topics: ["0xa"] }],
        [], // Reverted transaction has empty logs
      ]);
    });

    test("non-atomic-steps mode returns last tx hash when all transactions revert", async () => {
      const client = {
        switchChain: vi.fn().mockResolvedValue(undefined),
        addChain: vi.fn().mockResolvedValue(undefined),
        sendTransaction: vi.fn().mockResolvedValueOnce("0xfirst").mockResolvedValueOnce("0xsecond"),
      } as unknown as WalletClient<HttpTransport, Chain, Account>;

      const mockWaitForReceipt = vi
        .fn()
        .mockResolvedValueOnce({
          status: "reverted",
          logs: [],
        })
        .mockResolvedValueOnce({
          status: "reverted",
          logs: [],
        });

      const [tx, logs] = await prepareSendCalls(client, mockWaitForReceipt)(
        "test",
        1,
        "0x0000000000000000000000000000000000000000",
        [
          { to: "0x1111111111111111111111111111111111111111", data: "0x" },
          { to: "0x2222222222222222222222222222222222222222", data: "0x" },
        ],
        "non-atomic-steps",
      );

      expect(client.sendTransaction).toHaveBeenCalledTimes(2);
      expect(mockWaitForReceipt).toHaveBeenCalledTimes(2);
      expect(tx).toBe("0xsecond"); // Returns last tx hash even though ALL reverted
      expect(logs).toEqual([
        [], // First transaction reverted
        [], // Second transaction reverted
      ]);
    });

    test("atomic-steps mode throws on first failure", async () => {
      const client = {
        switchChain: vi.fn().mockResolvedValue(undefined),
        addChain: vi.fn().mockResolvedValue(undefined),
        sendTransaction: vi
          .fn()
          .mockResolvedValueOnce("0xfirst")
          .mockRejectedValueOnce(new Error("Second transaction failed")),
      } as unknown as WalletClient<HttpTransport, Chain, Account>;

      const mockWaitForReceipt = vi.fn().mockResolvedValueOnce({
        status: "success",
        logs: [{ address: "0x1111111111111111111111111111111111111111", data: "0x", topics: ["0xa"] }],
      });

      await expect(
        prepareSendCalls(client, mockWaitForReceipt)(
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

      // Should stop after second call fails
      expect(client.sendTransaction).toHaveBeenCalledTimes(2);
      expect(mockWaitForReceipt).toHaveBeenCalledTimes(1);
    });

    test("atomic-steps mode throws when receipt shows reverted status", async () => {
      const client = {
        switchChain: vi.fn().mockResolvedValue(undefined),
        addChain: vi.fn().mockResolvedValue(undefined),
        sendTransaction: vi.fn().mockResolvedValueOnce("0xfirst").mockResolvedValueOnce("0xsecond"),
      } as unknown as WalletClient<HttpTransport, Chain, Account>;

      const mockWaitForReceipt = vi
        .fn()
        .mockResolvedValueOnce({
          status: "success",
          logs: [{ address: "0x1111111111111111111111111111111111111111", data: "0x", topics: ["0xa"] }],
        })
        .mockResolvedValueOnce({
          status: "reverted",
          logs: [],
        });

      await expect(
        prepareSendCalls(client, mockWaitForReceipt)(
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

      expect(client.sendTransaction).toHaveBeenCalledTimes(2);
      expect(mockWaitForReceipt).toHaveBeenCalledTimes(2);
    });

    test("atomic-steps mode throws when all transactions fail before sending", async () => {
      const client = {
        switchChain: vi.fn().mockResolvedValue(undefined),
        addChain: vi.fn().mockResolvedValue(undefined),
        sendTransaction: vi.fn().mockRejectedValue(new Error("Network error")),
      } as unknown as WalletClient<HttpTransport, Chain, Account>;

      const mockWaitForReceipt = vi.fn();

      await expect(
        prepareSendCalls(client, mockWaitForReceipt)(
          "test",
          1,
          "0x0000000000000000000000000000000000000000",
          [
            { to: "0x1111111111111111111111111111111111111111", data: "0x" },
            { to: "0x2222222222222222222222222222222222222222", data: "0x" },
          ],
          "atomic-steps",
        ),
      ).rejects.toThrow("Network error");

      // Should fail on first transaction and stop
      expect(client.sendTransaction).toHaveBeenCalledTimes(1);
      expect(mockWaitForReceipt).not.toHaveBeenCalled();
    });

    test("atomic-steps mode passes value parameter in sendTransaction", async () => {
      const client = {
        switchChain: vi.fn().mockResolvedValue(undefined),
        addChain: vi.fn().mockResolvedValue(undefined),
        sendTransaction: vi.fn().mockResolvedValueOnce("0xfirst"),
      } as unknown as WalletClient<HttpTransport, Chain, Account>;

      const mockWaitForReceipt = vi.fn().mockResolvedValueOnce({
        status: "success",
        logs: [],
      });

      await prepareSendCalls(client, mockWaitForReceipt)(
        "test",
        1,
        "0x0000000000000000000000000000000000000000",
        [{ to: "0x1111111111111111111111111111111111111111", data: "0x", value: BigInt(1000) }],
        "atomic-steps",
      );

      expect(client.sendTransaction).toHaveBeenCalledWith(
        expect.objectContaining({
          value: BigInt(1000),
        }),
      );
    });

    test("non-atomic-batch mode throws when no receipts returned", async () => {
      const client = {
        switchChain: vi.fn().mockResolvedValue(undefined),
        addChain: vi.fn().mockResolvedValue(undefined),
        sendCalls: vi.fn().mockResolvedValue({ id: "test-id" }),
        waitForCallsStatus: vi.fn().mockResolvedValue({
          status: "failed",
          receipts: [],
        }),
      } as unknown as WalletClient<HttpTransport, Chain, Account>;

      await expect(
        prepareSendCalls(client)(
          "test",
          1,
          "0x0000000000000000000000000000000000000000",
          [{ to: "0x0000000000000000000000000000000000000000", data: "0x" }],
          "non-atomic-batch",
        ),
      ).rejects.toThrow("test transaction failed with no receipts");
    });

    test("non-atomic-batch mode throws when receipts is undefined", async () => {
      const client = {
        switchChain: vi.fn().mockResolvedValue(undefined),
        addChain: vi.fn().mockResolvedValue(undefined),
        sendCalls: vi.fn().mockResolvedValue({ id: "test-id" }),
        waitForCallsStatus: vi.fn().mockResolvedValue({
          status: "failed",
          receipts: undefined,
        }),
      } as unknown as WalletClient<HttpTransport, Chain, Account>;

      await expect(
        prepareSendCalls(client)(
          "test",
          1,
          "0x0000000000000000000000000000000000000000",
          [{ to: "0x0000000000000000000000000000000000000000", data: "0x" }],
          "non-atomic-batch",
        ),
      ).rejects.toThrow("test transaction failed with no receipts");
    });

    test("non-atomic-batch mode throws when transaction hash is missing", async () => {
      const client = {
        switchChain: vi.fn().mockResolvedValue(undefined),
        addChain: vi.fn().mockResolvedValue(undefined),
        sendCalls: vi.fn().mockResolvedValue({ id: "test-id" }),
        waitForCallsStatus: vi.fn().mockResolvedValue({
          status: "success",
          receipts: [{ status: "success", logs: [] }],
        }),
      } as unknown as WalletClient<HttpTransport, Chain, Account>;

      await expect(
        prepareSendCalls(client)(
          "test",
          1,
          "0x0000000000000000000000000000000000000000",
          [{ to: "0x0000000000000000000000000000000000000000", data: "0x" }],
          "non-atomic-batch",
        ),
      ).rejects.toThrow("test transaction failed with no receipts");
    });

    test("atomic-batch mode throws when status is not success", async () => {
      const client = {
        switchChain: vi.fn().mockResolvedValue(undefined),
        addChain: vi.fn().mockResolvedValue(undefined),
        sendCalls: vi.fn().mockResolvedValue({ id: "test-id" }),
        waitForCallsStatus: vi.fn().mockResolvedValue({
          status: "reverted",
          receipts: [{ transactionHash: "0xdeadbeef", status: "reverted", logs: [] }],
        }),
      } as unknown as WalletClient<HttpTransport, Chain, Account>;

      await expect(
        prepareSendCalls(client)("test", 1, "0x0000000000000000000000000000000000000000", [
          { to: "0x0000000000000000000000000000000000000000", data: "0x" },
        ]),
      ).rejects.toThrow("test transaction reverted");
    });

    test("atomic-batch mode throws when receipts is undefined", async () => {
      const client = {
        switchChain: vi.fn().mockResolvedValue(undefined),
        addChain: vi.fn().mockResolvedValue(undefined),
        sendCalls: vi.fn().mockResolvedValue({ id: "test-id" }),
        waitForCallsStatus: vi.fn().mockResolvedValue({
          status: "success",
          receipts: undefined,
        }),
      } as unknown as WalletClient<HttpTransport, Chain, Account>;

      await expect(
        prepareSendCalls(client)("test", 1, "0x0000000000000000000000000000000000000000", [
          { to: "0x0000000000000000000000000000000000000000", data: "0x" },
        ]),
      ).rejects.toThrow("test transaction reverted");
    });

    test("atomic-batch mode throws when transaction hash is missing", async () => {
      const client = {
        switchChain: vi.fn().mockResolvedValue(undefined),
        addChain: vi.fn().mockResolvedValue(undefined),
        sendCalls: vi.fn().mockResolvedValue({ id: "test-id" }),
        waitForCallsStatus: vi.fn().mockResolvedValue({
          status: "success",
          receipts: [{ status: "success", logs: [] }],
        }),
      } as unknown as WalletClient<HttpTransport, Chain, Account>;

      await expect(
        prepareSendCalls(client)("test", 1, "0x0000000000000000000000000000000000000000", [
          { to: "0x0000000000000000000000000000000000000000", data: "0x" },
        ]),
      ).rejects.toThrow("test transaction reverted");
    });
  });
});
