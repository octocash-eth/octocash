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

    test("should restrict routing to fast bridges", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ tool: "across", action: {}, estimate: {}, transactionRequest: {} }),
      });

      await getLiFiQuote(
        1,
        8453,
        1000000000000000n,
        "0x1234567890123456789012345678901234567890",
        "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
      );

      const url = vi.mocked(globalThis.fetch).mock.calls[0][0] as string;
      expect(url).toContain("order=FASTEST");
      expect(url).toContain("allowBridges=across%2Crelaydepository%2CgasZipBridge");
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

    test("retries across the full bridge set when the fast set has no route (404)", async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 404, text: () => Promise.resolve("No available quotes") })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ tool: "hop", action: {}, estimate: {}, transactionRequest: {} }),
        });

      const result = await getLiFiQuote(
        1,
        130,
        1000000000000000n,
        "0x1234567890123456789012345678901234567890",
        "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
      );

      expect(result.tool).toBe("hop");
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
      const [firstUrl, secondUrl] = vi.mocked(globalThis.fetch).mock.calls.map((c) => c[0] as string);
      expect(firstUrl).toContain("allowBridges=");
      expect(secondUrl).not.toContain("allowBridges=");
      expect(secondUrl).toContain("order=FASTEST");
    });

    test("does not retry on non-404 errors", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: () => Promise.resolve("Bad request"),
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
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
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

    // Echoes back the requested fromAmount with a 1% fee so the same-token
    // (ratio ≈ 99) buffered-re-quote path runs and the probe URL is inspectable.
    const echoFetch = () =>
      vi.fn().mockImplementation((url: string) => {
        const fromAmount = new URL(url).searchParams.get("fromAmount") ?? "0";
        const toAmount = ((BigInt(fromAmount) * 99n) / 100n).toString();
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              tool: "across",
              action: { fromChainId: 1, toChainId: 130 },
              estimate: { fromAmount, toAmount, toAmountMin: toAmount },
              transactionRequest: {
                value: "0x0",
                to: "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE",
                data: "0x00",
                from: "0x1234567890123456789012345678901234567890",
                chainId: 1,
              },
            }),
        });
      });

    test("floors a dust deficit to the gas.zip minimum on the first attempt (ETH→Unichain)", async () => {
      globalThis.fetch = echoFetch();

      await getLiFiQuoteForTargetOutput(
        1,
        130, // Unichain (native ETH)
        341255453175n, // ≈ $0.0007 — the real-world dust deficit that 404'd
        "0x1234567890123456789012345678901234567890",
        "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
      );

      // Tier 1 attempt goes through gas.zip with the lower ~$0.30 floor —
      // dust gets bumped to MIN_GASZIP_TARGET_WEI (~0.0002 ETH), not the
      // standard MIN_CROSS_CHAIN_TARGET_WEI (~0.0012 ETH).
      const probeUrl = vi.mocked(globalThis.fetch).mock.calls[0][0] as string;
      expect(probeUrl).toContain("fromAmount=200000000000000");
      expect(probeUrl).toContain("allowBridges=gasZipBridge");
      expect(probeUrl).toContain("fromAmountForGas=200000000000000");
    });

    test("falls back to the standard ~$1.50 floor when gas.zip 404s on a dust deficit", async () => {
      // gas.zip-only attempts (URL contains `allowBridges=gasZipBridge`) 404;
      // everything else echoes (standard tier succeeds).
      globalThis.fetch = vi.fn().mockImplementation((url: string) => {
        if (new URL(url).searchParams.get("allowBridges") === "gasZipBridge") {
          return Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve("No available quotes") });
        }
        const fromAmount = new URL(url).searchParams.get("fromAmount") ?? "0";
        const toAmount = ((BigInt(fromAmount) * 99n) / 100n).toString();
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              tool: "across",
              action: { fromChainId: 1, toChainId: 130 },
              estimate: { fromAmount, toAmount, toAmountMin: toAmount },
              transactionRequest: {
                value: "0x0",
                to: "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE",
                data: "0x00",
                from: "0x1234567890123456789012345678901234567890",
                chainId: 1,
              },
            }),
        });
      });

      await getLiFiQuoteForTargetOutput(
        1,
        130,
        341255453175n,
        "0x1234567890123456789012345678901234567890",
        "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
      );

      // First call is the gas.zip probe (404). The first non-gas.zip call
      // is the standard-tier probe and must apply the ~$1.50 ETH floor.
      const calls = vi.mocked(globalThis.fetch).mock.calls.map((c) => c[0] as string);
      const standardProbe = calls.find((u) => new URL(u).searchParams.get("allowBridges") !== "gasZipBridge");
      expect(standardProbe).toBeDefined();
      expect(standardProbe).toContain("fromAmount=1200000000000000");
    });

    test("passes an above-minimum target through unchanged", async () => {
      globalThis.fetch = echoFetch();

      await getLiFiQuoteForTargetOutput(
        1,
        8453, // Base (native ETH)
        50_000_000_000_000_000n, // 0.05 ETH — well above the floor
        "0x1234567890123456789012345678901234567890",
        "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
      );

      const probeUrl = vi.mocked(globalThis.fetch).mock.calls[0][0] as string;
      expect(probeUrl).toContain("fromAmount=50000000000000000");
    });

    test("tries gas.zip first with the deficit untouched when it's above the gas.zip floor", async () => {
      globalThis.fetch = echoFetch();

      await getLiFiQuoteForTargetOutput(
        1,
        8453,
        500_000_000_000_000n, // 0.0005 ETH — between gas.zip floor (~$0.30) and standard floor (~$1.50)
        "0x1234567890123456789012345678901234567890",
        "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
      );

      // Probe: gas.zip with the untouched deficit (no $1.50 bump). Buffered
      // re-quote: still gas.zip-pinned. Two calls total.
      const calls = vi.mocked(globalThis.fetch).mock.calls.map((c) => c[0] as string);
      expect(calls).toHaveLength(2);
      expect(calls[0]).toContain("fromAmount=500000000000000");
      expect(calls[0]).toContain("allowBridges=gasZipBridge");
      expect(calls[0]).toContain("fromAmountForGas=500000000000000");
      expect(calls[1]).toContain("allowBridges=gasZipBridge"); // buffered re-quote stays in tier 1
    });

    test("falls back to standard tier when gas.zip returns a non-404 error (e.g. 500)", async () => {
      let callCount = 0;
      globalThis.fetch = vi.fn().mockImplementation((url: string) => {
        callCount++;
        if (new URL(url).searchParams.get("allowBridges") === "gasZipBridge") {
          return Promise.resolve({ ok: false, status: 500, text: () => Promise.resolve("Internal Server Error") });
        }
        const fromAmount = new URL(url).searchParams.get("fromAmount") ?? "0";
        const toAmount = ((BigInt(fromAmount) * 99n) / 100n).toString();
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              tool: "across",
              action: { fromChainId: 1, toChainId: 8453 },
              estimate: { fromAmount, toAmount, toAmountMin: toAmount },
              transactionRequest: {
                value: "0x0",
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
        2_000_000_000_000_000n, // above standard floor — both tiers normally would work
        "0x1234567890123456789012345678901234567890",
        "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
      );

      // Tier 1 fails on the first request (500), tier 2 takes over and succeeds.
      expect(callCount).toBeGreaterThanOrEqual(2);
      expect(result.tool).toBe("across");
      const calls = vi.mocked(globalThis.fetch).mock.calls.map((c) => c[0] as string);
      expect(calls[0]).toContain("allowBridges=gasZipBridge");
      expect(calls[calls.length - 1]).not.toContain("allowBridges=gasZipBridge");
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

    test("should invoke onProgress on every successful poll", async () => {
      let callCount = 0;
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++;
        const pending = callCount < 3;
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              status: pending ? "PENDING" : "DONE",
              substatus: pending ? "WAIT_DESTINATION_TRANSACTION" : "COMPLETED",
            }),
        });
      });

      const onProgress = vi.fn();
      await pollLiFiTransferStatus("0xabc", "across", 1, 8453, 60_000, 100, onProgress);

      expect(onProgress).toHaveBeenCalledTimes(3);
      expect(onProgress).toHaveBeenNthCalledWith(1, { status: "PENDING", substatus: "WAIT_DESTINATION_TRANSACTION" });
      expect(onProgress).toHaveBeenLastCalledWith({ status: "DONE", substatus: "COMPLETED" });
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
