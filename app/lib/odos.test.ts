import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { buildOdosCalls } from "./odos";

describe("odos", () => {
  describe("buildOdosCalls", () => {
    beforeEach(() => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          if (url.includes("/sor/quote")) {
            return {
              ok: true,
              status: 200,
              json: async () => ({ pathId: "test-path-id" }),
              text: async () => "",
            } as unknown as Response;
          }
          if (url.includes("/sor/assemble")) {
            return {
              ok: true,
              status: 200,
              json: async () => ({
                transaction: {
                  to: "0x0000000000000000000000000000000000000001",
                  data: "0x1",
                  value: "0x2",
                },
              }),
              text: async () => "",
            } as unknown as Response;
          }
          return {
            ok: false,
            status: 404,
            json: async () => ({}),
            text: async () => "Not Found",
          } as unknown as Response;
        }),
      );
    });

    afterEach(() => {
      vi.unstubAllGlobals();
      vi.resetAllMocks();
    });

    test("returns the correct approve calls", async () => {
      const calls = await buildOdosCalls(
        [
          {
            token: "0x0000000000000000000000000000000000000001",
            amount: 1n,
            chainId: 1,
            walletAddress: "0x0000000000000000000000000000000000000002",
          },
          {
            token: "0x0000000000000000000000000000000000000003",
            amount: 1n,
            chainId: 1,
            walletAddress: "0x0000000000000000000000000000000000000004",
          },
        ],
        {
          token: "0x0000000000000000000000000000000000000003",
          amount: 1n,
          chainId: 1,
          walletAddress: "0x0000000000000000000000000000000000000004",
        },
      );
      expect(calls).toEqual([
        // Approve 0x0000000000000000000000000000000000000001
        {
          data: "0x095ea7b300000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000001",
          to: "0x0000000000000000000000000000000000000001",
        },
        // Approve 0x0000000000000000000000000000000000000003
        {
          data: "0x095ea7b300000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000001",
          to: "0x0000000000000000000000000000000000000003",
        },
        // Swap
        { to: "0x0000000000000000000000000000000000000001", data: "0x1", value: 2n },
      ]);
    });
  });
});
