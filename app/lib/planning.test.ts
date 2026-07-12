import { ETH_ADDRESS, USDC_ETHEREUM as USDC_ADDRESS, USDC_OPTIMISM, WALLET, WBTC_ADDRESS } from "test/test-helpers";
import { type Address, zeroAddress } from "viem";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { TokenAmount, TransactionStep } from "./types";

// Mock external dependencies BEFORE imports
vi.mock("./delora");
vi.mock("./cctp");
vi.mock("./public-client", () => ({
  getPublicClient: vi.fn(() => ({
    getCode: vi.fn().mockResolvedValue("0x"),
  })),
}));
vi.mock("./gas", () => ({
  // 10 ETH: comfortably above any selected amount in the routing/provenance
  // tests so the measured-gas capping (which re-quotes the capped native leg,
  // consuming getSwapQuote once-mocks) never triggers unless a test opts in
  // by lowering the balance explicitly.
  getNativeBalance: vi.fn().mockResolvedValue(10_000_000_000_000_000_000n),
  findRichestSource: vi.fn().mockResolvedValue(null),
}));
vi.mock("./api/delora", () => ({
  // Default: no native USD prices known. createGasTopUpSteps falls back to
  // raw-balance tie-break, which preserves pre-USD-sort behavior in tests
  // that don't care about pricing. Tests that exercise USD-aware ordering
  // override this per-test.
  fetchDeloraPrices: vi.fn().mockResolvedValue(new Map()),
  deloraPriceKey: (chainId: number, address: string) => `${chainId}:${address.toLowerCase()}`,
}));
vi.mock("./lifi", () => ({
  getLiFiQuoteForTargetOutput: vi.fn(),
}));
vi.mock("./gas-estimation", () => ({
  buildGasContext: vi.fn().mockResolvedValue({
    maxFeePerGas: { 1: 20000000000n, 10: 1000000n, 137: 50000000000n, 42161: 100000000n },
    nativeSymbol: { 1: "ETH", 10: "ETH", 137: "POL", 42161: "ETH" },
  }),
  estimateChainGasCosts: vi.fn().mockResolvedValue({
    totalGasCost: 100000000000000n, // 0.0001 ETH - small enough to not interfere with tests
    maxFeePerGas: 20000000000n,
    perOperation: [],
  }),
  estimateOperationsForChainWallet: vi.fn().mockReturnValue(["swap"]),
  estimateDestinationChainOperations: vi.fn().mockReturnValue(["cctp-claim", "swap"]),
  // Attaches a small deterministic estimate per gas-consuming step so
  // reconcileGasGaps sees non-zero measured costs (mirrors the old
  // estimateChainGasCosts mock's 0.0001 ETH magnitude).
  attachGasEstimates: vi.fn(async (steps: TransactionStep[]) => {
    for (const step of steps) {
      if (step.type === "attestation" || step.type === "gas-topup-wait") continue;
      step.estimatedGas = {
        gasUnits: 5000n,
        maxFeePerGas: 20000000000n,
        gasCostWei: 100000000000000n, // 0.0001 ETH per step
        nativeSymbol: "ETH",
        source: "budget",
      };
    }
  }),
  // Capping-time measured gas. Kept ≥ (per-step attach cost × steps per
  // wallet) so a native amount capped at `balance − measured` never trips a
  // phantom reconciled gap (mirrors production, where both figures come from
  // the same simulation).
  measureOpsGas: vi.fn().mockResolvedValue(500000000000000n), // 0.0005 ETH
  buildSwapLegSimOps: vi.fn(() => []),
  buildBridgeSimOps: vi.fn(() => []),
  emptyPlanArtifacts: () => ({ swapLegs: new Map() }),
  formatGasCostNative: vi.fn((wei: bigint) => (Number(wei) / 1e18).toString()),
}));

import { getBridgeFee } from "./cctp";
import { getSwapQuote, getSwapQuoteWithLegs } from "./delora";
import { planConsolidation } from "./planning";
import { getPublicClient } from "./public-client";

// Planning consumes getSwapQuoteWithLegs; the tests configure the amount-only
// getSwapQuote mock, so delegate (legs are irrelevant here — gas-estimation is
// mocked). Re-applied per test because clearAllMocks clears call history only.
beforeEach(() => {
  vi.mocked(getSwapQuoteWithLegs).mockImplementation(async (input, output) => ({
    output: await getSwapQuote(input, output),
    legs: [],
  }));
});

describe("planConsolidation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("single token same chain - should return only swap or transfer step", async () => {
    const sourceTokens: TokenAmount[] = [
      {
        token: USDC_ADDRESS,
        amount: 1000000n, // 1 USDC
        chainId: 1,
        walletAddress: WALLET,
        symbol: "USDC",
        decimals: 6,
      },
    ];

    const destinationToken = {
      token: WBTC_ADDRESS,
      chainId: 1,
      walletAddress: WALLET,
      symbol: "WBTC",
      decimals: 8,
    };

    vi.mocked(getSwapQuote).mockResolvedValue({
      token: WBTC_ADDRESS,
      amount: 8000n, // 0.00008 WBTC
      chainId: 1,
      walletAddress: WALLET,
      symbol: "WBTC",
      decimals: 8,
    });

    const result = await planConsolidation(sourceTokens, destinationToken, [WALLET]);

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("swap");
    expect(result[0].chainId).toBe(1);
  });

  test("multi-chain consolidation - should include swaps, bridges, attestation, claim, final swap", async () => {
    const sourceTokens: TokenAmount[] = [
      {
        token: ETH_ADDRESS,
        amount: 200000000000000000n, // 0.2 POL
        chainId: 137, // Polygon
        walletAddress: WALLET,
        symbol: "POL",
        decimals: 18,
      },
      {
        token: USDC_ADDRESS,
        amount: 1000000n, // 1 USDC
        chainId: 10, // Optimism
        walletAddress: WALLET,
        symbol: "USDC",
        decimals: 6,
      },
    ];

    const destinationToken = {
      token: WBTC_ADDRESS,
      chainId: 1, // Ethereum
      walletAddress: WALLET,
      symbol: "WBTC",
      decimals: 8,
    };

    // Mock swap ETH -> USDC on Polygon
    vi.mocked(getSwapQuote).mockResolvedValueOnce({
      token: USDC_ADDRESS,
      amount: 800000000n, // 800 USDC
      chainId: 137,
      walletAddress: WALLET,
      symbol: "USDC",
      decimals: 6,
    });

    // Mock final swap USDC -> WBTC on Ethereum
    vi.mocked(getSwapQuote).mockResolvedValueOnce({
      token: WBTC_ADDRESS,
      amount: 800000n, // 0.008 WBTC
      chainId: 1,
      walletAddress: WALLET,
      symbol: "WBTC",
      decimals: 8,
    });

    vi.mocked(getBridgeFee).mockResolvedValue(0n);

    const result = await planConsolidation(sourceTokens, destinationToken, [WALLET]);

    // Should have: swap, bridge, bridge, attestation, claim, swap
    expect(result.length).toBeGreaterThanOrEqual(5);

    // Check for required transaction types
    const types = result.map((s: TransactionStep) => s.type);
    expect(types).toContain("swap");
    expect(types).toContain("bridge");
    expect(types).toContain("attestation");
    expect(types).toContain("claim");
  });

  test("token already USDC - should skip initial swap", async () => {
    const POLYGON_USDC = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359" as Address; // Polygon USDC
    const sourceTokens: TokenAmount[] = [
      {
        token: POLYGON_USDC,
        amount: 1000000n,
        chainId: 137, // Polygon
        walletAddress: WALLET,
        symbol: "USDC",
        decimals: 6,
      },
    ];

    const destinationToken = {
      token: WBTC_ADDRESS,
      chainId: 1, // Ethereum
      walletAddress: WALLET,
      symbol: "WBTC",
      decimals: 18,
    };

    vi.mocked(getBridgeFee).mockResolvedValue(0n);
    vi.mocked(getSwapQuote).mockResolvedValue({
      token: WBTC_ADDRESS,
      amount: 8000n,
      chainId: 1,
      walletAddress: WALLET,
      symbol: "WBTC",
      decimals: 8,
    });

    const result = await planConsolidation(sourceTokens, destinationToken, [WALLET]);

    // First step should be bridge, not swap
    expect(result[0].type).toBe("bridge");
    expect(result[0].inputTokens[0].token).toBe(POLYGON_USDC);
  });

  test("token already on destination chain - should skip bridge", async () => {
    const sourceTokens: TokenAmount[] = [
      {
        token: USDC_ADDRESS,
        amount: 1000000n,
        chainId: 1, // Already on Ethereum
        walletAddress: WALLET,
        symbol: "USDC",
        decimals: 6,
      },
    ];

    const destinationToken = {
      token: WBTC_ADDRESS,
      chainId: 1, // Ethereum
      walletAddress: WALLET,
      symbol: "WBTC",
      decimals: 18,
    };

    vi.mocked(getSwapQuote).mockResolvedValue({
      token: WBTC_ADDRESS,
      amount: 8000n,
      chainId: 1,
      walletAddress: WALLET,
      symbol: "WBTC",
      decimals: 8,
    });

    const result = await planConsolidation(sourceTokens, destinationToken, [WALLET]);

    // Should only have swap, no bridge/attestation/claim
    const types = result.map((s: TransactionStep) => s.type);
    expect(types).not.toContain("bridge");
    expect(types).not.toContain("attestation");
    expect(types).not.toContain("claim");
    expect(types).toContain("swap");
  });

  test("per-token steps - each unique token address gets its own swap step", async () => {
    // Create 8 tokens on the same chain
    const sourceTokens: TokenAmount[] = Array.from({ length: 8 }, (_, i) => ({
      token: `0x${i.toString().padStart(40, "0")}` as Address,
      amount: 1000000n,
      chainId: 1,
      walletAddress: WALLET,
      symbol: `TOKEN${i}`,
      decimals: 18,
    }));

    const destinationToken = {
      token: WBTC_ADDRESS,
      chainId: 1,
      walletAddress: WALLET,
      symbol: "WBTC",
      decimals: 8,
    };

    vi.mocked(getSwapQuote).mockResolvedValue({
      token: WBTC_ADDRESS,
      amount: 8000n,
      chainId: 1,
      walletAddress: WALLET,
      symbol: "WBTC",
      decimals: 8,
    });

    const result = await planConsolidation(sourceTokens, destinationToken, [WALLET]);

    // Delora quotes are single-input: one swap step per token address.
    const swapSteps = result.filter((s: TransactionStep) => s.type === "swap");
    expect(swapSteps.length).toBe(8);
    for (const step of swapSteps) {
      expect(step.inputTokens.length).toBe(1);
    }
  });

  test("per-token steps - same-address entries with different provenance share one step", async () => {
    const TOKEN_A = "0x0000000000000000000000000000000000000a01" as Address;
    const sourceTokens: TokenAmount[] = [
      { token: TOKEN_A, amount: 1_000000n, chainId: 1, walletAddress: WALLET, symbol: "A", decimals: 18 },
      // Same address, EIP-55 checksum casing variation and a different amount.
      {
        token: "0x0000000000000000000000000000000000000A01" as Address,
        amount: 2_000000n,
        chainId: 1,
        walletAddress: WALLET,
        symbol: "A",
        decimals: 18,
      },
      {
        token: "0x0000000000000000000000000000000000000a02" as Address,
        amount: 1_000000n,
        chainId: 1,
        walletAddress: WALLET,
        symbol: "B",
        decimals: 18,
      },
    ];

    const destinationToken = {
      token: WBTC_ADDRESS,
      chainId: 1,
      walletAddress: WALLET,
      symbol: "WBTC",
      decimals: 8,
    };

    vi.mocked(getSwapQuote).mockResolvedValue({
      token: WBTC_ADDRESS,
      amount: 8000n,
      chainId: 1,
      walletAddress: WALLET,
      symbol: "WBTC",
      decimals: 8,
    });

    const result = await planConsolidation(sourceTokens, destinationToken, [WALLET]);
    const swapSteps = result.filter((s: TransactionStep) => s.type === "swap");

    // Two steps: one for the merged A entries, one for B.
    expect(swapSteps.length).toBe(2);
    const aStep = swapSteps.find((s) => s.inputTokens[0].token.toLowerCase() === TOKEN_A.toLowerCase());
    expect(aStep?.inputTokens).toHaveLength(2);
  });

  test("unroutable token (no adapters available) is skipped, not fatal", async () => {
    const UNROUTABLE = "0x00000000000000000000000000000000000000aa" as Address;
    const sourceTokens: TokenAmount[] = [
      {
        token: "0x0000000000000000000000000000000000000b01" as Address,
        amount: 1_000000n,
        chainId: 1,
        walletAddress: WALLET,
        symbol: "A",
        decimals: 18,
      },
      { token: UNROUTABLE, amount: 1_000000n, chainId: 1, walletAddress: WALLET, symbol: "NOPE", decimals: 18 },
    ];

    const destinationToken = {
      token: WBTC_ADDRESS,
      chainId: 1,
      walletAddress: WALLET,
      symbol: "WBTC",
      decimals: 8,
    };

    // Delora reports "no route" as HTTP 500 / code UNKNOWN with this message
    // (verified live); the routable token quotes fine.
    vi.mocked(getSwapQuote).mockImplementation(async (input) => {
      const tokens = Array.isArray(input) ? input : [input];
      if (tokens.some((t) => t.token === UNROUTABLE)) {
        throw new Error("ExternalAPIError: Request failed (500): UNKNOWN: No adapters available for this request");
      }
      return { token: WBTC_ADDRESS, amount: 8000n, chainId: 1, walletAddress: WALLET, symbol: "WBTC", decimals: 8 };
    });

    const result = await planConsolidation(sourceTokens, destinationToken, [WALLET]);
    const swapSteps = result.filter((s: TransactionStep) => s.type === "swap");
    const swappedTokens = swapSteps.flatMap((s) => s.inputTokens.map((t) => t.token));

    // Routable token is consolidated; the unroutable token is dropped rather
    // than aborting the whole plan.
    expect(swappedTokens).not.toContain(UNROUTABLE);
    expect(swappedTokens).toContain("0x0000000000000000000000000000000000000b01");
  });

  test("transient quote failure aborts the plan instead of dropping the token", async () => {
    const FLAKY = "0x00000000000000000000000000000000000000bb" as Address;
    const sourceTokens: TokenAmount[] = [
      { token: FLAKY, amount: 1_000000n, chainId: 1, walletAddress: WALLET, symbol: "FLAKY", decimals: 18 },
    ];

    const destinationToken = {
      token: WBTC_ADDRESS,
      chainId: 1,
      walletAddress: WALLET,
      symbol: "WBTC",
      decimals: 8,
    };

    // A plain 5xx (outage, not the deterministic no-route message) must
    // propagate so the plan fails loudly and stays retryable.
    vi.mocked(getSwapQuote).mockRejectedValue(new Error("ExternalAPIError: Request failed (503): Service Unavailable"));

    await expect(planConsolidation(sourceTokens, destinationToken, [WALLET])).rejects.toThrow("ExternalAPIError");
  });

  test("invalid input - empty sourceTokens should throw PlanningError", async () => {
    const sourceTokens: TokenAmount[] = [];

    const destinationToken = {
      token: WBTC_ADDRESS,
      chainId: 1,
      walletAddress: WALLET,
      symbol: "WBTC",
      decimals: 8,
    };

    await expect(planConsolidation(sourceTokens, destinationToken, [WALLET])).rejects.toThrow("PlanningError");
  });

  test("invalid input - unsupported source chain should throw UnsupportedRouteError", async () => {
    const sourceTokens: TokenAmount[] = [
      {
        token: USDC_ADDRESS,
        amount: 1000000n,
        chainId: 999, // Unsupported chain
        walletAddress: WALLET,
        symbol: "USDC",
        decimals: 6,
      },
    ];

    const destinationToken = {
      token: WBTC_ADDRESS,
      chainId: 1,
      walletAddress: WALLET,
      symbol: "WBTC",
      decimals: 18,
    };

    await expect(planConsolidation(sourceTokens, destinationToken, [WALLET])).rejects.toThrow("UnsupportedRouteError");
  });

  test("invalid input - unsupported destination chain should throw UnsupportedRouteError", async () => {
    const sourceTokens: TokenAmount[] = [
      {
        token: USDC_ADDRESS,
        amount: 1000000n,
        chainId: 1,
        walletAddress: WALLET,
        symbol: "USDC",
        decimals: 6,
      },
    ];

    const destinationToken = {
      token: WBTC_ADDRESS,
      chainId: 999, // Unsupported destination chain
      walletAddress: WALLET,
      symbol: "WBTC",
      decimals: 8,
    };

    await expect(planConsolidation(sourceTokens, destinationToken, [WALLET])).rejects.toThrow("UnsupportedRouteError");
  });

  test("API failure - should throw ExternalAPIError", async () => {
    const sourceTokens: TokenAmount[] = [
      {
        token: ETH_ADDRESS,
        amount: 100000000000000000n,
        chainId: 1,
        walletAddress: WALLET,
        symbol: "ETH",
        decimals: 18,
      },
    ];

    const destinationToken = {
      token: WBTC_ADDRESS,
      chainId: 1,
      walletAddress: WALLET,
      symbol: "WBTC",
      decimals: 18,
    };

    // The real getSwapQuote wraps API failures with this prefix (delora.ts);
    // planning propagates it unchanged so the executor's auto-retry
    // classification still sees it.
    vi.mocked(getSwapQuote).mockRejectedValue(new Error("ExternalAPIError: API unavailable"));

    await expect(planConsolidation(sourceTokens, destinationToken, [WALLET])).rejects.toThrow("ExternalAPIError");
  });

  test("same chain WETH to WBTC - should plan direct swap without going through USDC", async () => {
    const WETH_ADDRESS = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" as Address; // Mainnet WETH

    const sourceTokens: TokenAmount[] = [
      {
        token: WETH_ADDRESS,
        amount: 1000000000000000000n, // 1 WETH
        chainId: 1, // Ethereum
        walletAddress: WALLET,
        symbol: "WETH",
        decimals: 18,
      },
    ];

    const destinationToken = {
      token: WBTC_ADDRESS,
      chainId: 1, // Ethereum (same chain)
      walletAddress: WALLET,
      symbol: "WBTC",
      decimals: 8,
    };

    vi.mocked(getSwapQuote).mockResolvedValue({
      token: WBTC_ADDRESS,
      amount: 3000000n, // 0.03 WBTC
      chainId: 1,
      walletAddress: WALLET,
      symbol: "WBTC",
      decimals: 8,
    });

    const result = await planConsolidation(sourceTokens, destinationToken, [WALLET]);

    // Should only have one swap step (WETH -> WBTC directly)
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("swap");
    expect(result[0].inputTokens[0].token).toBe(WETH_ADDRESS);
    expect(result[0].inputTokens[0].symbol).toBe("WETH");
    expect(result[0].outputToken.token).toBe(WBTC_ADDRESS);
    expect(result[0].outputToken.symbol).toBe("WBTC");

    // Should NOT have any intermediate USDC swap
    expect(getSwapQuote).toHaveBeenCalledTimes(1);
    expect(getSwapQuote).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          token: WETH_ADDRESS,
          symbol: "WETH",
        }),
      ]),
      expect.objectContaining({
        token: WBTC_ADDRESS,
        symbol: "WBTC",
      }),
    );
  });

  test("tokens from different wallets on same chain - should create separate swap steps per wallet", async () => {
    const WALLET2 = "0x9876543210987654321098765432109876543210" as Address;
    const WETH_ADDRESS = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" as Address;

    const sourceTokens: TokenAmount[] = [
      {
        token: WETH_ADDRESS,
        amount: 1000000000000000000n, // 1 WETH from wallet 1
        chainId: 1,
        walletAddress: WALLET,
        symbol: "WETH",
        decimals: 18,
      },
      {
        token: USDC_ADDRESS,
        amount: 500000000n, // 500 USDC from wallet 2
        chainId: 1,
        walletAddress: WALLET2,
        symbol: "USDC",
        decimals: 6,
      },
    ];

    const destinationToken = {
      token: WBTC_ADDRESS,
      chainId: 1,
      walletAddress: WALLET,
      symbol: "WBTC",
      decimals: 8,
    };

    // Mock swap quotes for both wallets
    vi.mocked(getSwapQuote).mockResolvedValue({
      token: WBTC_ADDRESS,
      amount: 2000000n, // 0.02 WBTC
      chainId: 1,
      walletAddress: WALLET,
      symbol: "WBTC",
      decimals: 8,
    });

    const result = await planConsolidation(sourceTokens, destinationToken, [WALLET, WALLET2]);

    // Should have 2 separate swap steps (one per wallet)
    const swapSteps = result.filter((s: TransactionStep) => s.type === "swap");
    expect(swapSteps.length).toBe(2);

    // Each swap should only have tokens from one wallet
    expect(swapSteps[0].inputTokens[0].walletAddress).toBe(WALLET);
    expect(swapSteps[1].inputTokens[0].walletAddress).toBe(WALLET2);

    // Verify each swap was called with tokens from the same wallet
    expect(getSwapQuote).toHaveBeenCalledTimes(2);
    expect(getSwapQuote).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ walletAddress: WALLET })]),
      expect.objectContaining({
        token: WBTC_ADDRESS,
      }),
    );
    expect(getSwapQuote).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ walletAddress: WALLET2 })]),
      expect.objectContaining({
        token: WBTC_ADDRESS,
      }),
    );
  });

  test("invalid input - more than 50 tokens should throw PlanningError", async () => {
    // Create 51 tokens
    const sourceTokens: TokenAmount[] = Array.from({ length: 51 }, (_, _i) => ({
      token: USDC_ADDRESS,
      amount: 1000000n,
      chainId: 1,
      walletAddress: WALLET,
      symbol: "USDC",
      decimals: 6,
    }));

    const destinationToken = {
      token: WBTC_ADDRESS,
      chainId: 1,
      walletAddress: WALLET,
      symbol: "WBTC",
      decimals: 8,
    };

    await expect(planConsolidation(sourceTokens, destinationToken, [WALLET])).rejects.toThrow(
      "PlanningError: Too many source tokens (max 50)",
    );
  });

  test("invalid input - token amount zero should throw PlanningError", async () => {
    const sourceTokens: TokenAmount[] = [
      {
        token: USDC_ADDRESS,
        amount: 0n,
        chainId: 1,
        walletAddress: WALLET,
        symbol: "USDC",
        decimals: 6,
      },
    ];

    const destinationToken = {
      token: WBTC_ADDRESS,
      chainId: 1,
      walletAddress: WALLET,
      symbol: "WBTC",
      decimals: 8,
    };

    await expect(planConsolidation(sourceTokens, destinationToken, [WALLET])).rejects.toThrow(
      "PlanningError: Token amount must be greater than 0",
    );
  });

  test("token already destination token - should skip swap", async () => {
    const sourceTokens: TokenAmount[] = [
      {
        token: WBTC_ADDRESS,
        amount: 10000000n, // 0.1 WBTC already as destination token
        chainId: 1,
        walletAddress: WALLET,
        symbol: "WBTC",
        decimals: 8,
      },
    ];

    const destinationToken = {
      token: WBTC_ADDRESS,
      chainId: 1,
      walletAddress: WALLET,
      symbol: "WBTC",
      decimals: 8,
    };

    const result = await planConsolidation(sourceTokens, destinationToken, [WALLET]);

    // Should have no steps since token is already the destination token
    expect(result).toHaveLength(0);
    expect(getSwapQuote).not.toHaveBeenCalled();
  });

  test("USDC on destination chain with USDC as destination - should skip swap", async () => {
    const logSpy = vi.fn();
    const sourceTokens: TokenAmount[] = [
      {
        token: USDC_ADDRESS,
        amount: 1000000n, // 1 USDC
        chainId: 1,
        walletAddress: WALLET,
        symbol: "USDC",
        decimals: 6,
      },
    ];

    const destinationToken = {
      token: USDC_ADDRESS,
      chainId: 1,
      walletAddress: WALLET,
      symbol: "USDC",
      decimals: 6,
    };

    const result = await planConsolidation(sourceTokens, destinationToken, [WALLET], logSpy);

    // Should have no steps since token is already USDC on destination chain
    expect(result).toHaveLength(0);
    expect(getSwapQuote).not.toHaveBeenCalled();

    // Verify that the function recognized the token is already correct
    const logCalls = logSpy.mock.calls.flat().join(" ");
    expect(logCalls).toContain("already at destination");
  });

  test("multiple wallets on same chain - should create one bridge step per wallet", async () => {
    const WALLET_1 = "0x1111111111111111111111111111111111111111" as Address;
    const WALLET_2 = "0x2222222222222222222222222222222222222222" as Address;
    const WALLET_3 = "0x3333333333333333333333333333333333333333" as Address;

    // Simple scenario: 3 wallets, each with USDC on Optimism, bridging to Ethereum
    const sourceTokens: TokenAmount[] = [
      {
        token: USDC_OPTIMISM,
        amount: 1000000n, // 1 USDC
        chainId: 10, // Optimism
        walletAddress: WALLET_1,
        symbol: "USDC",
        decimals: 6,
      },
      {
        token: USDC_OPTIMISM,
        amount: 2000000n, // 2 USDC
        chainId: 10, // Optimism
        walletAddress: WALLET_2,
        symbol: "USDC",
        decimals: 6,
      },
      {
        token: USDC_OPTIMISM,
        amount: 3000000n, // 3 USDC
        chainId: 10, // Optimism
        walletAddress: WALLET_3,
        symbol: "USDC",
        decimals: 6,
      },
    ];

    const destinationToken = {
      token: WBTC_ADDRESS,
      chainId: 1, // Ethereum
      walletAddress: WALLET,
      symbol: "WBTC",
      decimals: 8,
    };

    // Mock final swap USDC -> WBTC on Ethereum
    vi.mocked(getSwapQuote).mockResolvedValue({
      token: WBTC_ADDRESS,
      amount: 8000n,
      chainId: 1,
      walletAddress: WALLET,
      symbol: "WBTC",
      decimals: 8,
    });

    vi.mocked(getBridgeFee).mockResolvedValue(0n);

    const result = await planConsolidation(sourceTokens, destinationToken, [WALLET, WALLET_1, WALLET_2, WALLET_3]);

    // Find all bridge steps
    const bridgeSteps = result.filter((s: TransactionStep) => s.type === "bridge");

    // Should have 3 bridge steps, one per wallet
    expect(bridgeSteps.length).toBe(3);

    // Verify each wallet has its own bridge step with correct amounts
    const wallet1BridgeStep = bridgeSteps.find((s: TransactionStep) => s.inputTokens[0].walletAddress === WALLET_1);
    const wallet2BridgeStep = bridgeSteps.find((s: TransactionStep) => s.inputTokens[0].walletAddress === WALLET_2);
    const wallet3BridgeStep = bridgeSteps.find((s: TransactionStep) => s.inputTokens[0].walletAddress === WALLET_3);

    expect(wallet1BridgeStep).toBeDefined();
    expect(wallet2BridgeStep).toBeDefined();
    expect(wallet3BridgeStep).toBeDefined();

    // Verify WALLET_1 bridges its USDC (1 USDC)
    expect(wallet1BridgeStep?.inputTokens[0].amount).toBe(1000000n);
    expect(wallet1BridgeStep?.outputToken.amount).toBe(1000000n);
    expect(wallet1BridgeStep?.chainId).toBe(10);

    // Verify WALLET_2 bridges its USDC (2 USDC)
    expect(wallet2BridgeStep?.inputTokens[0].amount).toBe(2000000n);
    expect(wallet2BridgeStep?.outputToken.amount).toBe(2000000n);
    expect(wallet2BridgeStep?.chainId).toBe(10);

    // Verify WALLET_3 bridges its USDC (3 USDC)
    expect(wallet3BridgeStep?.inputTokens[0].amount).toBe(3000000n);
    expect(wallet3BridgeStep?.outputToken.amount).toBe(3000000n);
    expect(wallet3BridgeStep?.chainId).toBe(10);

    // Verify attestation has inputs from all 3 bridge steps (via provenance)
    const attestationStep = result.find((s: TransactionStep) => s.type === "attestation");
    expect(attestationStep?.inputTokens.length).toBe(3);
    expect(attestationStep?.inputTokens[0].provenance).toBe(wallet1BridgeStep?.id);
    expect(attestationStep?.inputTokens[1].provenance).toBe(wallet2BridgeStep?.id);
    expect(attestationStep?.inputTokens[2].provenance).toBe(wallet3BridgeStep?.id);
  });

  test("provenance tracking - swap outputs should have provenance set", async () => {
    const sourceTokens: TokenAmount[] = [
      {
        token: ETH_ADDRESS,
        amount: 1000000000000000000n, // 1 ETH
        chainId: 1,
        walletAddress: WALLET,
        symbol: "ETH",
        decimals: 18,
      },
    ];

    const destinationToken = {
      token: USDC_ADDRESS,
      chainId: 1,
      walletAddress: WALLET,
      symbol: "USDC",
      decimals: 6,
    };

    vi.mocked(getSwapQuote).mockResolvedValue({
      token: USDC_ADDRESS,
      amount: 3000000000n, // 3000 USDC
      chainId: 1,
      walletAddress: WALLET,
      symbol: "USDC",
      decimals: 6,
    });

    const result = await planConsolidation(sourceTokens, destinationToken, [WALLET]);

    const swapStep = result.find((s) => s.type === "swap");
    expect(swapStep).toBeDefined();
    expect(swapStep?.outputToken.provenance).toBe(swapStep?.id);
  });

  test("provenance tracking - bridge outputs should have provenance set", async () => {
    const sourceTokens: TokenAmount[] = [
      {
        token: USDC_OPTIMISM, // Use Optimism USDC address
        amount: 1000000n, // 1 USDC on Optimism
        chainId: 10,
        walletAddress: WALLET,
        symbol: "USDC",
        decimals: 6,
      },
    ];

    const destinationToken = {
      token: USDC_ADDRESS, // Ethereum USDC
      chainId: 1, // Ethereum
      walletAddress: WALLET,
      symbol: "USDC",
      decimals: 6,
    };

    vi.mocked(getBridgeFee).mockResolvedValue(100n);

    const result = await planConsolidation(sourceTokens, destinationToken, [WALLET]);

    const bridgeStep = result.find((s) => s.type === "bridge");
    expect(bridgeStep).toBeDefined();
    expect(bridgeStep?.outputToken.provenance).toBe(bridgeStep?.id);
  });

  test("provenance tracking - claim outputs should have provenance set", async () => {
    const sourceTokens: TokenAmount[] = [
      {
        token: USDC_OPTIMISM, // Use Optimism USDC address
        amount: 1000000n,
        chainId: 10, // Optimism
        walletAddress: WALLET,
        symbol: "USDC",
        decimals: 6,
      },
    ];

    const destinationToken = {
      token: USDC_ADDRESS, // Ethereum USDC
      chainId: 1, // Ethereum
      walletAddress: WALLET,
      symbol: "USDC",
      decimals: 6,
    };

    vi.mocked(getBridgeFee).mockResolvedValue(100n);

    const result = await planConsolidation(sourceTokens, destinationToken, [WALLET]);

    const claimStep = result.find((s) => s.type === "claim");
    expect(claimStep).toBeDefined();
    expect(claimStep?.outputToken.provenance).toBe(claimStep?.id);
  });

  test("provenance tracking - bridge should preserve provenance from swap outputs", async () => {
    const sourceTokens: TokenAmount[] = [
      {
        token: ETH_ADDRESS,
        amount: 1000000000000000000n, // 1 ETH
        chainId: 137, // Polygon
        walletAddress: WALLET,
        symbol: "POL",
        decimals: 18,
      },
    ];

    const destinationToken = {
      token: USDC_ADDRESS,
      chainId: 1, // Ethereum
      walletAddress: WALLET,
      symbol: "USDC",
      decimals: 6,
    };

    // Mock swap ETH -> USDC
    vi.mocked(getSwapQuote).mockResolvedValue({
      token: USDC_ADDRESS,
      amount: 3000000000n, // 3000 USDC
      chainId: 137,
      walletAddress: WALLET,
      symbol: "USDC",
      decimals: 6,
    });

    vi.mocked(getBridgeFee).mockResolvedValue(1000000n); // 1 USDC fee

    const result = await planConsolidation(sourceTokens, destinationToken, [WALLET]);

    const swapStep = result.find((s) => s.type === "swap");
    const bridgeStep = result.find((s) => s.type === "bridge");

    expect(swapStep).toBeDefined();
    expect(bridgeStep).toBeDefined();

    // Bridge input should have provenance from swap
    expect(bridgeStep?.inputTokens[0].provenance).toBe(swapStep?.id);
  });

  test("provenance tracking - existing USDC should not have provenance", async () => {
    const sourceTokens: TokenAmount[] = [
      {
        token: USDC_OPTIMISM, // Use Optimism USDC address
        amount: 1000000n, // 1 USDC already on source chain
        chainId: 10, // Optimism
        walletAddress: WALLET,
        symbol: "USDC",
        decimals: 6,
      },
    ];

    const destinationToken = {
      token: USDC_ADDRESS, // Ethereum USDC
      chainId: 1, // Ethereum
      walletAddress: WALLET,
      symbol: "USDC",
      decimals: 6,
    };

    vi.mocked(getBridgeFee).mockResolvedValue(100n);

    const result = await planConsolidation(sourceTokens, destinationToken, [WALLET]);

    const bridgeStep = result.find((s) => s.type === "bridge");

    expect(bridgeStep).toBeDefined();
    // Existing USDC should not have provenance (it didn't come from a step)
    expect(bridgeStep?.inputTokens[0].provenance).toBeUndefined();
  });

  test("provenance tracking - complex multi-step provenance chain", async () => {
    // Test: ETH -> USDC (swap) -> bridge -> claim -> WBTC (swap)
    // Verify provenance flows through entire chain
    const sourceTokens: TokenAmount[] = [
      {
        token: ETH_ADDRESS,
        amount: 1000000000000000000n, // 1 POL
        chainId: 137, // Polygon
        walletAddress: WALLET,
        symbol: "POL",
        decimals: 18,
      },
    ];

    const destinationToken = {
      token: WBTC_ADDRESS,
      chainId: 1, // Ethereum
      walletAddress: WALLET,
      symbol: "WBTC",
      decimals: 8,
    };

    // Mock swap POL -> USDC on Polygon
    vi.mocked(getSwapQuote).mockResolvedValueOnce({
      token: USDC_ADDRESS,
      amount: 3000000000n, // 3000 USDC
      chainId: 137,
      walletAddress: WALLET,
      symbol: "USDC",
      decimals: 6,
    });

    // Mock final swap USDC -> WBTC on Ethereum
    vi.mocked(getSwapQuote).mockResolvedValueOnce({
      token: WBTC_ADDRESS,
      amount: 8000n,
      chainId: 1,
      walletAddress: WALLET,
      symbol: "WBTC",
      decimals: 8,
    });

    vi.mocked(getBridgeFee).mockResolvedValue(0n);

    const result = await planConsolidation(sourceTokens, destinationToken, [WALLET]);

    const swapStep1 = result.find((s) => s.type === "swap" && s.chainId === 137);
    const bridgeStep = result.find((s) => s.type === "bridge");
    const claimStep = result.find((s) => s.type === "claim");
    const swapStep2 = result.find((s) => s.type === "swap" && s.chainId === 1);

    expect(swapStep1).toBeDefined();
    expect(bridgeStep).toBeDefined();
    expect(claimStep).toBeDefined();
    expect(swapStep2).toBeDefined();

    // Verify provenance chain
    // 1. First swap output has its own provenance
    expect(swapStep1?.outputToken.provenance).toBe(swapStep1?.id);

    // 2. Bridge input inherits provenance from swap output
    expect(bridgeStep?.inputTokens[0].provenance).toBe(swapStep1?.id);

    // 3. Bridge output has its own provenance
    expect(bridgeStep?.outputToken.provenance).toBe(bridgeStep?.id);

    // 4. Claim input inherits provenance from bridge output
    expect(claimStep?.inputTokens[0].provenance).toBe(bridgeStep?.id);

    // 5. Claim output has its own provenance
    expect(claimStep?.outputToken.provenance).toBe(claimStep?.id);

    // 6. Final swap input inherits provenance from claim output
    expect(swapStep2?.inputTokens[0].provenance).toBe(claimStep?.id);

    // 7. Final swap output has its own provenance
    expect(swapStep2?.outputToken.provenance).toBe(swapStep2?.id);
  });

  test("provenance tracking - multiple bridges from different wallets", async () => {
    const WALLET_2 = "0x2222222222222222222222222222222222222222" as Address;
    const WALLET_3 = "0x3333333333333333333333333333333333333333" as Address;

    const sourceTokens: TokenAmount[] = [
      {
        token: ETH_ADDRESS,
        amount: 1000000000000000000n, // 1 POL from wallet 1
        chainId: 137,
        walletAddress: WALLET,
        symbol: "POL",
        decimals: 18,
      },
      {
        token: USDC_OPTIMISM,
        amount: 500000000n, // 500 USDC from wallet 2
        chainId: 10,
        walletAddress: WALLET_2,
        symbol: "USDC",
        decimals: 6,
      },
      {
        token: USDC_OPTIMISM,
        amount: 300000000n, // 300 USDC from wallet 3
        chainId: 10,
        walletAddress: WALLET_3,
        symbol: "USDC",
        decimals: 6,
      },
    ];

    const destinationToken = {
      token: WBTC_ADDRESS,
      chainId: 1,
      walletAddress: WALLET,
      symbol: "WBTC",
      decimals: 8,
    };

    // Mock swap POL -> USDC
    vi.mocked(getSwapQuote).mockResolvedValueOnce({
      token: USDC_ADDRESS,
      amount: 2000000000n,
      chainId: 137,
      walletAddress: WALLET,
      symbol: "USDC",
      decimals: 6,
    });

    // Mock final swap
    vi.mocked(getSwapQuote).mockResolvedValueOnce({
      token: WBTC_ADDRESS,
      amount: 8000n,
      chainId: 1,
      walletAddress: WALLET,
      symbol: "WBTC",
      decimals: 8,
    });

    vi.mocked(getBridgeFee).mockResolvedValue(0n);

    const result = await planConsolidation(sourceTokens, destinationToken, [WALLET, WALLET_2, WALLET_3]);

    const swapStep = result.find((s) => s.type === "swap" && s.chainId === 137);
    const bridges = result.filter((s) => s.type === "bridge");
    const claimStep = result.find((s) => s.type === "claim");

    // Find bridges by wallet
    const bridge1 = bridges.find((b) => b.inputTokens[0].walletAddress === WALLET);
    const bridge2 = bridges.find((b) => b.inputTokens[0].walletAddress === WALLET_2);
    const bridge3 = bridges.find((b) => b.inputTokens[0].walletAddress === WALLET_3);

    expect(swapStep).toBeDefined();
    expect(bridge1).toBeDefined();
    expect(bridge2).toBeDefined();
    expect(bridge3).toBeDefined();
    expect(claimStep).toBeDefined();

    // Bridge 1 input should have provenance from swap
    expect(bridge1?.inputTokens[0].provenance).toBe(swapStep?.id);

    // Bridge 2 input should NOT have provenance (existing USDC)
    expect(bridge2?.inputTokens[0].provenance).toBeUndefined();

    // Bridge 3 input should NOT have provenance (existing USDC)
    expect(bridge3?.inputTokens[0].provenance).toBeUndefined();

    // All bridges should have their own provenance on output
    expect(bridge1?.outputToken.provenance).toBe(bridge1?.id);
    expect(bridge2?.outputToken.provenance).toBe(bridge2?.id);
    expect(bridge3?.outputToken.provenance).toBe(bridge3?.id);

    // Claim should have all three bridge provenances in its inputs
    expect(claimStep?.inputTokens).toHaveLength(3);
    expect(claimStep?.inputTokens[0].provenance).toBe(bridge1?.id);
    expect(claimStep?.inputTokens[1].provenance).toBe(bridge2?.id);
    expect(claimStep?.inputTokens[2].provenance).toBe(bridge3?.id);
  });

  test("provenance tracking - transfer step should have provenance", async () => {
    const WALLET_2 = "0x2222222222222222222222222222222222222222" as Address;

    // Scenario: Token already at destination token/chain but wrong wallet
    // This creates a single transfer step without swap
    const sourceTokens: TokenAmount[] = [
      {
        token: WBTC_ADDRESS,
        amount: 10000000n, // 0.1 WBTC
        chainId: 1,
        walletAddress: WALLET_2, // Different wallet than destination
        symbol: "WBTC",
        decimals: 8,
      },
    ];

    const destinationToken = {
      token: WBTC_ADDRESS,
      chainId: 1,
      walletAddress: WALLET, // Destination wallet
      symbol: "WBTC",
      decimals: 8,
    };

    const result = await planConsolidation(sourceTokens, destinationToken, [WALLET, WALLET_2]);

    const transferStep = result.find((s) => s.type === "transfer");

    expect(transferStep).toBeDefined();

    // Transfer input should NOT have provenance (existing token, not from a step)
    expect(transferStep?.inputTokens[0].provenance).toBeUndefined();

    // Transfer output has its own provenance
    expect(transferStep?.outputToken.provenance).toBe(transferStep?.id);
  });

  test("provenance tracking - per-token swaps should each have unique provenance", async () => {
    // Create 8 tokens on the same chain, one swap step each
    const sourceTokens: TokenAmount[] = Array.from({ length: 8 }, (_, i) => ({
      token: `0x${i.toString().padStart(40, "0")}` as Address,
      amount: 1000000n,
      chainId: 1,
      walletAddress: WALLET,
      symbol: `TOKEN${i}`,
      decimals: 18,
    }));

    const destinationToken = {
      token: WBTC_ADDRESS,
      chainId: 1,
      walletAddress: WALLET,
      symbol: "WBTC",
      decimals: 8,
    };

    vi.mocked(getSwapQuote).mockResolvedValue({
      token: WBTC_ADDRESS,
      amount: 8000n,
      chainId: 1,
      walletAddress: WALLET,
      symbol: "WBTC",
      decimals: 8,
    });

    const result = await planConsolidation(sourceTokens, destinationToken, [WALLET]);

    const swapSteps = result.filter((s) => s.type === "swap");

    // One swap step per token
    expect(swapSteps).toHaveLength(8);

    // Each swap should have unique provenance
    for (const step of swapSteps) {
      expect(step.outputToken.provenance).toBe(step.id);
    }
    expect(new Set(swapSteps.map((s) => s.id)).size).toBe(swapSteps.length);
  });

  test("transfer step - destination token at wrong wallet should create transfer step", async () => {
    const WALLET_2 = "0x2222222222222222222222222222222222222222" as Address;

    const sourceTokens: TokenAmount[] = [
      {
        token: WBTC_ADDRESS,
        amount: 10000000n, // 0.1 WBTC already as destination token but in different wallet
        chainId: 1, // Ethereum (destination chain)
        walletAddress: WALLET_2, // Different wallet
        symbol: "WBTC",
        decimals: 8,
      },
    ];

    const destinationToken = {
      token: WBTC_ADDRESS,
      chainId: 1, // Ethereum
      walletAddress: WALLET, // Destination wallet
      symbol: "WBTC",
      decimals: 8,
    };

    const result = await planConsolidation(sourceTokens, destinationToken, [WALLET, WALLET_2]);

    // Should have exactly one transfer step
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("transfer");

    // Verify transfer step details
    const transferStep = result[0];
    expect(transferStep.chainId).toBe(1);
    expect(transferStep.inputTokens).toHaveLength(1);
    expect(transferStep.inputTokens[0].walletAddress).toBe(WALLET_2);
    expect(transferStep.inputTokens[0].token).toBe(WBTC_ADDRESS);
    expect(transferStep.inputTokens[0].amount).toBe(10000000n);

    // Output should be at destination wallet
    expect(transferStep.outputToken.walletAddress).toBe(WALLET);
    expect(transferStep.outputToken.token).toBe(WBTC_ADDRESS);
    expect(transferStep.outputToken.amount).toBe(10000000n);

    // No swap calls should be made
    expect(getSwapQuote).not.toHaveBeenCalled();
  });

  test("transfer step - multiple wallets with destination token should create multiple transfer steps", async () => {
    const WALLET_2 = "0x2222222222222222222222222222222222222222" as Address;
    const WALLET_3 = "0x3333333333333333333333333333333333333333" as Address;

    const sourceTokens: TokenAmount[] = [
      {
        token: WBTC_ADDRESS,
        amount: 10000000n, // 0.1 WBTC in wallet 2
        chainId: 1,
        walletAddress: WALLET_2,
        symbol: "WBTC",
        decimals: 8,
      },
      {
        token: WBTC_ADDRESS,
        amount: 20000000n, // 0.2 WBTC in wallet 3
        chainId: 1,
        walletAddress: WALLET_3,
        symbol: "WBTC",
        decimals: 8,
      },
    ];

    const destinationToken = {
      token: WBTC_ADDRESS,
      chainId: 1,
      walletAddress: WALLET, // Different from source wallets
      symbol: "WBTC",
      decimals: 8,
    };

    const result = await planConsolidation(sourceTokens, destinationToken, [WALLET, WALLET_2, WALLET_3]);

    // Should have two transfer steps
    const transferSteps = result.filter((s: TransactionStep) => s.type === "transfer");
    expect(transferSteps).toHaveLength(2);

    // Verify each wallet has its transfer step
    const wallet2Transfer = transferSteps.find((s: TransactionStep) => s.inputTokens[0].walletAddress === WALLET_2);
    const wallet3Transfer = transferSteps.find((s: TransactionStep) => s.inputTokens[0].walletAddress === WALLET_3);

    expect(wallet2Transfer).toBeDefined();
    expect(wallet3Transfer).toBeDefined();

    // Verify wallet 2 transfer
    expect(wallet2Transfer?.inputTokens[0].amount).toBe(10000000n);
    expect(wallet2Transfer?.outputToken.walletAddress).toBe(WALLET);
    expect(wallet2Transfer?.outputToken.amount).toBe(10000000n);

    // Verify wallet 3 transfer
    expect(wallet3Transfer?.inputTokens[0].amount).toBe(20000000n);
    expect(wallet3Transfer?.outputToken.walletAddress).toBe(WALLET);
    expect(wallet3Transfer?.outputToken.amount).toBe(20000000n);

    // No swaps should be called
    expect(getSwapQuote).not.toHaveBeenCalled();
  });

  test("transfer step - mix of tokens needing swap and transfer", async () => {
    const WALLET_2 = "0x2222222222222222222222222222222222222222" as Address;

    const sourceTokens: TokenAmount[] = [
      {
        token: USDC_ADDRESS,
        amount: 1000000n, // 1 USDC in wallet 1 - needs swap
        chainId: 1,
        walletAddress: WALLET,
        symbol: "USDC",
        decimals: 6,
      },
      {
        token: WBTC_ADDRESS,
        amount: 10000000n, // 0.1 WBTC in wallet 2 - needs transfer
        chainId: 1,
        walletAddress: WALLET_2,
        symbol: "WBTC",
        decimals: 8,
      },
    ];

    const destinationToken = {
      token: WBTC_ADDRESS,
      chainId: 1,
      walletAddress: WALLET, // Destination wallet
      symbol: "WBTC",
      decimals: 8,
    };

    vi.mocked(getSwapQuote).mockResolvedValue({
      token: WBTC_ADDRESS,
      amount: 5000000n, // 0.05 WBTC
      chainId: 1,
      walletAddress: WALLET,
      symbol: "WBTC",
      decimals: 8,
    });

    const result = await planConsolidation(sourceTokens, destinationToken, [WALLET, WALLET_2]);

    // Should have one swap and one transfer
    const swapSteps = result.filter((s: TransactionStep) => s.type === "swap");
    const transferSteps = result.filter((s: TransactionStep) => s.type === "transfer");

    expect(swapSteps).toHaveLength(1);
    expect(transferSteps).toHaveLength(1);

    // Verify swap (USDC -> WBTC at wallet 1)
    expect(swapSteps[0].inputTokens[0].token).toBe(USDC_ADDRESS);
    expect(swapSteps[0].inputTokens[0].walletAddress).toBe(WALLET);
    expect(swapSteps[0].outputToken.token).toBe(WBTC_ADDRESS);
    expect(swapSteps[0].outputToken.walletAddress).toBe(WALLET);

    // Verify transfer (WBTC from wallet 2 to wallet 1)
    expect(transferSteps[0].inputTokens[0].token).toBe(WBTC_ADDRESS);
    expect(transferSteps[0].inputTokens[0].walletAddress).toBe(WALLET_2);
    expect(transferSteps[0].outputToken.walletAddress).toBe(WALLET);

    // Verify swap was called
    expect(getSwapQuote).toHaveBeenCalledTimes(1);
  });

  test("swap from different wallet on same chain - should output to destination wallet", async () => {
    const WALLET_2 = "0x2222222222222222222222222222222222222222" as Address;

    const sourceTokens: TokenAmount[] = [
      {
        token: USDC_ADDRESS,
        amount: 1000000n, // 1 USDC in wallet 2 on destination chain
        chainId: 1, // Same as destination chain
        walletAddress: WALLET_2, // Different wallet
        symbol: "USDC",
        decimals: 6,
      },
    ];

    const destinationToken = {
      token: WBTC_ADDRESS,
      chainId: 1, // Ethereum
      walletAddress: WALLET, // Destination wallet
      symbol: "WBTC",
      decimals: 8,
    };

    vi.mocked(getSwapQuote).mockResolvedValue({
      token: WBTC_ADDRESS,
      amount: 5000000n, // 0.05 WBTC
      chainId: 1,
      walletAddress: WALLET,
      symbol: "WBTC",
      decimals: 8,
    });

    const result = await planConsolidation(sourceTokens, destinationToken, [WALLET, WALLET_2]);

    // Should have exactly one swap step
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("swap");

    // Verify swap input is from wallet 2
    expect(result[0].inputTokens[0].walletAddress).toBe(WALLET_2);
    expect(result[0].inputTokens[0].token).toBe(USDC_ADDRESS);

    // CRITICAL: Verify swap output goes to DESTINATION wallet (WALLET), not source wallet (WALLET_2)
    expect(result[0].outputToken.walletAddress).toBe(WALLET);
    expect(result[0].outputToken.token).toBe(WBTC_ADDRESS);
  });

  test("swap after bridge/claim - should output to destination wallet", async () => {
    const WALLET_2 = "0x2222222222222222222222222222222222222222" as Address;

    const sourceTokens: TokenAmount[] = [
      {
        token: USDC_OPTIMISM, // USDC on Optimism
        amount: 1000000n,
        chainId: 10, // Optimism
        walletAddress: WALLET_2, // From wallet 2
        symbol: "USDC",
        decimals: 6,
      },
    ];

    const destinationToken = {
      token: WBTC_ADDRESS,
      chainId: 1, // Ethereum
      walletAddress: WALLET, // Destination wallet (different from source)
      symbol: "WBTC",
      decimals: 8,
    };

    vi.mocked(getBridgeFee).mockResolvedValue(0n);

    // Mock final swap USDC -> WBTC on Ethereum
    vi.mocked(getSwapQuote).mockResolvedValue({
      token: WBTC_ADDRESS,
      amount: 8000n,
      chainId: 1,
      walletAddress: WALLET, // Quote returns destination wallet (simulating getSwapQuote behavior)
      symbol: "WBTC",
      decimals: 8,
    });

    const result = await planConsolidation(sourceTokens, destinationToken, [WALLET, WALLET_2]);

    // Find the final swap step (after claim)
    const claimStep = result.find((s: TransactionStep) => s.type === "claim");
    const swapSteps = result.filter((s: TransactionStep) => s.type === "swap");

    expect(claimStep).toBeDefined();
    expect(swapSteps.length).toBeGreaterThan(0);

    // Find swap that has input with provenance from claim
    const finalSwap = swapSteps.find((s: TransactionStep) =>
      s.inputTokens.some((token) => token.provenance === claimStep?.id),
    );
    expect(finalSwap).toBeDefined();

    // CRITICAL: Verify final swap output goes to DESTINATION wallet
    expect(finalSwap?.outputToken.walletAddress).toBe(WALLET);
    expect(finalSwap?.outputToken.token).toBe(WBTC_ADDRESS);
  });

  test("bridge to non-connected destination wallet - should add post-claim transfer", async () => {
    const NON_CONNECTED_WALLET = "0x4444444444444444444444444444444444444444" as Address;

    const sourceTokens: TokenAmount[] = [
      {
        token: USDC_ADDRESS,
        amount: 2000000n,
        chainId: 1,
        walletAddress: WALLET,
        symbol: "USDC",
        decimals: 6,
      },
    ];

    const destinationToken = {
      token: USDC_OPTIMISM,
      chainId: 10,
      walletAddress: NON_CONNECTED_WALLET,
      symbol: "USDC",
      decimals: 6,
    };

    vi.mocked(getBridgeFee).mockResolvedValue(0n);

    const result = await planConsolidation(sourceTokens, destinationToken, [WALLET]);

    const bridgeStep = result.find((s: TransactionStep) => s.type === "bridge");
    const claimStep = result.find((s: TransactionStep) => s.type === "claim");
    const transferStep = result.find(
      (s: TransactionStep) => s.type === "transfer" && s.outputToken.walletAddress === NON_CONNECTED_WALLET,
    );

    expect(bridgeStep).toBeDefined();
    expect(claimStep).toBeDefined();
    expect(transferStep).toBeDefined();

    if (!bridgeStep || !claimStep || !transferStep) {
      return;
    }

    expect(bridgeStep.outputToken.walletAddress).toBe(WALLET);
    expect(claimStep.outputToken.walletAddress).toBe(WALLET);
    expect(transferStep.inputTokens[0].walletAddress).toBe(WALLET);
    // Transfer input should have provenance from claim step
    expect(transferStep.inputTokens[0].provenance).toBe(claimStep.id);
  });

  test("swap before bridge - should output to SOURCE wallet (not destination wallet)", async () => {
    const WALLET_2 = "0x2222222222222222222222222222222222222222" as Address;
    const POLYGON_USDC = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359" as Address;

    const sourceTokens: TokenAmount[] = [
      {
        token: ETH_ADDRESS, // Non-USDC token on Polygon
        amount: 1000000000000000000n, // 1 POL
        chainId: 137, // Polygon (non-destination chain)
        walletAddress: WALLET_2, // From wallet 2
        symbol: "POL",
        decimals: 18,
      },
    ];

    const destinationToken = {
      token: WBTC_ADDRESS,
      chainId: 1, // Ethereum (different chain)
      walletAddress: WALLET, // Destination wallet (different from source)
      symbol: "WBTC",
      decimals: 8,
    };

    // Mock swap POL -> USDC on Polygon (before bridging)
    vi.mocked(getSwapQuote).mockResolvedValueOnce({
      token: POLYGON_USDC,
      amount: 3000000000n, // 3000 USDC
      chainId: 137,
      walletAddress: WALLET_2, // Quote returns source wallet
      symbol: "USDC",
      decimals: 6,
    });

    // Mock final swap USDC -> WBTC on Ethereum (after bridging)
    vi.mocked(getSwapQuote).mockResolvedValueOnce({
      token: WBTC_ADDRESS,
      amount: 8000n,
      chainId: 1,
      walletAddress: WALLET,
      symbol: "WBTC",
      decimals: 8,
    });

    vi.mocked(getBridgeFee).mockResolvedValue(0n);

    const result = await planConsolidation(sourceTokens, destinationToken, [WALLET, WALLET_2]);

    // Find the swap step BEFORE bridge (swap POL to USDC on Polygon)
    const swapBeforeBridge = result.find((s: TransactionStep) => s.type === "swap" && s.chainId === 137);
    const bridgeStep = result.find((s: TransactionStep) => s.type === "bridge");

    expect(swapBeforeBridge).toBeDefined();
    expect(bridgeStep).toBeDefined();

    // CRITICAL: Verify swap before bridge outputs to SOURCE wallet (WALLET_2), NOT destination wallet (WALLET)
    // This is essential because the bridge step needs to take tokens from WALLET_2 on Polygon
    expect(swapBeforeBridge?.outputToken.walletAddress).toBe(WALLET_2);
    expect(swapBeforeBridge?.outputToken.token).toBe(POLYGON_USDC);

    // Bridge should take from source wallet
    expect(bridgeStep?.inputTokens[0].walletAddress).toBe(WALLET_2);
    expect(bridgeStep?.chainId).toBe(137); // Bridge happens on source chain

    // Bridge output should go to destination wallet
    expect(bridgeStep?.outputToken.walletAddress).toBe(WALLET);
  });

  test("bridge and swap to non-connected destination wallet - should add post-claim transfer", async () => {
    const NON_CONNECTED_WALLET = "0x4444444444444444444444444444444444444444" as Address;

    const sourceTokens: TokenAmount[] = [
      {
        token: USDC_OPTIMISM,
        amount: 1000000n, // 1 USDC
        chainId: 10, // Optimism
        walletAddress: WALLET,
        symbol: "USDC",
        decimals: 6,
      },
    ];

    const destinationToken = {
      token: WBTC_ADDRESS,
      chainId: 1, // Ethereum
      walletAddress: NON_CONNECTED_WALLET, // Not in connected wallets
      symbol: "WBTC",
      decimals: 8,
    };

    vi.mocked(getBridgeFee).mockResolvedValue(0n);

    // Mock final swap USDC -> WBTC on Ethereum
    vi.mocked(getSwapQuote).mockResolvedValue({
      token: WBTC_ADDRESS,
      amount: 8000n,
      chainId: 1,
      walletAddress: WALLET, // Intermediate wallet (not non-connected wallet)
      symbol: "WBTC",
      decimals: 8,
    });

    const result = await planConsolidation(sourceTokens, destinationToken, [WALLET]);

    const bridgeStep = result.find((s: TransactionStep) => s.type === "bridge");
    const claimStep = result.find((s: TransactionStep) => s.type === "claim");
    const swapStep = result.find((s: TransactionStep) => s.type === "swap");
    const transferStep = result.find(
      (s: TransactionStep) => s.type === "transfer" && s.outputToken.walletAddress === NON_CONNECTED_WALLET,
    );

    expect(bridgeStep).toBeDefined();
    expect(claimStep).toBeDefined();
    expect(swapStep).toBeDefined();

    if (!bridgeStep || !claimStep || !swapStep) {
      return;
    }

    // Bridge and claim should output to intermediate wallet (WALLET)
    expect(bridgeStep.outputToken.walletAddress).toBe(WALLET);
    expect(claimStep.outputToken.walletAddress).toBe(WALLET);

    // CRITICAL: Swap should output to INTERMEDIATE wallet, not directly to non-connected wallet
    expect(swapStep.outputToken.walletAddress).toBe(WALLET);

    // CRITICAL: There should be a transfer step to move tokens to non-connected wallet
    expect(transferStep).toBeDefined();
    if (transferStep) {
      expect(transferStep.inputTokens[0].walletAddress).toBe(WALLET);
      expect(transferStep.outputToken.walletAddress).toBe(NON_CONNECTED_WALLET);
      expect(transferStep.inputTokens[0].provenance).toBe(swapStep.id);
    }
  });

  test("no connected wallet has gas on destination chain - should throw PlanningError", async () => {
    const { getNativeBalance } = await import("./gas");
    const NON_CONNECTED_WALLET = "0x4444444444444444444444444444444444444444" as Address;
    const WALLET_2 = "0x2222222222222222222222222222222222222222" as Address;

    const sourceTokens: TokenAmount[] = [
      {
        token: USDC_OPTIMISM,
        amount: 1000000n,
        chainId: 10, // Optimism
        walletAddress: WALLET_2,
        symbol: "USDC",
        decimals: 6,
      },
    ];

    const destinationToken = {
      token: WBTC_ADDRESS,
      chainId: 1, // Ethereum
      walletAddress: NON_CONNECTED_WALLET, // Not in connected wallets
      symbol: "WBTC",
      decimals: 8,
    };

    // Mock getNativeBalance to return 0 for all wallets on destination chain (no gas)
    vi.mocked(getNativeBalance).mockResolvedValue(0n);

    vi.mocked(getBridgeFee).mockResolvedValue(0n);

    await expect(planConsolidation(sourceTokens, destinationToken, [WALLET, WALLET_2])).rejects.toThrow(
      "PlanningError",
    );

    // Restore default mock
    vi.mocked(getNativeBalance).mockResolvedValue(1000000000000000000n);
  });

  test("simple transfer to non-connected wallet - same chain same token", async () => {
    const NON_CONNECTED_WALLET = "0x4444444444444444444444444444444444444444" as Address;

    const sourceTokens: TokenAmount[] = [
      {
        token: WBTC_ADDRESS,
        amount: 10000000n, // 0.1 WBTC
        chainId: 1, // Ethereum
        walletAddress: WALLET, // From connected wallet
        symbol: "WBTC",
        decimals: 8,
      },
    ];

    const destinationToken = {
      token: WBTC_ADDRESS,
      chainId: 1, // Ethereum (same chain)
      walletAddress: NON_CONNECTED_WALLET, // Non-connected wallet
      symbol: "WBTC",
      decimals: 8,
    };

    const result = await planConsolidation(sourceTokens, destinationToken, [WALLET]);

    // Should have exactly one transfer step
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("transfer");

    // Verify transfer step details
    const transferStep = result[0];
    expect(transferStep.chainId).toBe(1);
    expect(transferStep.inputTokens).toHaveLength(1);
    expect(transferStep.inputTokens[0].walletAddress).toBe(WALLET);
    expect(transferStep.inputTokens[0].token).toBe(WBTC_ADDRESS);
    expect(transferStep.inputTokens[0].amount).toBe(10000000n);

    // Output should be at non-connected wallet
    expect(transferStep.outputToken.walletAddress).toBe(NON_CONNECTED_WALLET);
    expect(transferStep.outputToken.token).toBe(WBTC_ADDRESS);
    expect(transferStep.outputToken.amount).toBe(10000000n);

    // No swap calls should be made
    expect(getSwapQuote).not.toHaveBeenCalled();
  });

  test("regression: consolidation with mixed sources (bridge + swap + existing) preserves all amounts in final transfer", async () => {
    // Regression test for bug where final transfer only included swap amount, not bridge+existing amounts
    // Scenario: wBTC (arbitrum) + usdc (polygon) + usdc (arbitrum) → usdc (arbitrum, different wallet)
    const NON_CONNECTED_WALLET = "0x4444444444444444444444444444444444444444" as Address;
    const POLYGON_USDC = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359" as Address;
    const ARBITRUM_USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" as Address;
    const ARBITRUM_WBTC = "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f" as Address;

    const sourceTokens: TokenAmount[] = [
      {
        token: ARBITRUM_WBTC,
        amount: 10000000n, // 0.1 WBTC on Arbitrum (needs swap)
        chainId: 42161, // Arbitrum
        walletAddress: WALLET,
        symbol: "WBTC",
        decimals: 8,
      },
      {
        token: POLYGON_USDC,
        amount: 1000000000n, // 1000 USDC on Polygon (needs bridge)
        chainId: 137, // Polygon
        walletAddress: WALLET,
        symbol: "USDC",
        decimals: 6,
      },
      {
        token: ARBITRUM_USDC,
        amount: 500000000n, // 500 USDC already on Arbitrum (no action needed except final transfer)
        chainId: 42161, // Arbitrum
        walletAddress: WALLET,
        symbol: "USDC",
        decimals: 6,
      },
    ];

    const destinationToken = {
      token: ARBITRUM_USDC,
      chainId: 42161, // Arbitrum
      walletAddress: NON_CONNECTED_WALLET, // Different wallet
      symbol: "USDC",
      decimals: 6,
    };

    vi.mocked(getBridgeFee).mockResolvedValue(1000000n); // 1 USDC bridge fee

    // Mock swap WBTC → USDC on Arbitrum
    vi.mocked(getSwapQuote).mockResolvedValueOnce({
      token: ARBITRUM_USDC,
      amount: 3000000000n, // 3000 USDC from swap
      chainId: 42161,
      walletAddress: WALLET,
      symbol: "USDC",
      decimals: 6,
    });

    const result = await planConsolidation(sourceTokens, destinationToken, [WALLET]);

    // Find all step types
    const bridgeStep = result.find((s: TransactionStep) => s.type === "bridge");
    const attestationStep = result.find((s: TransactionStep) => s.type === "attestation");
    const claimStep = result.find((s: TransactionStep) => s.type === "claim");
    const swapStep = result.find((s: TransactionStep) => s.type === "swap");
    const transferStep = result.find((s: TransactionStep) => s.type === "transfer");

    // Verify all expected steps exist
    expect(bridgeStep).toBeDefined();
    expect(attestationStep).toBeDefined();
    expect(claimStep).toBeDefined();
    expect(swapStep).toBeDefined();
    expect(transferStep).toBeDefined();

    if (!bridgeStep || !claimStep || !swapStep || !transferStep) {
      return;
    }

    // Verify bridge step
    expect(bridgeStep.inputTokens[0].amount).toBe(1000000000n); // 1000 USDC
    expect(bridgeStep.outputToken.amount).toBe(999000000n); // 999 USDC (after 1 USDC fee)

    // Verify swap step
    expect(swapStep.inputTokens[0].token).toBe(ARBITRUM_WBTC);
    expect(swapStep.outputToken.amount).toBe(3000000000n); // 3000 USDC

    // CRITICAL: Verify transfer step has THREE inputs with different provenances
    expect(transferStep.inputTokens.length).toBe(3);

    // Find inputs by provenance
    const claimedUSDC = transferStep.inputTokens.find((t) => t.provenance === claimStep.id);
    const swappedUSDC = transferStep.inputTokens.find((t) => t.provenance === swapStep.id);
    const existingUSDC = transferStep.inputTokens.find((t) => !t.provenance);

    expect(claimedUSDC).toBeDefined();
    expect(swappedUSDC).toBeDefined();
    expect(existingUSDC).toBeDefined();

    expect(claimedUSDC?.amount).toBe(999000000n); // Bridged USDC
    expect(swappedUSDC?.amount).toBe(3000000000n); // Swapped USDC
    expect(existingUSDC?.amount).toBe(500000000n); // Existing USDC

    // CRITICAL: Verify transfer output has the SUM of all three sources
    const totalExpected = 999000000n + 3000000000n + 500000000n; // 4499 USDC
    expect(transferStep.outputToken.amount).toBe(totalExpected);
    expect(transferStep.outputToken.walletAddress).toBe(NON_CONNECTED_WALLET);
  });

  test("complex: bridge + swap, transfer from different wallet, final transfer to non-connected wallet", async () => {
    const NON_CONNECTED_WALLET = "0x4444444444444444444444444444444444444444" as Address;
    const WALLET_2 = "0x2222222222222222222222222222222222222222" as Address;
    const WALLET_3 = "0x3333333333333333333333333333333333333333" as Address;

    const sourceTokens: TokenAmount[] = [
      {
        token: USDC_OPTIMISM, // USDC on Optimism
        amount: 1000000n, // 1 USDC
        chainId: 10, // Optimism
        walletAddress: WALLET_2, // From wallet 2
        symbol: "USDC",
        decimals: 6,
      },
      {
        token: WBTC_ADDRESS, // WBTC on Ethereum (destination chain)
        amount: 5000000n, // 0.05 WBTC already at destination chain/token but wrong wallet
        chainId: 1, // Ethereum
        walletAddress: WALLET_3, // From wallet 3
        symbol: "WBTC",
        decimals: 8,
      },
    ];

    const destinationToken = {
      token: WBTC_ADDRESS,
      chainId: 1, // Ethereum
      walletAddress: NON_CONNECTED_WALLET, // Non-connected wallet
      symbol: "WBTC",
      decimals: 8,
    };

    vi.mocked(getBridgeFee).mockResolvedValue(0n);

    // Mock swap USDC -> WBTC on Ethereum
    vi.mocked(getSwapQuote).mockResolvedValue({
      token: WBTC_ADDRESS,
      amount: 8000n, // 0.00008 WBTC
      chainId: 1,
      walletAddress: WALLET_2, // Intermediate wallet (first source wallet)
      symbol: "WBTC",
      decimals: 8,
    });

    const result = await planConsolidation(sourceTokens, destinationToken, [WALLET, WALLET_2, WALLET_3]);

    // Find all step types
    const bridgeStep = result.find((s: TransactionStep) => s.type === "bridge");
    const attestationStep = result.find((s: TransactionStep) => s.type === "attestation");
    const claimStep = result.find((s: TransactionStep) => s.type === "claim");
    const swapStep = result.find((s: TransactionStep) => s.type === "swap");
    const transferSteps = result.filter((s: TransactionStep) => s.type === "transfer");

    // Verify all expected steps exist
    expect(bridgeStep).toBeDefined();
    expect(attestationStep).toBeDefined();
    expect(claimStep).toBeDefined();
    expect(swapStep).toBeDefined();
    expect(transferSteps.length).toBe(2); // One for WBTC from WALLET_3 to WALLET_2, one for final transfer to NON_CONNECTED_WALLET

    if (!bridgeStep || !claimStep || !swapStep) {
      return;
    }

    // Verify bridge step (USDC from Optimism to Ethereum)
    expect(bridgeStep.chainId).toBe(10); // Bridge happens on source chain
    expect(bridgeStep.inputTokens[0].walletAddress).toBe(WALLET_2);
    expect(bridgeStep.inputTokens[0].token).toBe(USDC_OPTIMISM);
    expect(bridgeStep.outputToken.walletAddress).toBe(WALLET_2); // Bridge to intermediate wallet (first source wallet)

    // Verify swap step (USDC -> WBTC after claim)
    expect(swapStep.chainId).toBe(1);
    expect(swapStep.inputTokens[0].symbol).toBe("USDC");
    expect(swapStep.outputToken.token).toBe(WBTC_ADDRESS);
    expect(swapStep.outputToken.walletAddress).toBe(WALLET_2); // Swap outputs to intermediate wallet (first source wallet)
    expect(swapStep.inputTokens[0].provenance).toBe(claimStep.id); // Swap input comes from claim

    // Find the transfer steps
    const wallet3Transfer = transferSteps.find((s: TransactionStep) => s.inputTokens[0].walletAddress === WALLET_3);
    const finalTransfer = transferSteps.find(
      (s: TransactionStep) => s.outputToken.walletAddress === NON_CONNECTED_WALLET,
    );

    // Verify transfer from WALLET_3 to WALLET_2 (consolidating WBTC at intermediate wallet)
    expect(wallet3Transfer).toBeDefined();
    if (wallet3Transfer) {
      expect(wallet3Transfer.inputTokens[0].token).toBe(WBTC_ADDRESS);
      expect(wallet3Transfer.inputTokens[0].amount).toBe(5000000n);
      expect(wallet3Transfer.outputToken.walletAddress).toBe(WALLET_2);
      // Transfer input should NOT have provenance - it's an existing source token, not from claim
      expect(wallet3Transfer.inputTokens[0].provenance).toBeUndefined();
    }

    // Verify final transfer to non-connected wallet
    expect(finalTransfer).toBeDefined();
    if (finalTransfer) {
      expect(finalTransfer.inputTokens[0].walletAddress).toBe(WALLET_2);
      expect(finalTransfer.inputTokens[0].token).toBe(WBTC_ADDRESS);
      expect(finalTransfer.outputToken.walletAddress).toBe(NON_CONNECTED_WALLET);
      // Final transfer input should have provenance (token comes from a previous step)
      expect(finalTransfer.inputTokens[0].provenance).toBeDefined();
    }
  });

  describe("source-chain gas checks", () => {
    test("USDC-only source wallet without native gas triggers a gas-topup step (was: throw insufficient gas)", async () => {
      // Regression: previously, a USDC-only wallet would throw "Insufficient gas".
      // Now the planner records the gap and prepends a gas-topup step instead.
      const { getNativeBalance, findRichestSource } = await import("./gas");
      const { getLiFiQuoteForTargetOutput } = await import("./lifi");
      const { estimateChainGasCosts, estimateOperationsForChainWallet } = await import("./gas-estimation");

      // Chain 10 (source) and chain 1 (dest) start with dust → both record gaps.
      // Polygon (137) carries 10 POL — the only candidate that can cover the deficits.
      vi.mocked(getNativeBalance).mockImplementation(async (chain) =>
        chain.id === 137 ? 10_000_000_000_000_000_000n : 100_000_000_000n,
      );
      vi.mocked(estimateChainGasCosts).mockResolvedValue({
        totalGasCost: 1_000_000_000_000_000n, // 0.001 ETH
        maxFeePerGas: 20_000_000_000n,
        perOperation: [],
      });
      vi.mocked(estimateOperationsForChainWallet).mockReturnValue(["cctp-approval", "cctp-burn"]);
      vi.mocked(getBridgeFee).mockResolvedValue(0n);
      vi.mocked(findRichestSource).mockResolvedValue(null);
      vi.mocked(getLiFiQuoteForTargetOutput).mockResolvedValue({
        tool: "across",
        action: {
          fromChainId: 137,
          toChainId: 10,
          fromToken: { symbol: "POL", decimals: 18, priceUSD: "0.5" },
          toToken: { symbol: "ETH", decimals: 18, priceUSD: "2000" },
        },
        estimate: {
          fromAmount: "5500000000000000", // POL fromAmount
          toAmount: "1000000000000000", // ETH toAmount
          toAmountMin: "1000000000000000",
        },
        transactionRequest: {
          value: "5500000000000000",
          to: "0x1111111111111111111111111111111111111111" as Address,
          data: "0x" as `0x${string}`,
          from: WALLET,
          chainId: 137,
        },
      });

      const sourceTokens: TokenAmount[] = [
        {
          token: USDC_OPTIMISM,
          amount: 1_000_000n,
          chainId: 10,
          walletAddress: WALLET,
          symbol: "USDC",
          decimals: 6,
        },
      ];

      const destinationToken = {
        token: USDC_ADDRESS,
        chainId: 1,
        walletAddress: WALLET,
        symbol: "USDC",
        decimals: 6,
      };

      const plan = await planConsolidation(sourceTokens, destinationToken, [WALLET]);
      expect(plan[0].type).toBe("gas-topup");
      expect(plan[0].gasTopUpDestinations).toBeDefined();
      const dest = plan[0].gasTopUpDestinations?.find((d) => d.chainId === 10 && d.address === WALLET);
      expect(dest).toBeDefined();
      // Deficit = measured step cost (1 bridge step × 1e14) − balance (1e11)
      expect(BigInt(dest?.amountWei ?? "0")).toBe(99_900_000_000_000n);

      vi.mocked(getNativeBalance).mockResolvedValue(1_000_000_000_000_000_000n);
      vi.mocked(estimateChainGasCosts).mockResolvedValue({
        totalGasCost: 100_000_000_000_000n,
        maxFeePerGas: 20_000_000_000n,
        perOperation: [],
      });
      vi.mocked(findRichestSource).mockResolvedValue(null);
    });

    test("ERC20-only source wallet (no native, no USDC) → PlanningError when no funding source", async () => {
      const { getNativeBalance, findRichestSource } = await import("./gas");
      const { estimateChainGasCosts } = await import("./gas-estimation");

      vi.mocked(getNativeBalance).mockResolvedValue(0n);
      vi.mocked(estimateChainGasCosts).mockResolvedValue({
        totalGasCost: 500_000_000_000_000n,
        maxFeePerGas: 20_000_000_000n,
        perOperation: [],
      });
      vi.mocked(getBridgeFee).mockResolvedValue(0n);
      vi.mocked(findRichestSource).mockResolvedValue(null);

      const sourceTokens: TokenAmount[] = [
        {
          token: WBTC_ADDRESS,
          amount: 10_000_000n,
          chainId: 10,
          walletAddress: WALLET,
          symbol: "WBTC",
          decimals: 8,
        },
      ];

      const destinationToken = {
        token: USDC_ADDRESS,
        chainId: 1,
        walletAddress: WALLET,
        symbol: "USDC",
        decimals: 6,
      };

      await expect(planConsolidation(sourceTokens, destinationToken, [WALLET])).rejects.toThrow(/PlanningError/);

      vi.mocked(getNativeBalance).mockResolvedValue(1_000_000_000_000_000_000n);
      vi.mocked(estimateChainGasCosts).mockResolvedValue({
        totalGasCost: 100_000_000_000_000n,
        maxFeePerGas: 20_000_000_000n,
        perOperation: [],
      });
    });

    test("destination wallet without dest-chain gas → plan succeeds with a gas-topup step", async () => {
      const { getNativeBalance, findRichestSource } = await import("./gas");
      const { getLiFiQuoteForTargetOutput } = await import("./lifi");
      const { estimateChainGasCosts } = await import("./gas-estimation");

      // First call (resolveIntermediateWallet, dest chain) → 0
      // Subsequent calls (source chain checks, top-up funding) → plenty
      vi.mocked(getNativeBalance).mockResolvedValue(1_000_000_000_000_000_000n);
      vi.mocked(getNativeBalance).mockResolvedValueOnce(0n);

      vi.mocked(estimateChainGasCosts).mockResolvedValue({
        totalGasCost: 500_000_000_000_000n,
        maxFeePerGas: 20_000_000_000n,
        perOperation: [],
      });
      vi.mocked(getBridgeFee).mockResolvedValue(0n);
      vi.mocked(findRichestSource).mockResolvedValue({
        chainId: 10,
        address: WALLET,
        balance: 10_000_000_000_000_000_000n,
      });
      vi.mocked(getLiFiQuoteForTargetOutput).mockResolvedValue({
        tool: "across",
        action: {
          fromChainId: 10,
          toChainId: 1,
          fromToken: { symbol: "ETH", decimals: 18, priceUSD: "2000" },
          toToken: { symbol: "ETH", decimals: 18, priceUSD: "2000" },
        },
        estimate: {
          fromAmount: "550000000000000",
          toAmount: "500000000000000",
          toAmountMin: "500000000000000",
        },
        transactionRequest: {
          value: "550000000000000",
          to: "0x1111111111111111111111111111111111111111" as Address,
          data: "0x" as `0x${string}`,
          from: WALLET,
          chainId: 10,
        },
      });

      const sourceTokens: TokenAmount[] = [
        {
          token: USDC_OPTIMISM,
          amount: 1_000_000n,
          chainId: 10,
          walletAddress: WALLET,
          symbol: "USDC",
          decimals: 6,
        },
      ];

      const destinationToken = {
        token: WBTC_ADDRESS,
        chainId: 1,
        walletAddress: WALLET,
        symbol: "WBTC",
        decimals: 8,
      };

      const plan = await planConsolidation(sourceTokens, destinationToken, [WALLET]);
      expect(plan[0].type).toBe("gas-topup");
      const destEntry = plan[0].gasTopUpDestinations?.find((d) => d.chainId === 1);
      expect(destEntry).toBeDefined();
      // Deficit = measured dest-chain steps (claim + final swap × 1e14) − balance (0)
      expect(BigInt(destEntry?.amountWei ?? "0")).toBe(200_000_000_000_000n);

      vi.mocked(getNativeBalance).mockResolvedValue(1_000_000_000_000_000_000n);
      vi.mocked(estimateChainGasCosts).mockResolvedValue({
        totalGasCost: 100_000_000_000_000n,
        maxFeePerGas: 20_000_000_000n,
        perOperation: [],
      });
      vi.mocked(findRichestSource).mockResolvedValue(null);
    });

    test("native source token amount is trimmed when gas exceeds free balance", async () => {
      // Native balance: 1 ETH; measured gas: 0.1 ETH; user wants to swap 1 ETH.
      // Plan should trim to 0.9 ETH instead of failing.
      const { getNativeBalance } = await import("./gas");
      const { measureOpsGas } = await import("./gas-estimation");

      vi.mocked(getNativeBalance).mockResolvedValue(1_000_000_000_000_000_000n); // 1 ETH
      vi.mocked(measureOpsGas).mockResolvedValue(100_000_000_000_000_000n); // 0.1 ETH
      vi.mocked(getBridgeFee).mockResolvedValue(0n);
      vi.mocked(getSwapQuote).mockResolvedValue({
        token: USDC_OPTIMISM,
        amount: 2_000_000_000n,
        chainId: 10,
        walletAddress: WALLET,
        symbol: "USDC",
        decimals: 6,
      });

      const sourceTokens: TokenAmount[] = [
        {
          token: ETH_ADDRESS,
          amount: 1_000_000_000_000_000_000n, // 1 ETH selected
          chainId: 10,
          walletAddress: WALLET,
          symbol: "ETH",
          decimals: 18,
        },
      ];

      const destinationToken = {
        token: USDC_ADDRESS,
        chainId: 1,
        walletAddress: WALLET,
        symbol: "USDC",
        decimals: 6,
      };

      const result = await planConsolidation(sourceTokens, destinationToken, [WALLET]);

      // Find the swap step on chain 10 and check its native input was trimmed
      const swapStep = result.find((s) => s.type === "swap" && s.chainId === 10);
      expect(swapStep).toBeDefined();
      expect(swapStep?.inputTokens[0].amount).toBe(900_000_000_000_000_000n); // 0.9 ETH

      vi.mocked(measureOpsGas).mockResolvedValue(500_000_000_000_000n);
    });

    test("capped native leg is re-quoted exactly once with the trimmed amount", async () => {
      const { getNativeBalance } = await import("./gas");
      const { measureOpsGas } = await import("./gas-estimation");

      vi.mocked(getNativeBalance).mockResolvedValue(1_000_000_000_000_000_000n); // 1 ETH
      vi.mocked(measureOpsGas).mockResolvedValue(100_000_000_000_000_000n); // 0.1 ETH measured
      vi.mocked(getBridgeFee).mockResolvedValue(0n);
      const usdcQuote = {
        token: USDC_OPTIMISM,
        chainId: 10,
        walletAddress: WALLET,
        symbol: "USDC",
        decimals: 6,
      };
      vi.mocked(getSwapQuote)
        // Full-amount quote (1 ETH), used for the gas measurement.
        .mockResolvedValueOnce({ ...usdcQuote, amount: 2_000_000_000n })
        // Re-quote at the capped amount (0.9 ETH).
        .mockResolvedValueOnce({ ...usdcQuote, amount: 1_800_000_000n })
        // Final swap USDC -> WBTC on the destination chain.
        .mockResolvedValueOnce({
          token: WBTC_ADDRESS,
          amount: 8000n,
          chainId: 1,
          walletAddress: WALLET,
          symbol: "WBTC",
          decimals: 8,
        });

      const sourceTokens: TokenAmount[] = [
        {
          token: ETH_ADDRESS,
          amount: 1_000_000_000_000_000_000n, // 1 ETH selected == balance
          chainId: 10,
          walletAddress: WALLET,
          symbol: "ETH",
          decimals: 18,
        },
      ];

      const destinationToken = {
        token: WBTC_ADDRESS,
        chainId: 1,
        walletAddress: WALLET,
        symbol: "WBTC",
        decimals: 8,
      };

      const result = await planConsolidation(sourceTokens, destinationToken, [WALLET]);

      const swapStep = result.find((s) => s.type === "swap" && s.chainId === 10);
      expect(swapStep?.inputTokens[0].amount).toBe(900_000_000_000_000_000n);
      // The plan consumes the re-quoted output, not the stale full-amount one.
      expect(swapStep?.outputToken.amount).toBe(1_800_000_000n);
      // The re-quote carries the capped amount...
      expect(getSwapQuote).toHaveBeenNthCalledWith(
        2,
        [expect.objectContaining({ amount: 900_000_000_000_000_000n })],
        expect.anything(),
      );
      // ...and happens exactly once: full quote + re-quote + final swap.
      expect(getSwapQuote).toHaveBeenCalledTimes(3);

      vi.mocked(measureOpsGas).mockResolvedValue(500_000_000_000_000n);
    });

    test("dust native source (amount <= gas, sole token) throws instead of topping up", async () => {
      // The selected native (0.1 ETH) is worth no more than the gas to move it
      // (0.1 ETH). Topping up gas — extra gas + a LI.FI bridge fee — to move an
      // amount worth less than the fees is a guaranteed loss, so planning refuses
      // with an actionable error rather than prepending a gas-topup step.
      const { getNativeBalance, findRichestSource } = await import("./gas");
      const { measureOpsGas } = await import("./gas-estimation");

      vi.mocked(getNativeBalance).mockResolvedValue(100_000_000_000_000_000n); // 0.1 ETH
      vi.mocked(measureOpsGas).mockResolvedValue(100_000_000_000_000_000n); // 0.1 ETH (== selected amount)
      vi.mocked(getBridgeFee).mockResolvedValue(0n);

      const sourceTokens: TokenAmount[] = [
        {
          token: ETH_ADDRESS,
          amount: 100_000_000_000_000_000n, // 0.1 ETH selected
          chainId: 10,
          walletAddress: WALLET,
          symbol: "ETH",
          decimals: 18,
        },
      ];

      const destinationToken = {
        token: USDC_ADDRESS,
        chainId: 1,
        walletAddress: WALLET,
        symbol: "USDC",
        decimals: 6,
      };

      await expect(planConsolidation(sourceTokens, destinationToken, [WALLET])).rejects.toThrow(
        /smaller than the gas needed to move it/,
      );

      vi.mocked(measureOpsGas).mockResolvedValue(500_000_000_000_000n);
      vi.mocked(findRichestSource).mockResolvedValue(null);
    });

    test("native source just above gas cost but within the LI.FI overhead band still throws", async () => {
      // amount = 1.005 ETH, gas = 1 ETH, balance = 0.
      // Old gate (amount <= gasCost) would have topped up (1.005 > 1.0).
      // New gate adds ~1.5% of the deficit (~0.03 ETH) on top of gas, so the
      // threshold is ~1.03 ETH and 1.005 ETH still doesn't clear it — a
      // cross-chain refuel would cost more than the amount it rescues.
      const { getNativeBalance, findRichestSource } = await import("./gas");
      const { measureOpsGas } = await import("./gas-estimation");

      vi.mocked(getNativeBalance).mockResolvedValue(0n);
      vi.mocked(measureOpsGas).mockResolvedValue(1_000_000_000_000_000_000n); // 1 ETH gas
      vi.mocked(getBridgeFee).mockResolvedValue(0n);

      const sourceTokens: TokenAmount[] = [
        {
          token: ETH_ADDRESS,
          amount: 1_005_000_000_000_000_000n, // 1.005 ETH — just above gas, within cushion
          chainId: 10,
          walletAddress: WALLET,
          symbol: "ETH",
          decimals: 18,
        },
      ];

      const destinationToken = {
        token: USDC_ADDRESS,
        chainId: 1,
        walletAddress: WALLET,
        symbol: "USDC",
        decimals: 6,
      };

      await expect(planConsolidation(sourceTokens, destinationToken, [WALLET])).rejects.toThrow(
        /smaller than the gas needed to move it/,
      );

      vi.mocked(measureOpsGas).mockResolvedValue(500_000_000_000_000n);
      vi.mocked(findRichestSource).mockResolvedValue(null);
    });

    test("native source token (amount > gas) is preserved and a gas-topup step is prepended", async () => {
      // When the selected native exceeds the gas to move it, a top-up is
      // worthwhile: keep the swap input and prepend a gas-topup step that funds
      // the shortfall — preserving the user's original swap intent.
      const { getNativeBalance, findRichestSource } = await import("./gas");
      const { getLiFiQuoteForTargetOutput } = await import("./lifi");
      const { measureOpsGas } = await import("./gas-estimation");

      // Source/dest chains have just enough to leave a deficit;
      // Polygon (137) carries 10 POL — the only candidate that can cover it.
      vi.mocked(getNativeBalance).mockImplementation(async (chain) =>
        chain.id === 137 ? 10_000_000_000_000_000_000n : 100_000_000_000_000_000n,
      );
      vi.mocked(measureOpsGas).mockResolvedValue(100_000_000_000_000_000n); // 0.1 ETH gas
      vi.mocked(getBridgeFee).mockResolvedValue(0n);
      vi.mocked(findRichestSource).mockResolvedValue(null);
      vi.mocked(getLiFiQuoteForTargetOutput).mockResolvedValue({
        tool: "across",
        action: {
          fromChainId: 137,
          toChainId: 10,
          fromToken: { symbol: "POL", decimals: 18, priceUSD: "0.5" },
          toToken: { symbol: "ETH", decimals: 18, priceUSD: "2000" },
        },
        estimate: {
          fromAmount: "220000000000000000",
          toAmount: "100000000000000000",
          toAmountMin: "100000000000000000",
        },
        transactionRequest: {
          value: "220000000000000000",
          to: "0x1111111111111111111111111111111111111111" as Address,
          data: "0x" as `0x${string}`,
          from: WALLET,
          chainId: 137,
        },
      });

      const sourceTokens: TokenAmount[] = [
        {
          token: ETH_ADDRESS,
          amount: 500_000_000_000_000_000n, // 0.5 ETH selected (> 0.1 ETH gas)
          chainId: 10,
          walletAddress: WALLET,
          symbol: "ETH",
          decimals: 18,
        },
      ];

      const destinationToken = {
        token: USDC_ADDRESS,
        chainId: 1,
        walletAddress: WALLET,
        symbol: "USDC",
        decimals: 6,
      };

      const result = await planConsolidation(sourceTokens, destinationToken, [WALLET]);
      expect(result[0].type).toBe("gas-topup");
      const swapStep = result.find((s) => s.type === "swap" && s.chainId === 10);
      expect(swapStep).toBeDefined();
      // Native input is preserved at original 0.5 ETH (not zeroed out).
      expect(swapStep?.inputTokens[0].amount).toBe(500_000_000_000_000_000n);

      vi.mocked(measureOpsGas).mockResolvedValue(500_000_000_000_000n);
      vi.mocked(findRichestSource).mockResolvedValue(null);
    });

    test("dust native alongside other value: dust is dropped, top-up funds the rest", async () => {
      // The wallet holds a dust native amount (< gas) AND USDC worth bridging.
      // The dust native is silently dropped from the swap (it's not worth moving)
      // but the USDC consolidation still proceeds, with a gas-topup covering the
      // bridge gas only.
      const { getNativeBalance, findRichestSource } = await import("./gas");
      const { getLiFiQuoteForTargetOutput } = await import("./lifi");
      const { measureOpsGas } = await import("./gas-estimation");

      // All wallets at 0 except Polygon, which holds 10 POL — the funding source.
      vi.mocked(getNativeBalance).mockImplementation(async (chain) =>
        chain.id === 137 ? 10_000_000_000_000_000_000n : 0n,
      );
      vi.mocked(measureOpsGas).mockResolvedValue(10_000_000_000_000_000n); // 0.01 ETH
      vi.mocked(getBridgeFee).mockResolvedValue(0n);
      vi.mocked(findRichestSource).mockResolvedValue(null);
      vi.mocked(getLiFiQuoteForTargetOutput).mockResolvedValue({
        tool: "across",
        action: {
          fromChainId: 137,
          toChainId: 10,
          fromToken: { symbol: "POL", decimals: 18, priceUSD: "0.5" },
          toToken: { symbol: "ETH", decimals: 18, priceUSD: "2000" },
        },
        estimate: {
          fromAmount: "55000000000000000",
          toAmount: "10000000000000000",
          toAmountMin: "10000000000000000",
        },
        transactionRequest: {
          value: "55000000000000000",
          to: "0x1111111111111111111111111111111111111111" as Address,
          data: "0x" as `0x${string}`,
          from: WALLET,
          chainId: 137,
        },
      });

      const sourceTokens: TokenAmount[] = [
        {
          token: ETH_ADDRESS,
          amount: 1_000_000_000_000n, // 0.000001 ETH dust (<< 0.01 ETH gas)
          chainId: 10,
          walletAddress: WALLET,
          symbol: "ETH",
          decimals: 18,
        },
        {
          token: USDC_OPTIMISM,
          amount: 1_000_000n,
          chainId: 10,
          walletAddress: WALLET,
          symbol: "USDC",
          decimals: 6,
        },
      ];

      const destinationToken = {
        token: USDC_ADDRESS,
        chainId: 1,
        walletAddress: WALLET,
        symbol: "USDC",
        decimals: 6,
      };

      const plan = await planConsolidation(sourceTokens, destinationToken, [WALLET]);
      expect(plan[0].type).toBe("gas-topup");
      // Dust native was dropped — no swap step for it on chain 10.
      expect(plan.find((s) => s.type === "swap" && s.chainId === 10)).toBeUndefined();
      // USDC still gets bridged.
      expect(plan.some((s) => s.type === "bridge")).toBe(true);
      // Top-up covers only the remaining bridge step's measured gas
      // (1 step × 1e14 from the attach mock, balance 0).
      const dest = plan[0].gasTopUpDestinations?.find((d) => d.chainId === 10 && d.address === WALLET);
      expect(BigInt(dest?.amountWei ?? "0")).toBe(100_000_000_000_000n);

      vi.mocked(measureOpsGas).mockResolvedValue(500_000_000_000_000n);
      vi.mocked(findRichestSource).mockResolvedValue(null);
    });
  });

  describe("gas top-up funding source selection", () => {
    test("uses destination wallet as funding source when it has sufficient native balance", async () => {
      const { getNativeBalance, findRichestSource } = await import("./gas");
      const { estimateChainGasCosts } = await import("./gas-estimation");

      // Source chain (10) WALLET has 0 → records gap there.
      // Destination chain (1) WALLET has 10 ETH → can fund the gap on chain 10.
      vi.mocked(getNativeBalance).mockImplementation(async (chain) =>
        chain.id === 1 ? 10_000_000_000_000_000_000n : 0n,
      );
      vi.mocked(estimateChainGasCosts).mockResolvedValue({
        totalGasCost: 1_000_000_000_000_000n, // 0.001 ETH per chain
        maxFeePerGas: 20_000_000_000n,
        perOperation: [],
      });
      vi.mocked(getBridgeFee).mockResolvedValue(0n);
      // findRichestSource should NOT be called when dest funding succeeds.
      vi.mocked(findRichestSource).mockResolvedValue({
        chainId: 137,
        address: WALLET,
        balance: 100_000_000_000_000_000_000n,
      });
      const { getLiFiQuoteForTargetOutput } = await import("./lifi");
      vi.mocked(getLiFiQuoteForTargetOutput).mockResolvedValue({
        tool: "across",
        action: {
          fromChainId: 1,
          toChainId: 10,
          fromToken: { symbol: "ETH", decimals: 18, priceUSD: "2000" },
          toToken: { symbol: "ETH", decimals: 18, priceUSD: "2000" },
        },
        estimate: {
          fromAmount: "1100000000000000",
          toAmount: "1000000000000000",
          toAmountMin: "1000000000000000",
        },
        transactionRequest: {
          value: "1100000000000000",
          to: "0x1111111111111111111111111111111111111111" as Address,
          data: "0x" as `0x${string}`,
          from: WALLET,
          chainId: 1,
        },
      });

      const sourceTokens: TokenAmount[] = [
        {
          token: USDC_OPTIMISM,
          amount: 1_000_000n,
          chainId: 10,
          walletAddress: WALLET,
          symbol: "USDC",
          decimals: 6,
        },
      ];
      const destinationToken = {
        token: USDC_ADDRESS,
        chainId: 1,
        walletAddress: WALLET,
        symbol: "USDC",
        decimals: 6,
      };

      const plan = await planConsolidation(sourceTokens, destinationToken, [WALLET]);
      const topup = plan.find((s) => s.type === "gas-topup");
      expect(topup).toBeDefined();
      // Funding from destination chain (chain 1)
      expect(topup?.chainId).toBe(1);
      expect(topup?.inputTokens[0].walletAddress).toBe(WALLET);

      vi.mocked(getNativeBalance).mockResolvedValue(1_000_000_000_000_000_000n);
      vi.mocked(estimateChainGasCosts).mockResolvedValue({
        totalGasCost: 100_000_000_000_000n,
        maxFeePerGas: 20_000_000_000n,
        perOperation: [],
      });
      vi.mocked(findRichestSource).mockResolvedValue(null);
    });

    test("falls back to findRichestSource when destination wallet is also short", async () => {
      const { getNativeBalance, findRichestSource } = await import("./gas");
      const { estimateChainGasCosts } = await import("./gas-estimation");
      const { getLiFiQuoteForTargetOutput } = await import("./lifi");

      // Both source chain (10) and destination chain (1) WALLET have 0 → both gaps recorded.
      // Polygon (137) carries 100 POL — the only candidate that can cover both deficits.
      vi.mocked(getNativeBalance).mockImplementation(async (chain) =>
        chain.id === 137 ? 100_000_000_000_000_000_000n : 0n,
      );
      vi.mocked(estimateChainGasCosts).mockResolvedValue({
        totalGasCost: 1_000_000_000_000_000n,
        maxFeePerGas: 20_000_000_000n,
        perOperation: [],
      });
      vi.mocked(getBridgeFee).mockResolvedValue(0n);
      vi.mocked(findRichestSource).mockResolvedValue(null);
      vi.mocked(getLiFiQuoteForTargetOutput).mockResolvedValue({
        tool: "across",
        action: {
          fromChainId: 137,
          toChainId: 1,
          fromToken: { symbol: "POL", decimals: 18, priceUSD: "0.5" },
          toToken: { symbol: "ETH", decimals: 18, priceUSD: "2000" },
        },
        estimate: {
          fromAmount: "5500000000000000",
          toAmount: "1000000000000000",
          toAmountMin: "1000000000000000",
        },
        transactionRequest: {
          value: "5500000000000000",
          to: "0x1111111111111111111111111111111111111111" as Address,
          data: "0x" as `0x${string}`,
          from: WALLET,
          chainId: 137,
        },
      });

      const sourceTokens: TokenAmount[] = [
        {
          token: USDC_OPTIMISM,
          amount: 1_000_000n,
          chainId: 10,
          walletAddress: WALLET,
          symbol: "USDC",
          decimals: 6,
        },
      ];
      const destinationToken = {
        token: USDC_ADDRESS,
        chainId: 1,
        walletAddress: WALLET,
        symbol: "USDC",
        decimals: 6,
      };

      const plan = await planConsolidation(sourceTokens, destinationToken, [WALLET]);
      const topup = plan.find((s) => s.type === "gas-topup");
      expect(topup).toBeDefined();
      // Funding from polygon (chain 137) — the richest source fallback
      expect(topup?.chainId).toBe(137);

      vi.mocked(getNativeBalance).mockResolvedValue(1_000_000_000_000_000_000n);
      vi.mocked(estimateChainGasCosts).mockResolvedValue({
        totalGasCost: 100_000_000_000_000n,
        maxFeePerGas: 20_000_000_000n,
        perOperation: [],
      });
      vi.mocked(findRichestSource).mockResolvedValue(null);
    });

    test("no gas-topup-wait when all destinations are same-chain as source", async () => {
      const { getNativeBalance, findRichestSource } = await import("./gas");
      const { estimateChainGasCosts } = await import("./gas-estimation");

      // WALLET_2 is broke on chain 10 (gap for WALLET_2's USDC transfer).
      // WALLET holds 10 ETH on chain 10 and acts as funding source — both wallets
      // participate (intermediate + source-token holder), so both end up in
      // executorAddresses. WALLET funds WALLET_2's gap same-chain — no bridge wait.
      const WALLET_2 = "0x2222222222222222222222222222222222222222" as Address;
      vi.mocked(getNativeBalance).mockImplementation(async (chain, address) => {
        if (chain.id === 10 && address === WALLET_2) return 0n;
        if (chain.id === 10 && address === WALLET) return 10_000_000_000_000_000_000n;
        return 0n;
      });
      vi.mocked(estimateChainGasCosts).mockResolvedValue({
        totalGasCost: 1_000_000_000_000_000n,
        maxFeePerGas: 20_000_000_000n,
        perOperation: [],
      });
      vi.mocked(getBridgeFee).mockResolvedValue(0n);
      vi.mocked(findRichestSource).mockResolvedValue(null);

      const sourceTokens: TokenAmount[] = [
        {
          token: USDC_OPTIMISM,
          amount: 1_000_000n,
          chainId: 10,
          walletAddress: WALLET_2,
          symbol: "USDC",
          decimals: 6,
        },
      ];
      const destinationToken = {
        token: USDC_ADDRESS,
        chainId: 10, // same as source — no bridge needed at all
        walletAddress: WALLET,
        symbol: "USDC",
        decimals: 6,
      };

      const plan = await planConsolidation(sourceTokens, destinationToken, [WALLET, WALLET_2]);
      const topup = plan.find((s) => s.type === "gas-topup");
      const wait = plan.find((s) => s.type === "gas-topup-wait");
      expect(topup).toBeDefined();
      expect(wait).toBeUndefined();

      vi.mocked(getNativeBalance).mockResolvedValue(1_000_000_000_000_000_000n);
      vi.mocked(estimateChainGasCosts).mockResolvedValue({
        totalGasCost: 100_000_000_000_000n,
        maxFeePerGas: 20_000_000_000n,
        perOperation: [],
      });
      vi.mocked(findRichestSource).mockResolvedValue(null);
    });

    test("prefers higher-USD-value chain over higher raw-wei chain (Optimism ETH > Polygon POL)", async () => {
      // Regression: planner used to compare native balances by raw wei. POL on
      // Polygon (1 POL = 1e18 wei ≈ $0.20) would outrank ETH on Optimism (0.5
      // ETH = 5e17 wei ≈ $1500) numerically, so the bridge attempt would fire
      // off Polygon and fall through to mainnet on failure. With USD-aware
      // sorting, Optimism wins.
      const { getNativeBalance, findRichestSource } = await import("./gas");
      const { fetchDeloraPrices } = await import("./api/delora");
      const { getLiFiQuoteForTargetOutput } = await import("./lifi");
      const { estimateChainGasCosts } = await import("./gas-estimation");

      // 0.5 ETH on Optimism, 100 POL on Polygon. Raw wei says Polygon wins
      // (1e20 > 5e17); USD value says Optimism wins ($1000 vs $20).
      vi.mocked(getNativeBalance).mockImplementation(async (chain) => {
        if (chain.id === 10) return 500_000_000_000_000_000n; // 0.5 ETH
        if (chain.id === 137) return 100_000_000_000_000_000_000n; // 100 POL
        return 0n;
      });
      vi.mocked(fetchDeloraPrices).mockResolvedValue(
        new Map([
          [`10:${"0x0000000000000000000000000000000000000000"}`, 2000], // ETH = $2000
          [`137:${"0x0000000000000000000000000000000000000000"}`, 0.2], // POL = $0.20
        ]),
      );
      vi.mocked(estimateChainGasCosts).mockResolvedValue({
        totalGasCost: 1_000_000_000_000_000n, // 0.001 ETH gas (creates a gap on chain 1)
        maxFeePerGas: 20_000_000_000n,
        perOperation: [],
      });
      vi.mocked(getBridgeFee).mockResolvedValue(0n);
      vi.mocked(findRichestSource).mockResolvedValue(null);
      vi.mocked(getLiFiQuoteForTargetOutput).mockImplementation(async (fromChainId) => ({
        tool: "across",
        action: {
          fromChainId,
          toChainId: 1,
          fromToken: { symbol: fromChainId === 137 ? "POL" : "ETH", decimals: 18, priceUSD: "0" },
          toToken: { symbol: "ETH", decimals: 18, priceUSD: "2000" },
        },
        estimate: { fromAmount: "5500000000000000", toAmount: "1000000000000000", toAmountMin: "1000000000000000" },
        transactionRequest: {
          value: "5500000000000000",
          to: "0x1111111111111111111111111111111111111111" as Address,
          data: "0x" as `0x${string}`,
          from: WALLET,
          chainId: fromChainId,
        },
      }));

      const sourceTokens: TokenAmount[] = [
        { token: USDC_OPTIMISM, amount: 1_000_000n, chainId: 10, walletAddress: WALLET, symbol: "USDC", decimals: 6 },
      ];
      const destinationToken = { token: USDC_ADDRESS, chainId: 1, walletAddress: WALLET, symbol: "USDC", decimals: 6 };

      const plan = await planConsolidation(sourceTokens, destinationToken, [WALLET]);
      const topup = plan.find((s) => s.type === "gas-topup");
      expect(topup).toBeDefined();
      // Optimism (10) wins on USD value despite Polygon's bigger raw-wei balance.
      expect(topup?.chainId).toBe(10);

      vi.mocked(fetchDeloraPrices).mockResolvedValue(new Map());
      vi.mocked(getNativeBalance).mockResolvedValue(1_000_000_000_000_000_000n);
      vi.mocked(estimateChainGasCosts).mockResolvedValue({
        totalGasCost: 100_000_000_000_000n,
        maxFeePerGas: 20_000_000_000n,
        perOperation: [],
      });
    });

    test("throws PlanningError when no wallet can fund the deficit", async () => {
      const { getNativeBalance, findRichestSource } = await import("./gas");
      const { estimateChainGasCosts } = await import("./gas-estimation");

      vi.mocked(getNativeBalance).mockResolvedValue(0n);
      vi.mocked(estimateChainGasCosts).mockResolvedValue({
        totalGasCost: 1_000_000_000_000_000n,
        maxFeePerGas: 20_000_000_000n,
        perOperation: [],
      });
      vi.mocked(getBridgeFee).mockResolvedValue(0n);
      vi.mocked(findRichestSource).mockResolvedValue(null); // no fallback either

      const sourceTokens: TokenAmount[] = [
        {
          token: USDC_OPTIMISM,
          amount: 1_000_000n,
          chainId: 10,
          walletAddress: WALLET,
          symbol: "USDC",
          decimals: 6,
        },
      ];
      const destinationToken = {
        token: USDC_ADDRESS,
        chainId: 1,
        walletAddress: WALLET,
        symbol: "USDC",
        decimals: 6,
      };

      await expect(planConsolidation(sourceTokens, destinationToken, [WALLET])).rejects.toThrow(/PlanningError/);

      vi.mocked(getNativeBalance).mockResolvedValue(1_000_000_000_000_000_000n);
      vi.mocked(estimateChainGasCosts).mockResolvedValue({
        totalGasCost: 100_000_000_000_000n,
        maxFeePerGas: 20_000_000_000n,
        perOperation: [],
      });
    });
  });

  describe("smart-account / EIP-7702 detection", () => {
    const sourceTokens: TokenAmount[] = [
      {
        token: USDC_ADDRESS,
        amount: 1_000_000n,
        chainId: 1,
        walletAddress: WALLET,
        symbol: "USDC",
        decimals: 6,
      },
    ];

    const destinationToken = {
      token: WBTC_ADDRESS,
      chainId: 1,
      walletAddress: WALLET,
      symbol: "WBTC",
      decimals: 8,
    };

    const mockGetCode = (code: `0x${string}`) => {
      vi.mocked(getPublicClient).mockReturnValue({
        getCode: vi.fn().mockResolvedValue(code),
      } as unknown as ReturnType<typeof getPublicClient>);
    };

    test("rejects a true smart-account wallet (non-7702 bytecode)", async () => {
      mockGetCode("0x6080604052"); // arbitrary contract bytecode

      await expect(planConsolidation(sourceTokens, destinationToken, [WALLET])).rejects.toThrow(
        /Smart-account wallets are not supported/,
      );
    });

    test("accepts an EIP-7702-delegated EOA (0xef0100 designation)", async () => {
      // EIP-7702 designation: 0xef0100 || <20-byte delegate address>
      mockGetCode("0xef0100aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");

      vi.mocked(getSwapQuote).mockResolvedValue({
        token: WBTC_ADDRESS,
        amount: 8000n,
        chainId: 1,
        walletAddress: WALLET,
        symbol: "WBTC",
        decimals: 8,
      });

      const result = await planConsolidation(sourceTokens, destinationToken, [WALLET]);
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe("swap");
    });

    test("accepts an EIP-7702 designation with uppercase hex", async () => {
      mockGetCode("0xEF0100AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");

      vi.mocked(getSwapQuote).mockResolvedValue({
        token: WBTC_ADDRESS,
        amount: 8000n,
        chainId: 1,
        walletAddress: WALLET,
        symbol: "WBTC",
        decimals: 8,
      });

      await expect(planConsolidation(sourceTokens, destinationToken, [WALLET])).resolves.toBeDefined();
    });
  });

  describe("railgun (0zk) destinations", () => {
    const WETH_MAINNET = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" as Address;
    const WETH_POLYGON = "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619" as Address;
    // Engine-generated fixtures (see railgun.test.ts): same key material,
    // one bound to Ethereum mainnet, one valid on all chains.
    const RAILGUN_MAINNET =
      "0zk1qyqjx3t83x4ummcpydzk0zdtehhszg69v7y6hn00qy352euf40x77unpd9kxwatwq9um243w3ln9f72q0zc3969f3wneq8u98tnft0khur3ezzadqjtxgzp38kw";
    const RAILGUN_ALL_CHAINS =
      "0zk1qyqjx3t83x4ummcpydzk0zdtehhszg69v7y6hn00qy352euf40x7lrv7j6fe3z53laum243w3ln9f72q0zc3969f3wneq8u98tnft0khur3ezzadqjtxg9v756u";

    const railgunDestination = (overrides?: Partial<Parameters<typeof planConsolidation>[1]>) => ({
      token: WETH_MAINNET,
      chainId: 1,
      // The UI passes a zero-address placeholder; planning resolves the
      // public holder (intermediate wallet) itself.
      walletAddress: zeroAddress,
      symbol: "WETH",
      decimals: 18,
      railgunAddress: RAILGUN_ALL_CHAINS,
      ...overrides,
    });

    test("source already matches destination token - single shield step (no transfer fast path)", async () => {
      const sourceTokens: TokenAmount[] = [
        { token: WETH_MAINNET, amount: 10n ** 18n, chainId: 1, walletAddress: WALLET, symbol: "WETH", decimals: 18 },
      ];

      const plan = await planConsolidation(sourceTokens, railgunDestination(), [WALLET]);

      expect(plan).toHaveLength(1);
      expect(plan[0].type).toBe("shield");
      expect(plan[0].chainId).toBe(1);
      expect(plan[0].railgunAddress).toBe(RAILGUN_ALL_CHAINS);
      // The shield is performed by the connected intermediate wallet.
      expect(plan[0].inputTokens[0].walletAddress).toBe(WALLET);
      expect(plan[0].outputToken.walletAddress).toBe(WALLET);
      // Output reflects the 0.25% Railgun shield fee.
      expect(plan[0].outputToken.amount).toBe(997_500_000_000_000_000n);
    });

    test("swaps to the destination token first, then shields", async () => {
      const sourceTokens: TokenAmount[] = [
        { token: USDC_ADDRESS, amount: 1_000_000n, chainId: 1, walletAddress: WALLET, symbol: "USDC", decimals: 6 },
      ];

      vi.mocked(getSwapQuote).mockResolvedValue({
        token: WETH_MAINNET,
        amount: 10_000_000_000_000_000n, // 0.01 WETH
        chainId: 1,
        walletAddress: WALLET,
        symbol: "WETH",
        decimals: 18,
      });

      const plan = await planConsolidation(sourceTokens, railgunDestination(), [WALLET]);

      expect(plan.map((s) => s.type)).toEqual(["swap", "shield"]);
      const shield = plan[1];
      expect(shield.inputTokens[0].amount).toBe(10_000_000_000_000_000n);
      // 0.01 WETH minus 0.25% fee
      expect(shield.outputToken.amount).toBe(9_975_000_000_000_000n);
      expect(shield.railgunAddress).toBe(RAILGUN_ALL_CHAINS);
    });

    test("accepts an address bound to the destination chain", async () => {
      const sourceTokens: TokenAmount[] = [
        { token: WETH_MAINNET, amount: 10n ** 18n, chainId: 1, walletAddress: WALLET, symbol: "WETH", decimals: 18 },
      ];

      const plan = await planConsolidation(sourceTokens, railgunDestination({ railgunAddress: RAILGUN_MAINNET }), [
        WALLET,
      ]);
      expect(plan.at(-1)?.type).toBe("shield");
      expect(plan.at(-1)?.railgunAddress).toBe(RAILGUN_MAINNET);
    });

    test("multi-chain sources bridge and swap first, then shield last", async () => {
      const sourceTokens: TokenAmount[] = [
        { token: USDC_OPTIMISM, amount: 100_000_000n, chainId: 10, walletAddress: WALLET, symbol: "USDC", decimals: 6 },
      ];

      vi.mocked(getBridgeFee).mockResolvedValue(0n);
      // Final swap on mainnet: bridged USDC -> WETH
      vi.mocked(getSwapQuote).mockResolvedValue({
        token: WETH_MAINNET,
        amount: 30_000_000_000_000_000n, // 0.03 WETH
        chainId: 1,
        walletAddress: WALLET,
        symbol: "WETH",
        decimals: 18,
      });

      const plan = await planConsolidation(sourceTokens, railgunDestination(), [WALLET]);

      const types = plan.map((s) => s.type);
      expect(types).toContain("bridge");
      expect(types).toContain("attestation");
      expect(types).toContain("claim");
      expect(types.at(-1)).toBe("shield");
      // Shield consumes the final swap output, minus the 0.25% fee.
      const shield = plan.at(-1) as TransactionStep;
      expect(shield.outputToken.amount).toBe(29_925_000_000_000_000n);
    });

    test("rejects a chain where Railgun is not deployed (Base)", async () => {
      const sourceTokens: TokenAmount[] = [
        { token: USDC_ADDRESS, amount: 1_000_000n, chainId: 1, walletAddress: WALLET, symbol: "USDC", decimals: 6 },
      ];

      await expect(
        planConsolidation(
          sourceTokens,
          railgunDestination({
            chainId: 8453,
            token: "0x4200000000000000000000000000000000000006" as Address,
          }),
          [WALLET],
        ),
      ).rejects.toThrow(/Railgun is not deployed/);
    });

    test("rejects a native destination token", async () => {
      const sourceTokens: TokenAmount[] = [
        { token: USDC_ADDRESS, amount: 1_000_000n, chainId: 1, walletAddress: WALLET, symbol: "USDC", decimals: 6 },
      ];

      await expect(
        planConsolidation(sourceTokens, railgunDestination({ token: ETH_ADDRESS, symbol: "ETH" }), [WALLET]),
      ).rejects.toThrow(/cannot be shielded/);
    });

    test("rejects an invalid 0zk address", async () => {
      const sourceTokens: TokenAmount[] = [
        { token: USDC_ADDRESS, amount: 1_000_000n, chainId: 1, walletAddress: WALLET, symbol: "USDC", decimals: 6 },
      ];

      await expect(
        planConsolidation(sourceTokens, railgunDestination({ railgunAddress: "0zk1notvalid" }), [WALLET]),
      ).rejects.toThrow(/Invalid Railgun/);
    });

    test("rejects a chain-bound address used on a different chain", async () => {
      const sourceTokens: TokenAmount[] = [
        { token: USDC_ADDRESS, amount: 1_000_000n, chainId: 1, walletAddress: WALLET, symbol: "USDC", decimals: 6 },
      ];

      await expect(
        planConsolidation(
          sourceTokens,
          railgunDestination({
            chainId: 137,
            token: WETH_POLYGON,
            railgunAddress: RAILGUN_MAINNET, // bound to chain 1
          }),
          [WALLET],
        ),
      ).rejects.toThrow(/bound to chain 1/);
    });
  });
});
