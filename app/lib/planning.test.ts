import { ETH_ADDRESS, USDC_ETHEREUM as USDC_ADDRESS, USDC_OPTIMISM, WALLET, WBTC_ADDRESS } from "test/test-helpers";
import type { Address } from "viem";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { TokenAmount, TransactionStep } from "./types";

// Mock external dependencies BEFORE imports
vi.mock("./odos");
vi.mock("./cctp");
vi.mock("./public-client", () => ({
  getPublicClient: vi.fn(() => ({
    getCode: vi.fn().mockResolvedValue("0x"),
  })),
}));
vi.mock("./gas", () => ({
  getNativeBalance: vi.fn().mockResolvedValue(1000000000000000000n), // 1 ETH
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
  attachGasEstimates: vi.fn(),
  formatGasCostNative: vi.fn((wei: bigint) => (Number(wei) / 1e18).toString()),
}));

import { getBridgeFee } from "./cctp";
import { getSwapQuote } from "./odos";
import { planConsolidation } from "./planning";
import { getPublicClient } from "./public-client";

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

  test("batching - more than 6 tokens should create multiple batches", async () => {
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

    // Check if tokens are split into multiple batches (max 6 per batch)
    const swapSteps = result.filter((s: TransactionStep) => s.type === "swap");
    expect(swapSteps.length).toBe(2); // Should be 2 swap steps (6 + 2 tokens)
    expect(swapSteps[0].inputTokens.length).toBe(6); // First batch should have 6 tokens
    expect(swapSteps[1].inputTokens.length).toBe(2); // Second batch should have 2 tokens
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

    vi.mocked(getSwapQuote).mockRejectedValue(new Error("API unavailable"));

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
    expect(logCalls).toContain("already destination token");
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

  test("provenance tracking - batched swaps should each have unique provenance", async () => {
    // Create 8 tokens on the same chain to trigger batching
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

    // Should have 2 swap steps due to batching
    expect(swapSteps).toHaveLength(2);

    // Each swap should have unique provenance
    expect(swapSteps[0].outputToken.provenance).toBe(swapSteps[0].id);
    expect(swapSteps[1].outputToken.provenance).toBe(swapSteps[1].id);
    expect(swapSteps[0].id).not.toBe(swapSteps[1].id);
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
    test("USDC-only source wallet still gets a gas check (regression)", async () => {
      // Regression: previously, a USDC-only wallet skipped the entire gas check
      // because it had no swaps to do — but the CCTP burn still requires native gas.
      const { getNativeBalance } = await import("./gas");
      const { estimateChainGasCosts, estimateOperationsForChainWallet } = await import("./gas-estimation");

      // Wallet has 0.0000001 ETH for gas; required is 0.001 ETH.
      vi.mocked(getNativeBalance).mockResolvedValue(100_000_000_000n);
      vi.mocked(estimateChainGasCosts).mockResolvedValue({
        totalGasCost: 1_000_000_000_000_000n, // 0.001 ETH
        maxFeePerGas: 20_000_000_000n,
        perOperation: [],
      });
      vi.mocked(estimateOperationsForChainWallet).mockReturnValue(["cctp-approval", "cctp-burn"]);
      vi.mocked(getBridgeFee).mockResolvedValue(0n);

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

      await expect(planConsolidation(sourceTokens, destinationToken, [WALLET])).rejects.toThrow(/Insufficient gas/);

      // Restore defaults so subsequent tests aren't polluted
      vi.mocked(getNativeBalance).mockResolvedValue(1_000_000_000_000_000_000n);
      vi.mocked(estimateChainGasCosts).mockResolvedValue({
        totalGasCost: 100_000_000_000_000n,
        maxFeePerGas: 20_000_000_000n,
        perOperation: [],
      });
    });

    test("ERC20-only source wallet (no native, no USDC) still gets a gas check", async () => {
      const { getNativeBalance } = await import("./gas");
      const { estimateChainGasCosts } = await import("./gas-estimation");

      // 0 native available → cannot pay any gas
      vi.mocked(getNativeBalance).mockResolvedValue(0n);
      vi.mocked(estimateChainGasCosts).mockResolvedValue({
        totalGasCost: 500_000_000_000_000n,
        maxFeePerGas: 20_000_000_000n,
        perOperation: [],
      });
      vi.mocked(getBridgeFee).mockResolvedValue(0n);

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

      await expect(planConsolidation(sourceTokens, destinationToken, [WALLET])).rejects.toThrow(/Insufficient gas/);

      vi.mocked(getNativeBalance).mockResolvedValue(1_000_000_000_000_000_000n);
      vi.mocked(estimateChainGasCosts).mockResolvedValue({
        totalGasCost: 100_000_000_000_000n,
        maxFeePerGas: 20_000_000_000n,
        perOperation: [],
      });
    });

    test("destination wallet runs out of gas after planning succeeds for sources", async () => {
      // The connected destination wallet has source-chain balance but no dest gas.
      const { getNativeBalance } = await import("./gas");
      const { estimateChainGasCosts } = await import("./gas-estimation");

      // First call (resolveIntermediateWallet, dest chain) → 0
      // Subsequent calls (source chain checks) → plenty
      vi.mocked(getNativeBalance).mockResolvedValueOnce(0n).mockResolvedValue(1_000_000_000_000_000_000n);

      vi.mocked(estimateChainGasCosts).mockResolvedValue({
        totalGasCost: 500_000_000_000_000n,
        maxFeePerGas: 20_000_000_000n,
        perOperation: [],
      });
      vi.mocked(getBridgeFee).mockResolvedValue(0n);

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

      await expect(planConsolidation(sourceTokens, destinationToken, [WALLET])).rejects.toThrow(/Insufficient gas/);

      vi.mocked(getNativeBalance).mockResolvedValue(1_000_000_000_000_000_000n);
      vi.mocked(estimateChainGasCosts).mockResolvedValue({
        totalGasCost: 100_000_000_000_000n,
        maxFeePerGas: 20_000_000_000n,
        perOperation: [],
      });
    });

    test("native source token amount is trimmed when gas exceeds free balance", async () => {
      // Native balance: 1 ETH; gas: 0.1 ETH; user wants to swap 1 ETH.
      // Plan should trim to 0.9 ETH instead of failing.
      const { getNativeBalance } = await import("./gas");
      const { estimateChainGasCosts } = await import("./gas-estimation");

      vi.mocked(getNativeBalance).mockResolvedValue(1_000_000_000_000_000_000n); // 1 ETH
      vi.mocked(estimateChainGasCosts).mockResolvedValue({
        totalGasCost: 100_000_000_000_000_000n, // 0.1 ETH
        maxFeePerGas: 20_000_000_000n,
        perOperation: [],
      });
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

      vi.mocked(estimateChainGasCosts).mockResolvedValue({
        totalGasCost: 100_000_000_000_000n,
        maxFeePerGas: 20_000_000_000n,
        perOperation: [],
      });
    });

    test("native-only source throws a dedicated 'consumed by gas' error when gas equals or exceeds full balance", async () => {
      const { getNativeBalance } = await import("./gas");
      const { estimateChainGasCosts } = await import("./gas-estimation");

      // Balance equals required gas — nothing left for swap. Silently dropping
      // the user's only selected token would yield an empty plan with no
      // explanation in the UI. The planner must surface a dedicated message
      // — not the generic "top up gas" copy — explaining that the selected
      // native would be fully spent on fees and pointing at the actionable
      // remedies (deselect / lower amount / fund the wallet).
      vi.mocked(getNativeBalance).mockResolvedValue(100_000_000_000_000_000n); // 0.1 ETH
      vi.mocked(estimateChainGasCosts).mockResolvedValue({
        totalGasCost: 100_000_000_000_000_000n, // 0.1 ETH (eats everything)
        maxFeePerGas: 20_000_000_000n,
        perOperation: [],
      });
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
        /Not enough ETH .* entirely spent on fees/,
      );
      await expect(planConsolidation(sourceTokens, destinationToken, [WALLET])).rejects.toThrow(
        /Deselect ETH, lower its amount, or add more ETH/,
      );

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
});
