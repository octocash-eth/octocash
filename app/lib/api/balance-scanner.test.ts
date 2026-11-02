import { type Address, decodeFunctionData, encodeFunctionResult, type Hex, parseAbi, zeroAddress } from "viem";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { BALANCE_SCANNER_RUNTIME, scanBalances, scanKey } from "./balance-scanner";

const abi = parseAbi(["function scan(address[] wallets, address[] tokens) view returns (uint256[])"]);

const mockCall = vi.fn();
vi.mock("../public-client", () => ({
  getPublicClient: vi.fn(() => ({ call: mockCall })),
}));

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;

/** Fake chain state: balance of `wallet` for `token` (lowercased key). */
let state: Map<string, bigint>;

/** Serve `call` like the real scanner: non-zero balances as packed pairs. */
function serveScan({ data }: { data: Hex }) {
  const { args } = decodeFunctionData({ abi, data });
  const [wallets, tokens] = args as [Address[], Address[]];
  const out: bigint[] = [];
  tokens.forEach((t, ti) => {
    wallets.forEach((w, wi) => {
      const bal = state.get(scanKey(t, w)) ?? 0n;
      if (bal > 0n) out.push((BigInt(ti) << 128n) | BigInt(wi), bal);
    });
  });
  return Promise.resolve({ data: encodeFunctionResult({ abi, functionName: "scan", result: out }) });
}

const callArgs = (i: number) => {
  const { args } = decodeFunctionData({ abi, data: mockCall.mock.calls[i][0].data });
  return args as [Address[], Address[]];
};

describe("scanBalances", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    state = new Map();
    mockCall.mockImplementation(serveScan);
  });

  test("returns only non-zero balances keyed by token:wallet", async () => {
    const [w1, w2] = [addr(0xa1), addr(0xa2)];
    const [t1, t2] = [addr(0xb1), addr(0xb2)];
    state.set(scanKey(t1, w2), 5n);
    state.set(scanKey(zeroAddress, w1), 7n);

    const result = await scanBalances(1, [w1, w2], [zeroAddress, t1, t2]);

    expect([...result]).toEqual([
      [scanKey(zeroAddress, w1), 7n],
      [scanKey(t1, w2), 5n],
    ]);
  });

  test("injects the scanner runtime through a state override", async () => {
    await scanBalances(1, [addr(1)], [addr(2)]);

    const [{ to, stateOverride }] = mockCall.mock.calls[0];
    expect(stateOverride).toEqual([{ address: to, code: BALANCE_SCANNER_RUNTIME }]);
    expect(BALANCE_SCANNER_RUNTIME).toMatch(/^0x[0-9a-f]+$/);
  });

  test("makes no call for empty inputs", async () => {
    expect((await scanBalances(1, [], [addr(1)])).size).toBe(0);
    expect((await scanBalances(1, [addr(1)], [])).size).toBe(0);
    expect(mockCall).not.toHaveBeenCalled();
  });

  test("dedupes wallets and tokens case-insensitively", async () => {
    const w = "0x00000000000000000000000000000000000000aB" as Address;
    const t = "0x00000000000000000000000000000000000000Cd" as Address;
    await scanBalances(1, [w, w.toLowerCase() as Address], [t, t.toLowerCase() as Address]);

    const [wallets, tokens] = callArgs(0);
    expect(wallets).toHaveLength(1);
    expect(tokens).toHaveLength(1);
  });

  test("chunks large scans to ≤20k checks and ≤64 wallets per call", async () => {
    const wallets = Array.from({ length: 100 }, (_, i) => addr(0x10000 + i));
    const tokens = Array.from({ length: 3_000 }, (_, i) => addr(0x20000 + i));
    state.set(scanKey(tokens[2_999], wallets[99]), 1n);

    const result = await scanBalances(1, wallets, tokens);

    expect(result.get(scanKey(tokens[2_999], wallets[99]))).toBe(1n);
    let checks = 0;
    for (let i = 0; i < mockCall.mock.calls.length; i++) {
      const [w, t] = callArgs(i);
      expect(w.length).toBeLessThanOrEqual(64);
      expect(w.length * t.length).toBeLessThanOrEqual(20_000);
      checks += w.length * t.length;
    }
    expect(checks).toBe(100 * 3_000); // every pair checked exactly once
  });

  test("splits a failing chunk in half and retries", async () => {
    const tokens = [addr(1), addr(2), addr(3), addr(4)];
    state.set(scanKey(addr(4), addr(9)), 3n);
    mockCall.mockRejectedValueOnce(new Error("payload too large"));

    const result = await scanBalances(1, [addr(9)], tokens);

    expect(result.get(scanKey(addr(4), addr(9)))).toBe(3n);
    expect(callArgs(1)[1]).toEqual(tokens.slice(0, 2));
    expect(callArgs(2)[1]).toEqual(tokens.slice(2));
  });

  test("throws once splitting no longer helps, never returning a partial scan", async () => {
    mockCall.mockRejectedValue(new Error("state override unsupported"));

    await expect(scanBalances(1, [addr(9)], [addr(1), addr(2), addr(3), addr(4)])).rejects.toThrow(
      /state override unsupported/,
    );
    // 1 call + 2 halves + 4 quarters, then give up.
    expect(mockCall).toHaveBeenCalledTimes(7);
  });
});
