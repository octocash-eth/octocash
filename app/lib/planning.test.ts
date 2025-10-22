import { ETH_ADDRESS, USDC_ETHEREUM as USDC_ADDRESS, USDC_OPTIMISM, WALLET, WBTC_ADDRESS } from "test/helpers";
import type { Address } from "viem";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { TokenAmount, TransactionStep } from "./types";

// Mock external dependencies BEFORE imports
vi.mock("./odos");
vi.mock("./cctp");
vi.mock("./gas", () => ({
  ensureSufficientGas: vi.fn().mockResolvedValue(undefined),
  getNativeBalance: vi.fn().mockResolvedValue(1000000000000000000n), // 1 ETH
}));

import { getBridgeFee } from "./cctp";
import { getSwapQuote } from "./odos";
import { planConsolidation } from "./planning";

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

    const result = await planConsolidation(sourceTokens, destinationToken);

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("swap");
    expect(result[0].chainId).toBe(1);
    expect(result[0].dependsOn).toEqual([]);
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

    const result = await planConsolidation(sourceTokens, destinationToken);

    // Should have: swap, bridge, bridge, attestation, claim, swap
    expect(result.length).toBeGreaterThanOrEqual(5);

    // Check for required transaction types
    const types = result.map((s: TransactionStep) => s.type);
    expect(types).toContain("swap");
    expect(types).toContain("bridge");
    expect(types).toContain("attestation");
    expect(types).toContain("claim");

    // Attestation should have partialDependency=true
    const attestation = result.find((s: TransactionStep) => s.type === "attestation");
    expect(attestation?.partialDependency).toBe(true);

    // Claim should have partialDependency=true
    const claim = result.find((s: TransactionStep) => s.type === "claim");
    expect(claim?.partialDependency).toBe(true);
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

    const result = await planConsolidation(sourceTokens, destinationToken);

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

    const result = await planConsolidation(sourceTokens, destinationToken);

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

    const result = await planConsolidation(sourceTokens, destinationToken);

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

    await expect(planConsolidation(sourceTokens, destinationToken)).rejects.toThrow("PlanningError");
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

    await expect(planConsolidation(sourceTokens, destinationToken)).rejects.toThrow("UnsupportedRouteError");
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

    await expect(planConsolidation(sourceTokens, destinationToken)).rejects.toThrow("UnsupportedRouteError");
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

    await expect(planConsolidation(sourceTokens, destinationToken)).rejects.toThrow("ExternalAPIError");
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

    const result = await planConsolidation(sourceTokens, destinationToken);

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

    const result = await planConsolidation(sourceTokens, destinationToken);

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

    await expect(planConsolidation(sourceTokens, destinationToken)).rejects.toThrow(
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

    await expect(planConsolidation(sourceTokens, destinationToken)).rejects.toThrow(
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

    const result = await planConsolidation(sourceTokens, destinationToken);

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

    const result = await planConsolidation(sourceTokens, destinationToken, logSpy);

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

    const result = await planConsolidation(sourceTokens, destinationToken);

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

    // Verify all bridge steps have no dependencies (no swaps on this chain)
    for (const bridgeStep of bridgeSteps) {
      expect(bridgeStep.dependsOn).toEqual([]);
    }

    // Verify attestation depends on all 3 bridge steps
    const attestationStep = result.find((s: TransactionStep) => s.type === "attestation");
    expect(attestationStep?.dependsOn.length).toBe(3);
    expect(attestationStep?.dependsOn).toContain(wallet1BridgeStep?.id);
    expect(attestationStep?.dependsOn).toContain(wallet2BridgeStep?.id);
    expect(attestationStep?.dependsOn).toContain(wallet3BridgeStep?.id);
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

    const result = await planConsolidation(sourceTokens, destinationToken);

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

    const result = await planConsolidation(sourceTokens, destinationToken);

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

    const result = await planConsolidation(sourceTokens, destinationToken);

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

    const result = await planConsolidation(sourceTokens, destinationToken);

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

    const result = await planConsolidation(sourceTokens, destinationToken);

    const bridgeStep = result.find((s) => s.type === "bridge");

    expect(bridgeStep).toBeDefined();
    // Existing USDC should not have provenance (it didn't come from a step)
    expect(bridgeStep?.inputTokens[0].provenance).toBeUndefined();
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

    const result = await planConsolidation(sourceTokens, destinationToken);

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

    // Transfer should have no dependencies since no bridges
    expect(transferStep.dependsOn).toEqual([]);
    expect(transferStep.partialDependency).toBe(false);

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

    const result = await planConsolidation(sourceTokens, destinationToken);

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

    const result = await planConsolidation(sourceTokens, destinationToken);

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
});
