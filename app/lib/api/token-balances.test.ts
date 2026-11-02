import { type Address, parseUnits, zeroAddress } from "viem";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { ConsolidationState } from "../types";
import { scanBalances, scanKey } from "./balance-scanner";
import { deloraPriceKey, fetchDeloraPrices } from "./delora";
import {
  catalogTokenRefs,
  extraTokenRefs,
  fetchTokenBalances,
  resetTokenMetadataCache,
  STAKED_TOKEN_REFS,
  type TokenRef,
  watchedTokensFromConsolidations,
} from "./token-balances";

vi.mock("./balance-scanner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./balance-scanner")>()),
  scanBalances: vi.fn(),
}));
vi.mock("./delora", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./delora")>()),
  fetchDeloraPrices: vi.fn(),
}));
const mockMulticall = vi.fn();
vi.mock("../public-client", () => ({
  getPublicClient: vi.fn(() => ({ multicall: mockMulticall })),
}));

const WALLET = "0x1234567890123456789012345678901234567890" as Address;
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address;
const ODD = "0x00000000000000000000000000000000000000Dd" as Address;

const usdcRef: TokenRef = { chainId: 1, token: USDC, symbol: "USDC", name: "USD Coin", decimals: 6, priceUSD: 1 };

function scanReturns(entries: Array<[Address, bigint]>) {
  vi.mocked(scanBalances).mockResolvedValue(new Map(entries.map(([t, amount]) => [scanKey(t, WALLET), amount])));
}

describe("fetchTokenBalances", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    resetTokenMetadataCache();
    vi.mocked(fetchDeloraPrices).mockResolvedValue(new Map());
  });

  test("uses catalog metadata and price without extra lookups", async () => {
    scanReturns([[USDC, parseUnits("12.5", 6)]]);

    const result = await fetchTokenBalances(1, [WALLET], [usdcRef]);

    expect(result).toEqual([
      {
        token: USDC,
        amount: parseUnits("12.5", 6),
        chainId: 1,
        walletAddress: WALLET,
        symbol: "USDC",
        name: "USD Coin",
        decimals: 6,
      },
    ]);
    expect(mockMulticall).not.toHaveBeenCalled();
    expect(fetchDeloraPrices).toHaveBeenCalledWith([]);
  });

  test("scans only refs for the requested chain", async () => {
    scanReturns([]);
    await fetchTokenBalances(1, [WALLET], [usdcRef, { chainId: 10, token: ODD }]);
    expect(vi.mocked(scanBalances).mock.calls[0][2]).toEqual([USDC]);
  });

  test("drops dust below $0.01", async () => {
    scanReturns([[USDC, parseUnits("0.009", 6)]]);
    expect(await fetchTokenBalances(1, [WALLET], [usdcRef])).toEqual([]);
  });

  test("prices unpriced held tokens via Delora and drops those still unpriced", async () => {
    const PRICED = "0x00000000000000000000000000000000000000Aa" as Address;
    scanReturns([
      [PRICED, parseUnits("2", 18)],
      [ODD, parseUnits("2", 18)],
    ]);
    vi.mocked(fetchDeloraPrices).mockResolvedValue(new Map([[deloraPriceKey(1, PRICED), 3]]));
    const meta = { symbol: "X", decimals: 18 };

    const result = await fetchTokenBalances(
      1,
      [WALLET],
      [
        { chainId: 1, token: PRICED, ...meta },
        { chainId: 1, token: ODD, ...meta },
      ],
    );

    expect(fetchDeloraPrices).toHaveBeenCalledWith([
      { chainId: 1, token: PRICED },
      { chainId: 1, token: ODD },
    ]);
    expect(result.map((t) => t.token)).toEqual([PRICED]);
  });

  test("uses the chain's native currency for the native coin", async () => {
    scanReturns([[zeroAddress, parseUnits("1", 18)]]);
    vi.mocked(fetchDeloraPrices).mockResolvedValue(new Map([[deloraPriceKey(1, zeroAddress), 2000]]));

    const [eth] = await fetchTokenBalances(1, [WALLET], [{ chainId: 1, token: zeroAddress }]);

    expect(eth).toMatchObject({ token: zeroAddress, symbol: "ETH", decimals: 18 });
    expect(mockMulticall).not.toHaveBeenCalled();
  });

  test("reads missing metadata on-chain once and caches it", async () => {
    scanReturns([[ODD, parseUnits("5", 8)]]);
    vi.mocked(fetchDeloraPrices).mockResolvedValue(new Map([[deloraPriceKey(1, ODD), 1]]));
    mockMulticall.mockResolvedValue([
      { status: "success", result: "Odd Token" },
      { status: "success", result: "ODD" },
      { status: "success", result: 8 },
    ]);

    const [first] = await fetchTokenBalances(1, [WALLET], [{ chainId: 1, token: ODD }]);
    await fetchTokenBalances(1, [WALLET], [{ chainId: 1, token: ODD }]);

    expect(first).toMatchObject({ symbol: "ODD", name: "Odd Token", decimals: 8, amount: parseUnits("5", 8) });
    expect(mockMulticall).toHaveBeenCalledTimes(1);
  });

  test("drops tokens whose metadata can't be read", async () => {
    scanReturns([[ODD, 1n]]);
    vi.mocked(fetchDeloraPrices).mockResolvedValue(new Map([[deloraPriceKey(1, ODD), 1e18]]));
    mockMulticall.mockResolvedValue([
      { status: "success", result: "Odd" },
      { status: "failure", error: new Error("revert") },
      { status: "success", result: 18 },
    ]);

    expect(await fetchTokenBalances(1, [WALLET], [{ chainId: 1, token: ODD }])).toEqual([]);
  });

  test("propagates scan failures instead of returning a partial view", async () => {
    vi.mocked(scanBalances).mockRejectedValue(new Error("rpc down"));
    await expect(fetchTokenBalances(1, [WALLET], [usdcRef])).rejects.toThrow("rpc down");
  });

  test("returns the caller's wallet casing", async () => {
    scanReturns([[USDC, parseUnits("1", 6)]]);
    const [t] = await fetchTokenBalances(1, [WALLET], [usdcRef]);
    expect(t.walletAddress).toBe(WALLET);
  });
});

describe("token ref helpers", () => {
  const catalog = new Map([
    [USDC.toLowerCase(), { address: USDC, symbol: "USDC", name: "USD Coin", decimals: 6, priceUSD: 1 }],
  ]);

  test("catalogTokenRefs maps catalog entries to refs", () => {
    expect(catalogTokenRefs(1, catalog)).toEqual([usdcRef]);
  });

  test("extraTokenRefs drops catalog tokens and other chains, dedupes, prefers metadata", () => {
    const refs = extraTokenRefs(1, catalog, [
      { chainId: 1, token: USDC },
      { chainId: 10, token: ODD },
      { chainId: 1, token: ODD },
      { chainId: 1, token: ODD.toLowerCase() as Address, symbol: "ODD", decimals: 18 },
    ]);
    expect(refs).toEqual([{ chainId: 1, token: ODD.toLowerCase(), symbol: "ODD", decimals: 18 }]);
  });

  test("extraTokenRefs adds the native coin when the catalog is unavailable", () => {
    expect(extraTokenRefs(1, undefined, [{ chainId: 1, token: USDC }])).toEqual([
      { chainId: 1, token: zeroAddress },
      { chainId: 1, token: USDC },
    ]);
  });

  test("watchedTokensFromConsolidations covers destination and source tokens", () => {
    const record = {
      destinationToken: { chainId: 8453, token: ODD, walletAddress: WALLET, symbol: "ODD", decimals: 18 },
      sourceTokens: [{ chainId: 1, token: USDC, walletAddress: WALLET, symbol: "USDC", decimals: 6, amount: 1n }],
    } as unknown as ConsolidationState;

    expect(watchedTokensFromConsolidations([record])).toEqual([
      { chainId: 8453, token: ODD, symbol: "ODD", name: undefined, decimals: 18 },
      { chainId: 1, token: USDC, symbol: "USDC", name: undefined, decimals: 6 },
    ]);
  });

  test("STAKED_TOKEN_REFS mirrors the curated staked-token list", () => {
    expect(STAKED_TOKEN_REFS.length).toBeGreaterThan(0);
    expect(STAKED_TOKEN_REFS.every((r) => typeof r.chainId === "number" && r.token.startsWith("0x"))).toBe(true);
  });
});
