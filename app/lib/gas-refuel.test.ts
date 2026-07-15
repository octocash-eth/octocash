import type { Address } from "viem";
import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("./delora", () => ({
  getDeloraRefuelQuote: vi.fn(),
}));
vi.mock("./gas", () => ({
  getNativeBalance: vi.fn(),
}));
vi.mock("~/data/supported-chains", () => ({
  chains: {
    1: { id: 1, name: "Ethereum", nativeCurrency: { symbol: "ETH", decimals: 18 } },
    10: { id: 10, name: "OP Mainnet", nativeCurrency: { symbol: "ETH", decimals: 18 } },
    100: { id: 100, name: "Gnosis", nativeCurrency: { symbol: "XDAI", decimals: 18 } },
    137: { id: 137, name: "Polygon", nativeCurrency: { symbol: "POL", decimals: 18 } },
  },
  transports: undefined,
}));

import { getDeloraRefuelQuote } from "./delora";
import { getNativeBalance } from "./gas";
import { type GasRefuelQuote, type GasRefuelRecord, getGasRefuelQuote, waitForRefuelDelivery } from "./gas-refuel";

const WALLET = "0x1111111111111111111111111111111111111111" as Address;
const RECIPIENT = "0x2222222222222222222222222222222222222222" as Address;

const quote = (provider: "gaszip" | "delora"): GasRefuelQuote => ({
  provider,
  fromChainId: 1,
  toChainId: 10,
  depositWei: 1_200_000_000_000_000n,
  expectedWei: 1_000_000_000_000_000n,
  minDeliveredWei: 900_000_000_000_000n,
  tx: { to: RECIPIENT, data: "0x", value: 1_200_000_000_000_000n },
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getGasRefuelQuote", () => {
  test("quotes via Delora directly (Gas.zip is disabled)", async () => {
    vi.mocked(getDeloraRefuelQuote).mockResolvedValue(quote("delora"));

    const result = await getGasRefuelQuote(1, 10, 2_000_000_000_000_000n, WALLET, RECIPIENT);

    expect(result.provider).toBe("delora");
    expect(getDeloraRefuelQuote).toHaveBeenCalledWith(1, 10, 2_000_000_000_000_000n, WALLET, RECIPIENT);
  });

  test("applies the ETH floor to tiny targets", async () => {
    vi.mocked(getDeloraRefuelQuote).mockResolvedValue(quote("delora"));

    await getGasRefuelQuote(1, 10, 1n, WALLET, RECIPIENT);

    // ETH cross-chain floor = 0.0012 ETH
    expect(getDeloraRefuelQuote).toHaveBeenCalledWith(1, 10, 1_200_000_000_000_000n, WALLET, RECIPIENT);
  });

  test("applies the XDAI floor for Gnosis destinations", async () => {
    vi.mocked(getDeloraRefuelQuote).mockResolvedValue(quote("delora"));

    await getGasRefuelQuote(1, 100, 1n, WALLET, RECIPIENT);

    // XDAI cross-chain floor = 1.5 xDAI
    expect(getDeloraRefuelQuote).toHaveBeenCalledWith(1, 100, 1_500_000_000_000_000_000n, WALLET, RECIPIENT);
  });

  test("throws GasRefuelError with the Delora reason on failure", async () => {
    vi.mocked(getDeloraRefuelQuote).mockRejectedValue(new Error("ExternalAPIError: no adapters"));

    await expect(getGasRefuelQuote(1, 10, 10n ** 15n, WALLET, RECIPIENT)).rejects.toThrow(
      /GasRefuelError:.*ExternalAPIError: no adapters/,
    );
  });
});

describe("waitForRefuelDelivery", () => {
  const record: GasRefuelRecord = {
    provider: "gaszip",
    txHash: "0xdeposit",
    fromChainId: 1,
    toChainId: 10,
    toAddress: RECIPIENT,
    baselineWei: "1000",
    minDeliveredWei: "500",
  };

  test("resolves once the destination balance clears baseline + minDelivered", async () => {
    const seen: boolean[] = [];
    vi.mocked(getNativeBalance)
      .mockResolvedValueOnce(1000n) // below threshold (1500)
      .mockResolvedValueOnce(1600n); // landed

    await waitForRefuelDelivery(record, 10_000, 1, (d) => seen.push(d));

    expect(seen).toEqual([false, true]);
  });

  test("resolves immediately on retry when funds already arrived", async () => {
    vi.mocked(getNativeBalance).mockResolvedValue(10_000n);

    await expect(waitForRefuelDelivery(record, 10_000, 1)).resolves.toBeUndefined();
    expect(getNativeBalance).toHaveBeenCalledTimes(1);
  });

  test("keeps polling through transient RPC errors", async () => {
    vi.mocked(getNativeBalance).mockRejectedValueOnce(new Error("rpc down")).mockResolvedValueOnce(2000n);

    await expect(waitForRefuelDelivery(record, 10_000, 1)).resolves.toBeUndefined();
  });

  test("throws GAS_TOPUP_TIMEOUT when the deadline passes", async () => {
    vi.mocked(getNativeBalance).mockResolvedValue(0n);

    await expect(waitForRefuelDelivery(record, 5, 1)).rejects.toThrow(/GAS_TOPUP_TIMEOUT/);
  });

  test("rejects unsupported destination chains", async () => {
    await expect(waitForRefuelDelivery({ ...record, toChainId: 99999 }, 10, 1)).rejects.toThrow(
      /Unsupported destination chain/,
    );
  });
});
