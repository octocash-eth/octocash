import { beforeEach, describe, expect, test, vi } from "vitest";
import { GASZIP_DIRECT_DEPOSIT, getGasZipRefuelQuote } from "./gas-zip";

const WALLET = "0x1111111111111111111111111111111111111111" as const;
const RECIPIENT = "0x2222222222222222222222222222222222222222" as const;

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

const quoteResponse = (expected: number, calldata = "0x010203") => ({
  ok: true,
  json: async () => ({
    quotes: [{ chain: 10, expected, gas: 1, speed: 10, usd: 1 }],
    calldata,
    expires: Date.now() + 60_000,
  }),
});

beforeEach(() => {
  fetchMock.mockReset();
});

describe("getGasZipRefuelQuote", () => {
  test("same-token pair: probes, then re-quotes with a 20% buffer", async () => {
    // Probe at target 1e15 returns ~parity, final quote delivers the buffer.
    fetchMock
      .mockResolvedValueOnce(quoteResponse(1_000_000_000_000_000))
      .mockResolvedValueOnce(quoteResponse(1_180_000_000_000_000, "0xfeed"));

    const quote = await getGasZipRefuelQuote(1, 10, 1_000_000_000_000_000n, WALLET, RECIPIENT);

    expect(quote.provider).toBe("gaszip");
    expect(quote.depositWei).toBe(1_200_000_000_000_000n); // target × 1.2
    expect(quote.expectedWei).toBe(1_180_000_000_000_000n);
    expect(quote.minDeliveredWei).toBe((1_180_000_000_000_000n * 80n) / 100n);
    expect(quote.tx).toEqual({ to: GASZIP_DIRECT_DEPOSIT, data: "0xfeed", value: 1_200_000_000_000_000n });

    // Second request carries the buffered deposit in the URL path.
    expect(fetchMock.mock.calls[1][0]).toContain("/quotes/1/1200000000000000/10");
    expect(fetchMock.mock.calls[1][0]).toContain(`from=${WALLET}`);
    expect(fetchMock.mock.calls[1][0]).toContain(`to=${RECIPIENT}`);
  });

  test("cross-token pair: scales the deposit by the probed rate", async () => {
    // ETH→POL-style: probing 8e18 target delivers only 2e18 (rate 0.25) —
    // the deposit must scale to target²×1.2/probeOut = 38.4e18.
    fetchMock.mockResolvedValueOnce(quoteResponse(2e18)).mockResolvedValueOnce(quoteResponse(9e18));

    const quote = await getGasZipRefuelQuote(1, 10, 8_000_000_000_000_000_000n, WALLET, RECIPIENT);

    expect(quote.depositWei).toBe(38_400_000_000_000_000_000n);
    expect(fetchMock.mock.calls[1][0]).toContain("/quotes/1/38400000000000000000/10");
  });

  test("throws GasZipError on per-chain route errors", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ quotes: [{ chain: 10, error: "unsupported" }], calldata: "0x" }),
    });

    await expect(getGasZipRefuelQuote(1, 10, 10n ** 15n, WALLET, RECIPIENT)).rejects.toThrow(/GasZipError.*10/);
  });

  test("throws GasZipError on HTTP failure", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, text: async () => "boom" });

    await expect(getGasZipRefuelQuote(1, 10, 10n ** 15n, WALLET, RECIPIENT)).rejects.toThrow(
      /GasZipError: Quote failed \(500\)/,
    );
  });

  test("throws when the quote has no calldata", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ quotes: [{ chain: 10, expected: 1e15 }] }),
    });

    await expect(getGasZipRefuelQuote(1, 10, 10n ** 15n, WALLET, RECIPIENT)).rejects.toThrow(/no deposit calldata/);
  });
});
