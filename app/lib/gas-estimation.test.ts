import type { Address } from "viem";
import { zeroAddress } from "viem";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("./public-client", () => ({
  getPublicClient: vi.fn().mockReturnValue({
    estimateFeesPerGas: vi.fn().mockResolvedValue({
      maxFeePerGas: 20000000000n,
      maxPriorityFeePerGas: 1000000000n,
    }),
  }),
  retryOnRateLimit: vi.fn((fn) => fn()),
}));

vi.mock("~/data/supported-chains", () => ({
  chains: {
    1: { name: "Ethereum", nativeCurrency: { symbol: "ETH", decimals: 18 } },
    137: { name: "Polygon", nativeCurrency: { symbol: "POL", decimals: 18 } },
  },
}));

import {
  attachGasEstimates,
  buildGasContext,
  buildStepGasEstimate,
  estimateChainGasCosts,
  estimateDestinationChainOperations,
  estimateOperationsForChainWallet,
  fetchNativeTokenPriceUsd,
  formatGasCostNative,
  getNativeSymbol,
  type OperationType,
} from "./gas-estimation";
import type { TokenAmount, TransactionStep } from "./types";

describe("gas-estimation", () => {
  describe("estimateChainGasCosts", () => {
    test("calculates total gas cost with 30% safety buffer", async () => {
      const ops: OperationType[] = ["swap", "cctp-approval", "cctp-burn"];
      const result = await estimateChainGasCosts(1, ops, 20000000000n);

      // swap: 500_000 * 20gwei = 10_000_000_000_000_000
      // cctp-approval: 65_000 * 20gwei = 1_300_000_000_000_000
      // cctp-burn: 200_000 * 20gwei = 4_000_000_000_000_000
      // raw = 15_300_000_000_000_000
      // with 30% buffer: 15_300_000_000_000_000 * 130 / 100 = 19_890_000_000_000_000
      expect(result.totalGasCost).toBe(19890000000000000n);
      expect(result.maxFeePerGas).toBe(20000000000n);
      expect(result.perOperation).toHaveLength(3);
    });

    test("returns zero for empty operations", async () => {
      const result = await estimateChainGasCosts(1, [], 20000000000n);
      expect(result.totalGasCost).toBe(0n);
      expect(result.perOperation).toHaveLength(0);
    });

    test("fetches gas price from chain when not provided", async () => {
      const result = await estimateChainGasCosts(1, ["transfer-native"]);
      // mocked 20gwei * 2.5 fast multiplier = 50gwei effective
      // 21_000 * 50gwei = 1_050_000_000_000_000, with 30% buffer = 1_365_000_000_000_000
      expect(result.totalGasCost).toBe(1365000000000000n);
    });
  });

  describe("estimateOperationsForChainWallet", () => {
    const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address;

    test("source chain with mixed tokens generates approvals + swap + bridge ops", () => {
      const tokens = [
        { token: "0x1111111111111111111111111111111111111111" as Address, symbol: "WETH", decimals: 18, amount: 1n },
        { token: zeroAddress, symbol: "ETH", decimals: 18, amount: 1n },
      ];

      const ops = estimateOperationsForChainWallet(tokens, 1, 8453, USDC);

      expect(ops).toContain("erc20-approval");
      expect(ops).toContain("swap-multi");
      expect(ops).toContain("cctp-approval");
      expect(ops).toContain("cctp-burn");
    });

    test("destination chain does not include bridge operations", () => {
      const tokens = [
        { token: "0x1111111111111111111111111111111111111111" as Address, symbol: "WETH", decimals: 18, amount: 1n },
      ];

      const ops = estimateOperationsForChainWallet(tokens, 1, 1, USDC);

      expect(ops).toContain("erc20-approval");
      expect(ops).toContain("swap");
      expect(ops).not.toContain("cctp-approval");
      expect(ops).not.toContain("cctp-burn");
    });

    test("single native token on source chain generates swap + bridge ops", () => {
      const tokens = [{ token: zeroAddress, symbol: "ETH", decimals: 18, amount: 1n }];

      const ops = estimateOperationsForChainWallet(tokens, 1, 8453, USDC);

      expect(ops).toContain("swap");
      expect(ops).not.toContain("erc20-approval");
      expect(ops).toContain("cctp-approval");
      expect(ops).toContain("cctp-burn");
    });
  });

  describe("estimateDestinationChainOperations", () => {
    test("includes claim when bridges exist", () => {
      const ops = estimateDestinationChainOperations(true, 1, false, false, false);
      expect(ops).toContain("cctp-claim");
    });

    test("excludes claim when no bridges", () => {
      const ops = estimateDestinationChainOperations(false, 1, false, false, false);
      expect(ops).not.toContain("cctp-claim");
    });

    test("includes transfer-native for native token transfer", () => {
      const ops = estimateDestinationChainOperations(false, 0, false, true, true);
      expect(ops).toContain("transfer-native");
    });

    test("includes transfer-erc20 for ERC20 token transfer", () => {
      const ops = estimateDestinationChainOperations(false, 0, false, true, false);
      expect(ops).toContain("transfer-erc20");
    });
  });

  describe("buildStepGasEstimate", () => {
    test("computes gas cost in wei and USD", () => {
      const estimate = buildStepGasEstimate(["swap"], 20000000000n, 2000, "ETH");

      // 500_000 units * 20gwei * 130 / 100 = 13_000_000_000_000_000 wei
      expect(estimate.gasUnits).toBe(500000n);
      expect(estimate.gasCostWei).toBe(13000000000000000n);
      expect(estimate.nativeSymbol).toBe("ETH");
      expect(estimate.gasCostUsd).toBeGreaterThan(0);
    });
  });

  describe("getNativeSymbol", () => {
    test("returns ETH for Ethereum", () => {
      expect(getNativeSymbol(1)).toBe("ETH");
    });

    test("returns POL for Polygon", () => {
      expect(getNativeSymbol(137)).toBe("POL");
    });

    test("defaults to ETH for unknown chains", () => {
      expect(getNativeSymbol(99999)).toBe("ETH");
    });
  });

  describe("formatGasCostNative", () => {
    test("formats wei to native with up to 6 decimals", () => {
      // 0.001 ETH = 1e15 wei. formatUnits drops trailing zeros.
      expect(formatGasCostNative(1_000_000_000_000_000n)).toBe("0.001");
    });

    test("handles whole numbers without trailing decimals", () => {
      expect(formatGasCostNative(1_000_000_000_000_000_000n)).toBe("1");
    });

    test("handles zero", () => {
      expect(formatGasCostNative(0n)).toBe("0");
    });

    test("truncates beyond 6 decimals (does not round)", () => {
      // 0.0123456789 ETH → formatUnits returns "0.0123456789", truncated to "0.012345"
      const wei = 12_345_678_900_000_000n;
      expect(formatGasCostNative(wei)).toBe("0.012345");
    });

    test("avoids precision loss for large bigints", () => {
      // 1234.56789 ETH — well past Number.MAX_SAFE_INTEGER as wei
      const wei = 1_234_567_890_000_000_000_000n;
      expect(formatGasCostNative(wei)).toBe("1234.56789");
    });
  });

  describe("buildStepGasEstimate USD precision", () => {
    test("computes USD without losing precision for large gas costs", () => {
      // 10M gas units * 100 gwei = 1 ETH-equivalent (10^18 wei) * 1.3 buffer = 1.3 ETH
      const ops = Array<OperationType>(20).fill("swap-multi"); // 16M units
      const estimate = buildStepGasEstimate(ops, 100_000_000_000n, 2000, "ETH");
      // 16_000_000 * 100 gwei = 1.6 ETH * 1.3 = 2.08 ETH * $2000 = $4160
      expect(estimate.gasCostUsd).toBeCloseTo(4160, 0);
    });
  });

  describe("fetchNativeTokenPriceUsd", () => {
    const originalFetch = global.fetch;

    afterEach(() => {
      global.fetch = originalFetch;
    });

    test("returns price for valid response", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            tokenPrices: { [zeroAddress]: 2500.5 },
          }),
      }) as unknown as typeof fetch;

      const price = await fetchNativeTokenPriceUsd(1);
      expect(price).toBe(2500.5);
    });

    test("returns 0 when response is not ok", async () => {
      global.fetch = vi
        .fn()
        .mockResolvedValue({ ok: false, json: () => Promise.resolve({}) }) as unknown as typeof fetch;
      expect(await fetchNativeTokenPriceUsd(1)).toBe(0);
    });

    test("returns 0 when fetch throws", async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error("network down")) as unknown as typeof fetch;
      expect(await fetchNativeTokenPriceUsd(1)).toBe(0);
    });

    test("handles missing token entry gracefully", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ tokenPrices: {} }),
      }) as unknown as typeof fetch;
      expect(await fetchNativeTokenPriceUsd(1)).toBe(0);
    });
  });

  describe("buildGasContext", () => {
    const originalFetch = global.fetch;

    beforeEach(() => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ tokenPrices: { [zeroAddress]: 1000 } }),
      }) as unknown as typeof fetch;
    });

    afterEach(() => {
      global.fetch = originalFetch;
    });

    test("populates fees, prices, and symbols for each chain", async () => {
      const ctx = await buildGasContext([1, 137]);

      // mocked 20gwei * 2.5 fast multiplier = 50gwei
      expect(ctx.maxFeePerGas[1]).toBe(50000000000n);
      expect(ctx.maxFeePerGas[137]).toBe(50000000000n);
      expect(ctx.nativeTokenPriceUsd[1]).toBe(1000);
      expect(ctx.nativeTokenPriceUsd[137]).toBe(1000);
      expect(ctx.nativeSymbol[1]).toBe("ETH");
      expect(ctx.nativeSymbol[137]).toBe("POL");
    });

    test("deduplicates chain ids", async () => {
      const ctx = await buildGasContext([1, 1, 1]);
      expect(Object.keys(ctx.maxFeePerGas)).toEqual(["1"]);
    });

    test("handles empty chain list", async () => {
      const ctx = await buildGasContext([]);
      expect(ctx.maxFeePerGas).toEqual({});
      expect(ctx.nativeTokenPriceUsd).toEqual({});
      expect(ctx.nativeSymbol).toEqual({});
    });
  });

  describe("attachGasEstimates", () => {
    const ETH = zeroAddress;
    const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address;
    const WALLET = "0x1111111111111111111111111111111111111111" as Address;

    const baseToken = (overrides: Partial<TokenAmount> = {}): TokenAmount => ({
      token: USDC,
      amount: 100n,
      chainId: 1,
      walletAddress: WALLET,
      symbol: "USDC",
      decimals: 6,
      ...overrides,
    });

    const ctx = {
      maxFeePerGas: { 1: 20_000_000_000n },
      nativeTokenPriceUsd: { 1: 2000 },
      nativeSymbol: { 1: "ETH" },
    };

    test("attaches estimates to swap, bridge, claim, transfer steps", () => {
      const steps: TransactionStep[] = [
        {
          id: "s1",
          type: "swap",
          status: "pending",
          chainId: 1,
          inputTokens: [baseToken(), baseToken({ token: ETH })],
          outputToken: baseToken(),
        },
        {
          id: "s2",
          type: "bridge",
          status: "pending",
          chainId: 1,
          inputTokens: [baseToken()],
          outputToken: baseToken(),
        },
        {
          id: "s3",
          type: "claim",
          status: "pending",
          chainId: 1,
          inputTokens: [baseToken()],
          outputToken: baseToken(),
        },
        {
          id: "s4",
          type: "transfer",
          status: "pending",
          chainId: 1,
          inputTokens: [baseToken({ token: ETH })],
          outputToken: baseToken({ token: ETH }),
        },
      ];

      attachGasEstimates(steps, ctx);

      expect(steps[0].estimatedGas?.gasCostWei).toBeGreaterThan(0n);
      // swap-multi (2 inputs) + 1 erc20-approval = 800k + 65k = 865k units * 20 gwei * 1.3
      expect(steps[0].estimatedGas?.gasUnits).toBe(865_000n);
      // bridge = cctp-approval + cctp-burn = 65k + 200k = 265k
      expect(steps[1].estimatedGas?.gasUnits).toBe(265_000n);
      // claim = cctp-claim = 300k
      expect(steps[2].estimatedGas?.gasUnits).toBe(300_000n);
      // native transfer = 21k
      expect(steps[3].estimatedGas?.gasUnits).toBe(21_000n);
    });

    test("skips attestation steps", () => {
      const steps: TransactionStep[] = [
        {
          id: "att",
          type: "attestation",
          status: "pending",
          chainId: 1,
          inputTokens: [baseToken()],
          outputToken: baseToken(),
        },
      ];

      attachGasEstimates(steps, ctx);
      expect(steps[0].estimatedGas).toBeUndefined();
    });

    test("uses default fee/price/symbol when chain missing from context", () => {
      const steps: TransactionStep[] = [
        {
          id: "s1",
          type: "swap",
          status: "pending",
          chainId: 99999,
          inputTokens: [baseToken({ chainId: 99999 })],
          outputToken: baseToken({ chainId: 99999 }),
        },
      ];

      attachGasEstimates(steps, ctx);
      expect(steps[0].estimatedGas).toBeDefined();
      expect(steps[0].estimatedGas?.gasCostWei).toBe(0n); // fee defaults to 0
      expect(steps[0].estimatedGas?.nativeSymbol).toBe("ETH");
    });

    test("transfer with checksummed zeroAddress is detected as native", () => {
      // zeroAddress is lowercase; the previous strict-equality check would have
      // missed any caller passing an alternate casing.
      const checksummed = "0x0000000000000000000000000000000000000000" as Address;
      const steps: TransactionStep[] = [
        {
          id: "t",
          type: "transfer",
          status: "pending",
          chainId: 1,
          inputTokens: [baseToken({ token: checksummed })],
          outputToken: baseToken({ token: checksummed }),
        },
      ];

      attachGasEstimates(steps, ctx);
      expect(steps[0].estimatedGas?.gasUnits).toBe(21_000n);
    });
  });
});
