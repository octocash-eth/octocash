import { USDC_ETHEREUM as USDC_ADDRESS, USDC_OPTIMISM, WALLET, WBTC_ADDRESS } from "test/test-helpers";
import type { Address } from "viem";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { AccountsMap, SafeAccount } from "./accounts";
import type { TokenAmount, TransactionStep } from "./types";

// Mock external dependencies BEFORE imports (mirrors planning.test.ts)
vi.mock("./delora");
vi.mock("./cctp");
vi.mock("./public-client", () => ({
  getPublicClient: vi.fn(() => ({
    getCode: vi.fn(({ address }: { address: string }) =>
      // The Safe address reports contract code everywhere; EOAs report none.
      Promise.resolve(address.toLowerCase() === SAFE.toLowerCase() ? "0x608060" : "0x"),
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
vi.mock("./gas-refuel", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./gas-refuel")>()),
  getGasRefuelQuote: vi.fn(),
}));
// Accept the test's synthetic 0zk address so the Safe-mode Railgun rejection
// (not the address-format validation) is what the test exercises.
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

const SAFE = "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa" as Address;
const OWNER = "0x1111111111111111111111111111111111111111" as Address;
const TOKEN_A = "0x00000000000000000000000000000000000000aa" as Address;
const TOKEN_B = "0x00000000000000000000000000000000000000bb" as Address;

function safeAccounts(deployedChains: number[], threshold = 2): AccountsMap {
  const safe: SafeAccount = {
    kind: "safe",
    address: SAFE,
    ownerAddress: OWNER,
    deployments: Object.fromEntries(
      deployedChains.map((chainId) => [
        chainId,
        { chainId, owners: [OWNER], threshold, nonce: 0, version: "1.4.1", controlled: true },
      ]),
    ),
    fetchedAt: 0,
  };
  return new Map([[SAFE.toLowerCase(), safe]]);
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
  // clearAllMocks doesn't reset implementations — re-establish the default
  // (Safe has code everywhere, everything else is an EOA) so per-test
  // overrides can't leak forward.
  vi.mocked(getPublicClient).mockImplementation(
    () =>
      ({
        getCode: vi.fn(({ address }: { address: string }) =>
          Promise.resolve(address.toLowerCase() === SAFE.toLowerCase() ? "0x608060" : "0x"),
        ),
      }) as never,
  );
});

describe("planConsolidation with a Safe source", () => {
  test("tags Safe steps, batches independent swaps, and leaves the claim untagged", async () => {
    const sourceTokens = [
      erc20(TOKEN_A, 10n ** 18n, 10, SAFE, "AAA"),
      erc20(TOKEN_B, 2n * 10n ** 18n, 10, SAFE, "BBB"),
    ];
    const destinationToken = {
      token: USDC_ADDRESS,
      chainId: 1,
      walletAddress: WALLET,
      symbol: "USDC",
      decimals: 6,
    };

    vi.mocked(getSwapQuote).mockImplementation(async (inputs) => {
      const [first] = Array.isArray(inputs) ? inputs : [inputs];
      return {
        token: USDC_OPTIMISM,
        amount: first.token === TOKEN_A ? 1_000_000n : 2_000_000n,
        chainId: 10,
        walletAddress: SAFE,
        symbol: "USDC",
        decimals: 6,
      };
    });
    vi.mocked(getBridgeFee).mockResolvedValue(0n);

    const steps = await planConsolidation(
      sourceTokens,
      destinationToken,
      [WALLET, OWNER, SAFE],
      undefined,
      safeAccounts([10, 1]),
    );

    const swaps = steps.filter((s) => s.type === "swap");
    const bridge = steps.find((s) => s.type === "bridge");
    const claim = steps.find((s) => s.type === "claim");
    const transfer = steps.find((s) => s.type === "transfer");

    expect(swaps).toHaveLength(2);
    for (const swap of swaps) {
      expect(swap.execution).toMatchObject({
        via: "safe",
        safeAddress: SAFE,
        ownerAddress: OWNER,
        threshold: 2,
        safeVersion: "1.4.1",
      });
    }
    // Independent swaps from the same Safe on the same chain share one batch.
    expect(swaps[0].execution?.batchId).toBe(swaps[1].execution?.batchId);

    // The bridge consumes the swaps' outputs, so it starts its own group.
    expect(bridge?.execution?.via).toBe("safe");
    expect(bridge?.execution?.batchId).not.toBe(swaps[0].execution?.batchId);

    // The CCTP mint is permissionless — never a Safe transaction — but its
    // recipient is the SAFE (strict custody), never the EOA destination.
    expect(claim).toBeDefined();
    expect(claim?.execution).toBeUndefined();
    expect(claim?.outputToken.walletAddress).toBe(SAFE);

    // The EOA destination gets exactly one final transfer from the Safe.
    expect(transfer).toBeDefined();
    expect(transfer?.inputTokens[0].walletAddress).toBe(SAFE);
    expect(transfer?.outputToken.walletAddress).toBe(WALLET);
    expect(transfer?.execution?.via).toBe("safe");

    // Safe exec overhead is charged once per batch group: both swaps share a
    // group so exactly one of them carries the extra gas units.
    const boosted = swaps.filter((s) => (s.estimatedGas?.gasUnits ?? 0n) > 5000n);
    expect(boosted).toHaveLength(1);
  });

  test("rejects a Safe source token on a chain without a controlled deployment", async () => {
    const sourceTokens = [erc20(TOKEN_A, 10n ** 18n, 8453, SAFE, "AAA")];
    const destinationToken = { token: USDC_ADDRESS, chainId: 1, walletAddress: WALLET, symbol: "USDC", decimals: 6 };

    await expect(
      planConsolidation(sourceTokens, destinationToken, [WALLET, OWNER, SAFE], undefined, safeAccounts([10])),
    ).rejects.toThrow(/SafeNotDeployedError.*8453|SafeNotDeployedError.*Base/);
  });

  test("strict custody: an UNCONNECTED EOA destination still gets a Safe intermediate + final transfer", async () => {
    const STRANGER = "0x9999999999999999999999999999999999999999" as Address;
    const sourceTokens = [erc20(USDC_OPTIMISM, 5_000_000n, 10, SAFE, "USDC")];
    const destinationToken = { token: USDC_ADDRESS, chainId: 1, walletAddress: STRANGER, symbol: "USDC", decimals: 6 };
    vi.mocked(getBridgeFee).mockResolvedValue(0n);

    const steps = await planConsolidation(
      sourceTokens,
      destinationToken,
      [OWNER, SAFE],
      undefined,
      safeAccounts([10, 1]),
    );

    // Bridged USDC mints into the SAFE on mainnet, never onto any EOA.
    const claim = steps.find((s) => s.type === "claim");
    expect(claim?.outputToken.walletAddress).toBe(SAFE);

    const transfer = steps.find((s) => s.type === "transfer");
    expect(transfer?.inputTokens[0].walletAddress).toBe(SAFE);
    expect(transfer?.outputToken.walletAddress).toBe(STRANGER);
    expect(transfer?.execution?.via).toBe("safe");
  });

  test("the final swap pays out directly to the destination wallet — no trailing transfer", async () => {
    const STRANGER = "0x9999999999999999999999999999999999999999" as Address;
    const sourceTokens = [erc20(USDC_OPTIMISM, 5_000_000n, 10, SAFE, "USDC")];
    // Destination WBTC at an EOA: the Safe executes the final swap and the
    // router delivers WBTC straight to the destination — full actual amount,
    // one Safe transaction, no transfer step and no floor dust.
    const destinationToken = { token: WBTC_ADDRESS, chainId: 1, walletAddress: STRANGER, symbol: "WBTC", decimals: 8 };

    vi.mocked(getSwapQuote).mockImplementation(async (_inputs, output) => ({
      token: WBTC_ADDRESS,
      amount: 100_000n,
      chainId: 1,
      // Delora delivers to the quote target's wallet — the destination EOA.
      walletAddress: (output as TokenAmount).walletAddress,
      symbol: "WBTC",
      decimals: 8,
    }));
    vi.mocked(getBridgeFee).mockResolvedValue(0n);

    const steps = await planConsolidation(
      sourceTokens,
      destinationToken,
      [OWNER, SAFE],
      undefined,
      safeAccounts([10, 1]),
    );

    // Custody: the mint still lands on the SAFE...
    const claim = steps.find((s) => s.type === "claim");
    expect(claim?.outputToken.walletAddress).toBe(SAFE);

    // ...and the Safe-executed final swap pays the destination directly.
    const finalSwap = steps.find((s) => s.type === "swap" && s.chainId === 1);
    expect(finalSwap?.execution?.via).toBe("safe");
    expect(finalSwap?.inputTokens[0].walletAddress).toBe(SAFE);
    expect(finalSwap?.outputToken.walletAddress).toBe(STRANGER);
    expect(steps.filter((s) => s.type === "transfer")).toHaveLength(0);
  });

  test("rejects a destination chain where no candidate Safe is controlled", async () => {
    const sourceTokens = [erc20(USDC_OPTIMISM, 5_000_000n, 10, SAFE, "USDC")];
    // Destination on Base: the Safe is controlled on Optimism only, and the
    // destination is a plain EOA — no Safe can custody the bridged funds.
    const destinationToken = { token: USDC_ADDRESS, chainId: 8453, walletAddress: WALLET, symbol: "USDC", decimals: 6 };
    vi.mocked(getBridgeFee).mockResolvedValue(0n);

    await expect(
      planConsolidation(sourceTokens, destinationToken, [WALLET, OWNER, SAFE], undefined, safeAccounts([10])),
    ).rejects.toThrow(/None of your Safes is deployed on Base/);
  });

  test("rejects plans mixing Safe-held and EOA-held sources", async () => {
    const sourceTokens = [
      erc20(USDC_OPTIMISM, 5_000_000n, 10, SAFE, "USDC"),
      erc20(USDC_OPTIMISM, 5_000_000n, 10, WALLET, "USDC"),
    ];
    const destinationToken = { token: USDC_ADDRESS, chainId: 1, walletAddress: WALLET, symbol: "USDC", decimals: 6 };

    await expect(
      planConsolidation(sourceTokens, destinationToken, [WALLET, OWNER, SAFE], undefined, safeAccounts([10, 1])),
    ).rejects.toThrow(/separate runs.*Addresses and Safes tabs/s);
  });

  test("Railgun destinations work with Safe-held sources: the SAFE shields (no EOA custody)", async () => {
    const sourceTokens = [erc20(USDC_OPTIMISM, 5_000_000n, 10, SAFE, "USDC")];
    const destinationToken = {
      token: USDC_ADDRESS,
      chainId: 1,
      walletAddress: "0x0000000000000000000000000000000000000000" as Address,
      symbol: "USDC",
      decimals: 6,
      railgunAddress:
        "0zk1qyqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq",
    };
    vi.mocked(getBridgeFee).mockResolvedValue(0n);

    const steps = await planConsolidation(
      sourceTokens,
      destinationToken,
      [WALLET, OWNER, SAFE],
      undefined,
      safeAccounts([10, 1]),
    );

    // Bridged USDC mints into the SAFE (Safe mode: the intermediate is a
    // source Safe controlled on the destination chain)...
    const claim = steps.find((s) => s.type === "claim");
    expect(claim?.outputToken.walletAddress).toBe(SAFE);

    // ...and the SAFE itself deposits into Railgun as a Safe transaction —
    // the shield key comes from the owner EOA's signature, never the funds.
    const shield = steps.find((s) => s.type === "shield");
    expect(shield).toBeDefined();
    expect(shield?.inputTokens[0].walletAddress).toBe(SAFE);
    expect(shield?.execution?.via).toBe("safe");
    expect(shield?.railgunAddress).toBe(destinationToken.railgunAddress);
  });

  test("still rejects unregistered contract wallets, pointing at the Safe flow", async () => {
    const CONTRACT = "0xCcCCccccCCCCcCCCCCCcCcCcCCCcCcccccccCccC" as Address;
    vi.mocked(getPublicClient).mockImplementation(
      () =>
        ({
          getCode: vi.fn(({ address }: { address: string }) =>
            Promise.resolve(address.toLowerCase() === CONTRACT.toLowerCase() ? "0x608060" : "0x"),
          ),
        }) as never,
    );

    const sourceTokens = [erc20(TOKEN_A, 10n ** 18n, 10, CONTRACT, "AAA")];
    const destinationToken = { token: USDC_ADDRESS, chainId: 1, walletAddress: WALLET, symbol: "USDC", decimals: 6 };

    await expect(
      planConsolidation(sourceTokens, destinationToken, [WALLET, CONTRACT], undefined, undefined),
    ).rejects.toThrow(/Smart-account wallets must be detected before use.*Safe accounts panel/s);
  });
});

describe("planConsolidation with a Safe destination", () => {
  test("a controlled Safe destination is its own intermediate: bridge mints into it, final swap is a Safe tx", async () => {
    const sourceTokens = [erc20(USDC_OPTIMISM, 5_000_000n, 10, WALLET, "USDC")];
    const destinationToken = {
      token: WBTC_ADDRESS,
      chainId: 1,
      walletAddress: SAFE,
      symbol: "WBTC",
      decimals: 8,
    };

    vi.mocked(getSwapQuote).mockResolvedValue({
      token: WBTC_ADDRESS,
      amount: 100000n,
      chainId: 1,
      walletAddress: SAFE,
      symbol: "WBTC",
      decimals: 8,
    });
    vi.mocked(getBridgeFee).mockResolvedValue(0n);

    const steps = await planConsolidation(
      sourceTokens,
      destinationToken,
      [WALLET, OWNER, SAFE],
      undefined,
      safeAccounts([1]),
    );

    const claim = steps.find((s) => s.type === "claim");
    expect(claim?.outputToken.walletAddress).toBe(SAFE);
    expect(claim?.execution).toBeUndefined();

    const finalSwap = steps.find((s) => s.type === "swap" && s.chainId === 1);
    expect(finalSwap?.inputTokens[0].walletAddress).toBe(SAFE);
    expect(finalSwap?.execution?.via).toBe("safe");

    // No trailing transfer: the Safe destination holds the result directly.
    expect(steps.filter((s) => s.type === "transfer")).toHaveLength(0);
  });

  test("rejects a Gnosis route whose mainnet hub would be a Safe not controlled there", async () => {
    const sourceTokens = [erc20(USDC_OPTIMISM, 50_000_000n, 10, WALLET, "USDC")];
    const destinationToken = {
      token: USDC_ADDRESS,
      chainId: 100,
      walletAddress: SAFE,
      symbol: "USDC",
      decimals: 6,
    };

    await expect(
      planConsolidation(
        sourceTokens,
        destinationToken,
        [WALLET, OWNER, SAFE],
        undefined,
        safeAccounts([100]), // controlled on Gnosis only, not on mainnet
      ),
    ).rejects.toThrow(/mainnet hop.*isn't\s+deployed|PlanningError: This route needs an Ethereum mainnet hop/s);
  });
});
