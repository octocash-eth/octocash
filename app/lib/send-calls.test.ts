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

    test("allows to send calls in non-atomic mode if mode is non-atomic", async () => {
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
          "non-atomic",
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
  });
});
