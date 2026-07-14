import { USDC_ETHEREUM as USDC_ADDRESS, USDC_OPTIMISM, WALLET } from "test/test-helpers";
import type { Address } from "viem";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { AccountsMap, SmartAccount } from "./accounts";
import type { TokenAmount, TransactionStep } from "./types";

// Mock external dependencies BEFORE imports (mirrors planning-safe.test.ts)
vi.mock("./delora");
vi.mock("./cctp");
vi.mock("./public-client", () => ({
  getPublicClient: vi.fn(() => ({
    getCode: vi.fn(({ address }: { address: string }) =>
      Promise.resolve(address.toLowerCase() === SMART.toLowerCase() ? "0x608060" : "0x"),
    ),
  })),
}));
vi.mock("./gas", () => ({
  getNativeBalance: vi.fn().mockResolvedValue(10_000_000_000_000_000_000n),
  findRichestSource: vi.fn().mockResolvedValue(null),
}));
vi.mock("./api/delora", () => ({
  fetchDeloraPrices: vi.fn().mockResolvedValue(new Map()),
  deloraPriceKey: (chainId: number, address: string) => `${chainId}:${address.toLowerCase()}`,
}));
vi.mock("./gas-refuel", () => ({
  getGasRefuelQuote: vi.fn(),
}));
vi.mock("./railgun", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./railgun")>()),
  isRailgunAddress: (address?: string) => typeof address === "string" && address.startsWith("0zk"),
  decodeRailgunAddress: () => ({}),
}));
vi.mock("./gas-estimation", () => ({
  buildGasContext: vi.fn().mockResolvedValue({
    maxFeePerGas: { 1: 20000000000n, 10: 1000000n, 100: 1500000000n, 8453: 10000000n },
    nativeSymbol: { 1: "ETH", 10: "ETH", 100: "XDAI", 8453: "ETH" },
  }),
  estimateChainGasCosts: vi.fn().mockResolvedValue({
    totalGasCost: 100000000000000n,
    maxFeePerGas: 20000000000n,
    perOperation: [],
  }),
  estimateOperationsForChainWallet: vi.fn().mockReturnValue(["swap"]),
  estimateDestinationChainOperations: vi.fn().mockReturnValue(["cctp-claim", "swap"]),
  attachGasEstimates: vi.fn(async (steps: TransactionStep[]) => {
    for (const step of steps) {
      if (step.type === "attestation" || step.type === "gas-topup-wait" || step.type === "gnosis-wait") continue;
      step.estimatedGas = {
        gasUnits: 5000n,
        maxFeePerGas: 20000000000n,
        gasCostWei: 100000000000000n,
        nativeSymbol: "ETH",
        source: "budget",
      };
    }
  }),
  measureOpsGas: vi.fn().mockResolvedValue(500000000000000n),
  buildSwapLegSimOps: vi.fn(() => []),
  buildBridgeSimOps: vi.fn(() => []),
  buildOmnibridgeSimOps: vi.fn(() => []),
  emptyPlanArtifacts: () => ({ swapLegs: new Map() }),
  formatGasCostNative: vi.fn((wei: bigint) => (Number(wei) / 1e18).toString()),
}));

import { getBridgeFee } from "./cctp";
import { getSwapQuote, getSwapQuoteWithLegs } from "./delora";
import { planConsolidation } from "./planning";
import { getPublicClient } from "./public-client";

const SMART = "0x4444444444444444444444444444444444444444" as Address;
const TOKEN_A = "0x00000000000000000000000000000000000000aa" as Address;
const TOKEN_B = "0x00000000000000000000000000000000000000bb" as Address;

function smartAccounts(deployedChains: number[], atomic = true): AccountsMap {
  const smart: SmartAccount = {
    kind: "smart",
    address: SMART,
    deployments: Object.fromEntries(
      deployedChains.map((chainId) => [chainId, { chainId, atomic: atomic ? "supported" : "unknown" }]),
    ),
    fetchedAt: 0,
  };
  return new Map([[SMART.toLowerCase(), smart]]);
}

const erc20 = (
  token: Address,
  amount: bigint,
  chainId: number,
  walletAddress: Address,
  symbol: string,
): TokenAmount => ({
  token,
  amount,
  chainId,
  walletAddress,
  symbol,
  decimals: 18,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSwapQuoteWithLegs).mockImplementation(async (input, output) => ({
    output: await getSwapQuote(input, output),
    legs: [],
  }));
  vi.mocked(getPublicClient).mockImplementation(
    () =>
      ({
        getCode: vi.fn(({ address }: { address: string }) =>
          Promise.resolve(address.toLowerCase() === SMART.toLowerCase() ? "0x608060" : "0x"),
        ),
      }) as never,
  );
});

describe("planConsolidation with an ERC-4337 smart-wallet source", () => {
  test("tags smart steps and groups independent swaps into one atomic bundle", async () => {
    const sourceTokens = [
      erc20(TOKEN_A, 10n ** 18n, 10, SMART, "AAA"),
      erc20(TOKEN_B, 2n * 10n ** 18n, 10, SMART, "BBB"),
    ];
    // Destination: the smart account itself on mainnet (connected) — it acts
    // as its own intermediate, like any connected wallet.
    const destinationToken = { token: USDC_ADDRESS, chainId: 1, walletAddress: SMART, symbol: "USDC", decimals: 6 };

    vi.mocked(getSwapQuote).mockResolvedValue({
      token: USDC_OPTIMISM,
      amount: 1_000_000n,
      chainId: 10,
      walletAddress: SMART,
      symbol: "USDC",
      decimals: 6,
    });
    vi.mocked(getBridgeFee).mockResolvedValue(0n);

    const steps = await planConsolidation(
      sourceTokens,
      destinationToken,
      [WALLET, SMART],
      undefined,
      smartAccounts([10, 1]),
    );

    const swaps = steps.filter((s) => s.type === "swap");
    expect(swaps).toHaveLength(2);
    for (const swap of swaps) {
      expect(swap.execution).toMatchObject({ via: "smart", smartAddress: SMART, atomic: true });
    }
    // Independent swaps on the same chain share one atomic bundle.
    expect(swaps[0].execution?.batchId).toBe(swaps[1].execution?.batchId);

    // The bridge mints straight into the smart account (its own intermediate).
    const claim = steps.find((s) => s.type === "claim");
    expect(claim?.outputToken.walletAddress).toBe(SMART);

    // Wrapper gas overhead charged once per bundle.
    const boosted = swaps.filter((s) => (s.estimatedGas?.gasUnits ?? 0n) > 5000n);
    expect(boosted).toHaveLength(1);
  });

  test("without atomic capability every step gets a singleton bundle", async () => {
    const sourceTokens = [
      erc20(TOKEN_A, 10n ** 18n, 10, SMART, "AAA"),
      erc20(TOKEN_B, 2n * 10n ** 18n, 10, SMART, "BBB"),
    ];
    const destinationToken = { token: USDC_ADDRESS, chainId: 1, walletAddress: SMART, symbol: "USDC", decimals: 6 };

    vi.mocked(getSwapQuote).mockResolvedValue({
      token: USDC_OPTIMISM,
      amount: 1_000_000n,
      chainId: 10,
      walletAddress: SMART,
      symbol: "USDC",
      decimals: 6,
    });
    vi.mocked(getBridgeFee).mockResolvedValue(0n);

    const steps = await planConsolidation(
      sourceTokens,
      destinationToken,
      [WALLET, SMART],
      undefined,
      smartAccounts([10, 1], false),
    );

    const swaps = steps.filter((s) => s.type === "swap");
    expect(swaps).toHaveLength(2);
    expect(swaps[0].execution?.via).toBe("smart");
    expect(swaps[0].execution?.batchId).not.toBe(swaps[1].execution?.batchId);
  });

  test("smart and EOA sources mix freely (unlike Safes)", async () => {
    const sourceTokens = [
      erc20(USDC_OPTIMISM, 5_000_000n, 10, SMART, "USDC"),
      erc20(USDC_OPTIMISM, 5_000_000n, 10, WALLET, "USDC"),
    ];
    const destinationToken = { token: USDC_ADDRESS, chainId: 1, walletAddress: WALLET, symbol: "USDC", decimals: 6 };
    vi.mocked(getBridgeFee).mockResolvedValue(0n);

    const steps = await planConsolidation(
      sourceTokens,
      destinationToken,
      [WALLET, SMART],
      undefined,
      smartAccounts([10, 1]),
    );

    // One bridge per wallet, each routed by its own account kind.
    const bridges = steps.filter((s) => s.type === "bridge");
    expect(bridges).toHaveLength(2);
    const smartBridge = bridges.find((s) => s.inputTokens[0].walletAddress === SMART);
    const eoaBridge = bridges.find((s) => s.inputTokens[0].walletAddress === WALLET);
    expect(smartBridge?.execution?.via).toBe("smart");
    expect(eoaBridge?.execution).toBeUndefined();
  });

  test("rejects a smart-wallet source token on a chain without verified code", async () => {
    const sourceTokens = [erc20(TOKEN_A, 10n ** 18n, 8453, SMART, "AAA")];
    const destinationToken = { token: USDC_ADDRESS, chainId: 1, walletAddress: WALLET, symbol: "USDC", decimals: 6 };

    await expect(
      planConsolidation(sourceTokens, destinationToken, [WALLET, SMART], undefined, smartAccounts([10])),
    ).rejects.toThrow(/SmartAccountNotDeployedError/);
  });

  test("Railgun destinations work with smart-wallet sources: the smart wallet shields", async () => {
    // SMART is the only connected wallet — it must serve as the shielding
    // intermediate (random ephemeral shield key; no EOA in the session).
    const sourceTokens = [erc20(USDC_OPTIMISM, 5_000_000n, 10, SMART, "USDC")];
    const destinationToken = {
      token: USDC_ADDRESS,
      chainId: 1,
      walletAddress: "0x0000000000000000000000000000000000000000" as Address,
      symbol: "USDC",
      decimals: 6,
      railgunAddress: "0zk1qsyntheticaddressfortest",
    };
    vi.mocked(getBridgeFee).mockResolvedValue(0n);

    const steps = await planConsolidation(sourceTokens, destinationToken, [SMART], undefined, smartAccounts([10, 1]));

    const claim = steps.find((s) => s.type === "claim");
    expect(claim?.outputToken.walletAddress).toBe(SMART);

    const shield = steps.find((s) => s.type === "shield");
    expect(shield).toBeDefined();
    expect(shield?.inputTokens[0].walletAddress).toBe(SMART);
    expect(shield?.execution?.via).toBe("smart");
    expect(shield?.railgunAddress).toBe(destinationToken.railgunAddress);
  });

  test("a smart wallet is an eligible intermediate only where deployed", async () => {
    // EOA-held USDC bridging to an UNCONNECTED destination on mainnet; the
    // only other connected wallet is the smart account, deployed on [10]
    // only — it must NOT be picked as the mainnet intermediate.
    const STRANGER = "0x9999999999999999999999999999999999999999" as Address;
    const sourceTokens = [erc20(USDC_OPTIMISM, 5_000_000n, 10, WALLET, "USDC")];
    const destinationToken = { token: USDC_ADDRESS, chainId: 1, walletAddress: STRANGER, symbol: "USDC", decimals: 6 };
    vi.mocked(getBridgeFee).mockResolvedValue(0n);

    const steps = await planConsolidation(
      sourceTokens,
      destinationToken,
      [WALLET, SMART],
      undefined,
      smartAccounts([10]),
    );
    const claim = steps.find((s) => s.type === "claim");
    expect(claim?.outputToken.walletAddress).toBe(WALLET);

    // With mainnet code verified, the smart wallet becomes eligible (WALLET
    // still wins by search order, but eligibility is what we assert): make it
    // the ONLY connected wallet and check it is used.
    const steps2 = await planConsolidation(
      [erc20(USDC_OPTIMISM, 5_000_000n, 10, SMART, "USDC")],
      destinationToken,
      [SMART],
      undefined,
      smartAccounts([10, 1]),
    );
    const claim2 = steps2.find((s) => s.type === "claim");
    expect(claim2?.outputToken.walletAddress).toBe(SMART);
    const transfer2 = steps2.find((s) => s.type === "transfer");
    expect(transfer2?.execution?.via).toBe("smart");
    expect(transfer2?.outputToken.walletAddress).toBe(STRANGER);
  });
});
