import type { Address } from "viem";
import { zeroAddress } from "viem";
import { beforeEach, describe, expect, test, vi } from "vitest";

// Default mock setup. Each test that needs different values calls
// `mockGetPublicClient.mockReturnValueOnce(...)` to inject custom behavior.
// With these defaults:
//   - block.baseFeePerGas = 10 gwei, gasUsed = gasLimit/2 (target)
//     ⇒ pendingBaseFee = 10 gwei
//   - bufferedBaseFee = 20 gwei (200% buffer)
//   - feeHistory[p75] median = 5 gwei
//   - mainnet (1) floor = 1 gwei → priority = max(5, 1) = 5 gwei
//   - polygon (137) floor = 30 gwei → priority = max(5, 30) = 30 gwei
//   - L2s/default floor = 1 wei → priority = 5 gwei
//   - mainnet maxFeePerGas = 20 + 5 = 25 gwei
//   - polygon maxFeePerGas = 20 + 30 = 50 gwei
const makeMockClient = () => ({
  getBlock: vi.fn().mockResolvedValue({
    baseFeePerGas: 10_000_000_000n,
    gasUsed: 15_000_000n,
    gasLimit: 30_000_000n,
  }),
  getFeeHistory: vi.fn().mockResolvedValue({
    reward: [[5_000_000_000n], [5_000_000_000n]],
  }),
  // estimateGas defaults to throwing so step-level simulation always falls
  // back to GAS_BUDGETS — keeps the existing per-op gasUnits assertions
  // (e.g. `swap = 500_000n`) stable. Tests that exercise the simulated
  // path override this with `mockResolvedValueOnce`.
  estimateGas: vi.fn().mockRejectedValue(new Error("revert")),
  getGasPrice: vi.fn().mockResolvedValue(5_000_000_000n),
});

const mockClient = makeMockClient();

vi.mock("./public-client", () => ({
  getPublicClient: vi.fn(() => mockClient),
  retryOnRateLimit: vi.fn((fn) => fn()),
}));

vi.mock("~/data/supported-chains", () => ({
  chains: {
    1: { name: "Ethereum", nativeCurrency: { symbol: "ETH", decimals: 18 } },
    137: { name: "Polygon", nativeCurrency: { symbol: "POL", decimals: 18 } },
    10: {
      name: "OP Mainnet",
      nativeCurrency: { symbol: "ETH", decimals: 18 },
      contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
    },
  },
}));

import { getPublicClient } from "./public-client";

const mockGetPublicClient = vi.mocked(getPublicClient);

import {
  attachGasEstimates,
  buildGasContext,
  buildStepGasEstimate,
  estimateChainGasCosts,
  estimateDestinationChainOperations,
  estimateOperationsForChainWallet,
  fetchFastFees,
  formatGasCostNative,
  getNativeSymbol,
} from "./gas-estimation";
import type { TokenAmount, TransactionStep } from "./types";

beforeEach(() => {
  // Reset to default mock behavior between tests so per-test overrides
  // (mockResolvedValueOnce / mockRejectedValueOnce) don't leak.
  mockClient.getBlock.mockReset().mockResolvedValue({
    baseFeePerGas: 10_000_000_000n,
    gasUsed: 15_000_000n,
    gasLimit: 30_000_000n,
  });
  mockClient.getFeeHistory.mockReset().mockResolvedValue({
    reward: [[5_000_000_000n], [5_000_000_000n]],
  });
  mockClient.estimateGas.mockReset().mockRejectedValue(new Error("revert"));
  mockClient.getGasPrice.mockReset().mockResolvedValue(5_000_000_000n);
  mockGetPublicClient.mockReturnValue(mockClient as unknown as ReturnType<typeof getPublicClient>);
});

describe("gas-estimation", () => {
  describe("estimateChainGasCosts", () => {
    test("calculates total gas cost with 30% safety buffer", async () => {
      const result = await estimateChainGasCosts(1, ["swap", "cctp-approval", "cctp-burn"], 20_000_000_000n);

      // swap: 500_000 * 20gwei = 10_000_000_000_000_000
      // cctp-approval: 65_000 * 20gwei = 1_300_000_000_000_000
      // cctp-burn: 200_000 * 20gwei = 4_000_000_000_000_000
      // raw = 15_300_000_000_000_000
      // with 30% buffer: 15_300_000_000_000_000 * 130 / 100 = 19_890_000_000_000_000
      expect(result.totalGasCost).toBe(19_890_000_000_000_000n);
      expect(result.maxFeePerGas).toBe(20_000_000_000n);
      expect(result.perOperation).toHaveLength(3);
    });

    test("returns zero for empty operations", async () => {
      const result = await estimateChainGasCosts(1, [], 20_000_000_000n);
      expect(result.totalGasCost).toBe(0n);
      expect(result.perOperation).toHaveLength(0);
    });

    test("fetches gas price from chain when not provided", async () => {
      // Default mocks: mainnet maxFeePerGas = 20 gwei (buffered base) + 5 gwei (priority) = 25 gwei
      // 21_000 * 25gwei = 525_000_000_000_000
      // with 30% buffer = 682_500_000_000_000
      const result = await estimateChainGasCosts(1, ["transfer-native"]);
      expect(result.totalGasCost).toBe(682_500_000_000_000n);
    });
  });

  describe("fetchFastFees", () => {
    test("uses bufferedBaseFee + p75 priority on mainnet", async () => {
      const fees = await fetchFastFees(1);
      // bufferedBase 20 gwei + priority 5 gwei (above mainnet floor of 1 gwei)
      expect(fees.maxFeePerGas).toBe(25_000_000_000n);
      expect(fees.maxPriorityFeePerGas).toBe(5_000_000_000n);
    });

    test("clamps priority to Polygon's 30 gwei floor", async () => {
      const fees = await fetchFastFees(137);
      // bufferedBase 20 gwei + priority floored to 30 gwei = 50 gwei
      expect(fees.maxFeePerGas).toBe(50_000_000_000n);
      expect(fees.maxPriorityFeePerGas).toBe(30_000_000_000n);
    });

    test("uses default 1-wei floor for L2s when feeHistory is sparse", async () => {
      mockClient.getFeeHistory.mockResolvedValueOnce({ reward: [] });
      const fees = await fetchFastFees(10); // OP Mainnet (no chain-specific floor)
      // priority history empty → 0n; default floor is 1n
      expect(fees.maxPriorityFeePerGas).toBe(1n);
      expect(fees.maxFeePerGas).toBe(20_000_000_001n);
    });

    test("computes pendingBaseFee correctly when block was over target", async () => {
      // gasUsed = 30M (full block, target = 15M).
      // Δ = 10gwei × (30M - 15M) / 15M / 8 = 10gwei / 8 = 1.25 gwei
      // pendingBase = 10 + 1.25 = 11.25 gwei
      // bufferedBase = 22.5 gwei
      // total = 22.5 + 5 (priority) = 27.5 gwei
      mockClient.getBlock.mockResolvedValueOnce({
        baseFeePerGas: 10_000_000_000n,
        gasUsed: 30_000_000n,
        gasLimit: 30_000_000n,
      });
      const fees = await fetchFastFees(1);
      expect(fees.maxFeePerGas).toBe(27_500_000_000n);
    });

    test("falls back to legacy gasPrice × 2 when chain is not EIP-1559", async () => {
      mockClient.getBlock.mockResolvedValueOnce({
        baseFeePerGas: null,
        gasUsed: 0n,
        gasLimit: 30_000_000n,
      });
      const fees = await fetchFastFees(1);
      // gasPrice 5 gwei × 200% = 10 gwei
      expect(fees.maxFeePerGas).toBe(10_000_000_000n);
      expect(fees.maxPriorityFeePerGas).toBeUndefined();
    });

    test("falls back to legacy gasPrice when getFeeHistory throws", async () => {
      mockClient.getFeeHistory.mockRejectedValueOnce(new Error("unsupported"));
      const fees = await fetchFastFees(1);
      expect(fees.maxFeePerGas).toBe(10_000_000_000n);
      expect(fees.maxPriorityFeePerGas).toBeUndefined();
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
      // One single-input swap per token (WETH + native).
      expect(ops.filter((op) => op === "swap")).toHaveLength(2);
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

  const swapStep: TransactionStep = {
    id: "s1",
    type: "swap",
    status: "pending",
    chainId: 1,
    inputTokens: [baseToken()],
    outputToken: baseToken(),
  };

  describe("buildStepGasEstimate", () => {
    test("falls back to static budget when simulation reverts", async () => {
      // Default mock: estimateGas rejects ⇒ all ops fall back to GAS_BUDGETS.
      // swap step has 1 erc20-approval (USDC input) + 1 "swap" op.
      // 65_000 + 500_000 = 565_000 units; * 20 gwei * 1.3 = 14_690_000_000_000_000 wei
      const estimate = await buildStepGasEstimate(swapStep, 20_000_000_000n, "ETH");
      expect(estimate.gasUnits).toBe(565_000n);
      expect(estimate.gasCostWei).toBe(14_690_000_000_000_000n);
      expect(estimate.nativeSymbol).toBe("ETH");
    });

    test("uses simulated gas when estimateGas succeeds (transfer step)", async () => {
      // Native transfer simulates to 21_000 (real on-chain). With our mock we
      // return 25_000 to verify the path actually consumes the simulated value.
      mockClient.estimateGas.mockResolvedValueOnce(25_000n);
      const transferStep: TransactionStep = {
        id: "t1",
        type: "transfer",
        status: "pending",
        chainId: 1,
        inputTokens: [baseToken({ token: ETH })],
        outputToken: baseToken({ token: ETH }),
      };
      const estimate = await buildStepGasEstimate(transferStep, 20_000_000_000n, "ETH");
      // Simulated 25_000 instead of static 21_000.
      expect(estimate.gasUnits).toBe(25_000n);
      // 25_000 * 20gwei * 1.3 = 650_000_000_000_000
      expect(estimate.gasCostWei).toBe(650_000_000_000_000n);
    });

    test("mixes simulated approvals with static swap budget", async () => {
      // swap step → ops: [erc20-approval, swap]. Simulate the approval at 50k,
      // swap-op returns null (no calldata at planning) and falls back to 500k.
      mockClient.estimateGas.mockResolvedValueOnce(50_000n);
      const estimate = await buildStepGasEstimate(swapStep, 20_000_000_000n, "ETH");
      // 50_000 (simulated approval) + 500_000 (static swap) = 550_000
      expect(estimate.gasUnits).toBe(550_000n);
    });

    test("preserves precision for large gas costs (static fallback path)", async () => {
      // 20 distinct inputs ⇒ swap step has 20 erc20-approvals + 20 swaps
      // = 20 * (65k + 500k) = 11_300k static. With simulation reverting
      // (default mock) we get exactly 11.3M units.
      const inputTokens = Array.from({ length: 20 }, (_, i) =>
        baseToken({ token: `0x${(i + 1).toString(16).padStart(40, "0")}` as Address }),
      ) as [TokenAmount, ...TokenAmount[]];
      const bigSwap: TransactionStep = { ...swapStep, inputTokens };
      const estimate = await buildStepGasEstimate(bigSwap, 100_000_000_000n, "ETH");
      // 11_300_000 * 100 gwei * 1.3 = 1_469_000_000_000_000_000 wei (1.469 ETH)
      expect(estimate.gasUnits).toBe(11_300_000n);
      expect(estimate.gasCostWei).toBe(1_469_000_000_000_000_000n);
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
      expect(formatGasCostNative(1_000_000_000_000_000n)).toBe("0.001");
    });

    test("handles whole numbers without trailing decimals", () => {
      expect(formatGasCostNative(1_000_000_000_000_000_000n)).toBe("1");
    });

    test("handles zero", () => {
      expect(formatGasCostNative(0n)).toBe("0");
    });

    test("truncates beyond 6 decimals (does not round)", () => {
      const wei = 12_345_678_900_000_000n;
      expect(formatGasCostNative(wei)).toBe("0.012345");
    });

    test("avoids precision loss for large bigints", () => {
      const wei = 1_234_567_890_000_000_000_000n;
      expect(formatGasCostNative(wei)).toBe("1234.56789");
    });
  });

  describe("buildGasContext", () => {
    test("populates fees and symbols for each chain", async () => {
      const ctx = await buildGasContext([1, 137]);

      // mainnet: bufferedBase 20gwei + priority 5gwei (above 1gwei floor) = 25gwei
      expect(ctx.maxFeePerGas[1]).toBe(25_000_000_000n);
      // polygon: bufferedBase 20gwei + priority floored to 30gwei = 50gwei
      expect(ctx.maxFeePerGas[137]).toBe(50_000_000_000n);
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
      expect(ctx.nativeSymbol).toEqual({});
    });
  });

  describe("attachGasEstimates", () => {
    const ctx = {
      maxFeePerGas: { 1: 20_000_000_000n },
      nativeSymbol: { 1: "ETH" },
    };

    test("attaches estimates to swap, bridge, claim, transfer steps (static fallback)", async () => {
      // Default mock: estimateGas rejects ⇒ all ops fall back to GAS_BUDGETS.
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

      await attachGasEstimates(steps, ctx);

      expect(steps[0].estimatedGas?.gasCostWei).toBeGreaterThan(0n);
      // Two per-token swaps (USDC + native) + 1 erc20-approval = 1000k + 65k
      expect(steps[0].estimatedGas?.gasUnits).toBe(1_065_000n);
      // bridge = cctp-approval + cctp-burn = 65k + 200k = 265k
      expect(steps[1].estimatedGas?.gasUnits).toBe(265_000n);
      // claim = cctp-claim = 300k
      expect(steps[2].estimatedGas?.gasUnits).toBe(300_000n);
      // native transfer = 21k
      expect(steps[3].estimatedGas?.gasUnits).toBe(21_000n);
    });

    test("skips attestation steps", async () => {
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

      await attachGasEstimates(steps, ctx);
      expect(steps[0].estimatedGas).toBeUndefined();
    });

    test("uses default fee/price/symbol when chain missing from context", async () => {
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

      await attachGasEstimates(steps, ctx);
      expect(steps[0].estimatedGas).toBeDefined();
      expect(steps[0].estimatedGas?.gasCostWei).toBe(0n); // fee defaults to 0
      expect(steps[0].estimatedGas?.nativeSymbol).toBe("ETH");
    });

    test("transfer with checksummed zeroAddress is detected as native", async () => {
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

      await attachGasEstimates(steps, ctx);
      expect(steps[0].estimatedGas?.gasUnits).toBe(21_000n);
    });
  });
});
