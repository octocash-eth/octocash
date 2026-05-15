import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { getLiFiQuote, getLiFiQuoteForTargetOutput, pollLiFiTransferStatus } from "./lifi";

describe("lifi", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  describe("getLiFiQuote", () => {
    test("should return a quote for native-to-native transfer", async () => {
      const mockResponse = {
        tool: "across",
        action: {
          fromChainId: 1,
          toChainId: 8453,
          fromToken: { symbol: "ETH", decimals: 18, priceUSD: "2000" },
          toToken: { symbol: "ETH", decimals: 18, priceUSD: "2000" },
        },
        estimate: {
          fromAmount: "1000000000000000",
          toAmount: "996500000000000",
          toAmountMin: "996500000000000",
        },
        transactionRequest: {
          value: "0x38d7ea4c68000",
          to: "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE",
          data: "0x1794958f00",
          from: "0x1234567890123456789012345678901234567890",
          chainId: 1,
        },
      };

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const result = await getLiFiQuote(
        1,
        8453,
        1000000000000000n,
        "0x1234567890123456789012345678901234567890",
        "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
      );

      expect(result.tool).toBe("across");
      expect(result.estimate.toAmount).toBe("996500000000000");
      expect(result.transactionRequest.to).toBe("0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE");
      expect(globalThis.fetch).toHaveBeenCalledWith(expect.stringContaining("/quote?fromChain=1&toChain=8453"));
    });

    test("should throw on API error", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: () => Promise.resolve("No route found"),
      });

      await expect(
        getLiFiQuote(
          1,
          8453,
          100n,
          "0x1234567890123456789012345678901234567890",
          "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
        ),
      ).rejects.toThrow("LiFiError: Quote failed (400)");
    });
  });

  describe("getLiFiQuoteForTargetOutput", () => {
    test("should return probe quote directly for same-token pair (ETH->ETH)", async () => {
      let callCount = 0;
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++;
        const fromAmount = callCount === 1 ? "1000000000000000" : "1200000000000000";
        const toAmount = callCount === 1 ? "996500000000000" : "1195800000000000";
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              tool: "across",
              action: { fromChainId: 1, toChainId: 8453 },
              estimate: { fromAmount, toAmount, toAmountMin: toAmount },
              transactionRequest: {
                value: "0x38d7ea4c68000",
                to: "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE",
                data: "0x00",
                from: "0x1234567890123456789012345678901234567890",
                chainId: 1,
              },
            }),
        });
      });

      const result = await getLiFiQuoteForTargetOutput(
        1,
        8453,
        1000000000000000n,
        "0x1234567890123456789012345678901234567890",
        "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
      );

      // Should make 2 calls: probe + buffered re-quote
      expect(callCount).toBe(2);
      expect(result.estimate.fromAmount).toBe("1200000000000000");
    });

    test("should adjust fromAmount for cross-token pair (ETH->POL)", async () => {
      let callCount = 0;
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          // Probe: sending 0.15 POL worth of ETH, receive ~375 POL (ETH is much more valuable)
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                tool: "stargate",
                action: { fromChainId: 1, toChainId: 137 },
                estimate: {
                  fromAmount: "150000000000000000",
                  toAmount: "375000000000000000000",
                  toAmountMin: "374000000000000000000",
                },
                transactionRequest: {
                  value: "0x214e8348c4f0000",
                  to: "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE",
                  data: "0x00",
                  from: "0x1234567890123456789012345678901234567890",
                  chainId: 1,
                },
              }),
          });
        }
        // Adjusted quote with proportionally calculated amount
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              tool: "stargate",
              action: { fromChainId: 1, toChainId: 137 },
              estimate: {
                fromAmount: "72000000000000",
                toAmount: "180000000000000000",
                toAmountMin: "179000000000000000",
              },
              transactionRequest: {
                value: "0x4172be8000",
                to: "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE",
                data: "0x00",
                from: "0x1234567890123456789012345678901234567890",
                chainId: 1,
              },
            }),
        });
      });

      const result = await getLiFiQuoteForTargetOutput(
        1,
        137,
        150000000000000000n, // 0.15 POL target
        "0x1234567890123456789012345678901234567890",
        "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
      );

      // Should make 2 calls: probe + adjusted
      expect(callCount).toBe(2);
      expect(result.tool).toBe("stargate");
    });
  });

  describe("pollLiFiTransferStatus", () => {
    test("should return immediately when status is DONE+COMPLETED", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            status: "DONE",
            substatus: "COMPLETED",
            receiving: { txHash: "0xdef", amount: "996500000000000", chainId: 8453 },
          }),
      });

      const result = await pollLiFiTransferStatus("0xabc", "across", 1, 8453, 10_000, 100);
      expect(result.status).toBe("DONE");
      expect(result.substatus).toBe("COMPLETED");
    });

    test("should poll until DONE", async () => {
      let callCount = 0;
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++;
        const status = callCount < 3 ? "PENDING" : "DONE";
        const substatus = callCount < 3 ? "WAIT_DESTINATION_TRANSACTION" : "COMPLETED";
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ status, substatus }),
        });
      });

      const result = await pollLiFiTransferStatus("0xabc", "across", 1, 8453, 60_000, 100);
      expect(result.status).toBe("DONE");
      expect(callCount).toBeGreaterThanOrEqual(3);
    });

    test("should throw on FAILED status", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ status: "FAILED" }),
      });

      await expect(pollLiFiTransferStatus("0xabc", "across", 1, 8453, 10_000, 100)).rejects.toThrow(
        "LiFiError: Cross-chain transfer failed",
      );
    });

    test("should throw on DONE+REFUNDED status", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ status: "DONE", substatus: "REFUNDED" }),
      });

      await expect(pollLiFiTransferStatus("0xabc", "across", 1, 8453, 10_000, 100)).rejects.toThrow(
        "LiFiError: Transfer was refunded",
      );
    });

    test("should throw on timeout", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
      });

      await expect(pollLiFiTransferStatus("0xabc", "across", 1, 8453, 500, 100)).rejects.toThrow("GAS_TOPUP_TIMEOUT");
    });

    test("should retry on non-ok responses", async () => {
      let callCount = 0;
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount < 3) {
          return Promise.resolve({ ok: false, status: 404 });
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ status: "DONE", substatus: "COMPLETED" }),
        });
      });

      const result = await pollLiFiTransferStatus("0xabc", "across", 1, 8453, 60_000, 100);
      expect(result.status).toBe("DONE");
      expect(callCount).toBeGreaterThanOrEqual(3);
    });
  });
});
