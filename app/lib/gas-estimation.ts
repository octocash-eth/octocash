import type { Address, Chain } from "viem";
import { formatUnits, isAddressEqual, zeroAddress } from "viem";
import { chains } from "~/data/supported-chains";
import { getPublicClient, retryOnRateLimit } from "./public-client";
import type { TransactionStep } from "./types";

// Note: native-token USD pricing is intentionally not handled here. Gas costs are
// tracked in native wei; fiat conversion belongs at the UI layer (see
// `GasCostTooltip` in `plan-card.tsx`, which reads native price via
// `usePrice(chainId, zeroAddress)` and formats with `useFormatFiat`).

export type OperationType =
  | "erc20-approval"
  | "swap"
  | "swap-multi"
  | "cctp-approval"
  | "cctp-burn"
  | "cctp-claim"
  | "transfer-native"
  | "transfer-erc20";

/**
 * Per-operation gas unit budgets. These are conservative upper bounds derived from
 * observed mainnet/L2 traces; they intentionally err on the high side so the
 * SAFETY_BUFFER_PCT below is mostly defensive rather than corrective. Update if
 * underlying contracts (CCTP, Odos router) change materially.
 */
const GAS_BUDGETS: Record<OperationType, bigint> = {
  "erc20-approval": 65_000n,
  swap: 500_000n,
  "swap-multi": 800_000n,
  "cctp-approval": 65_000n,
  "cctp-burn": 200_000n,
  "cctp-claim": 300_000n,
  "transfer-native": 21_000n,
  "transfer-erc20": 65_000n,
};

/** Multiplier applied to raw gas cost. 130 = +30%. */
const SAFETY_BUFFER_PCT = 130n;

/**
 * Multiplier applied to live fee data so submitted transactions outbid the
 * "standard" tier and land within ~1 minute on slow chains (mainnet ~5 blocks
 * of headroom). Applied to both `maxFeePerGas` and `maxPriorityFeePerGas` and
 * fed into the same budget calc so reserved native covers the boosted price.
 * Calibrated to roughly match MetaMask's "Market" tier: viem's
 * `estimateFeesPerGas` derives from `eth_feeHistory` (historical/conservative),
 * while MetaMask uses a more aggressive oracle. 250 = +150%.
 */
const FAST_FEE_MULTIPLIER_PCT = 250n;

export interface GasEstimateResult {
  totalGasCost: bigint;
  maxFeePerGas: bigint;
  perOperation: { type: OperationType; gasUnits: bigint; gasCost: bigint }[];
}

/**
 * Estimates gas costs for a set of operations on a given chain.
 * Uses live fee data from the chain and per-operation gas budgets with a 30% safety buffer.
 *
 * @param chainId - The chain to estimate for
 * @param operations - List of operation types that will execute
 * @param maxFeePerGasOverride - Optional pre-fetched gas price to avoid duplicate RPC calls
 */
export async function estimateChainGasCosts(
  chainId: number,
  operations: OperationType[],
  maxFeePerGasOverride?: bigint,
): Promise<GasEstimateResult> {
  const maxFeePerGas = maxFeePerGasOverride ?? (await fetchMaxFeePerGas(chainId));

  const perOperation = operations.map((type) => {
    const gasUnits = GAS_BUDGETS[type];
    const gasCost = gasUnits * maxFeePerGas;
    return { type, gasUnits, gasCost };
  });

  const rawTotal = perOperation.reduce((sum, op) => sum + op.gasCost, 0n);
  const totalGasCost = (rawTotal * SAFETY_BUFFER_PCT) / 100n;

  return { totalGasCost, maxFeePerGas, perOperation };
}

/**
 * Fetches current EIP-1559 fees for a chain, boosted by {@link FAST_FEE_MULTIPLIER_PCT}
 * so submitted transactions land within ~1 minute. Falls back to legacy `gasPrice`
 * (also boosted) on chains/RPCs that don't support EIP-1559.
 */
export async function fetchFastFees(chainId: number): Promise<{
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint | undefined;
}> {
  const client = getPublicClient(chainId);
  const fees = await retryOnRateLimit(() => client.estimateFeesPerGas());
  const baseMax = fees.maxFeePerGas ?? fees.gasPrice ?? 0n;
  const basePriority = fees.maxPriorityFeePerGas;
  return {
    maxFeePerGas: (baseMax * FAST_FEE_MULTIPLIER_PCT) / 100n,
    maxPriorityFeePerGas: basePriority !== undefined ? (basePriority * FAST_FEE_MULTIPLIER_PCT) / 100n : undefined,
  };
}

/**
 * Fetches the boosted `maxFeePerGas` for a chain. See {@link fetchFastFees}.
 */
export async function fetchMaxFeePerGas(chainId: number): Promise<bigint> {
  const { maxFeePerGas } = await fetchFastFees(chainId);
  return maxFeePerGas;
}

export interface ChainTokenInfo {
  token: Address;
  symbol: string;
  decimals: number;
  amount: bigint;
}

/**
 * Determines what operations will execute on a given chain+wallet, based on the tokens
 * that need processing and whether bridging to the destination chain is required.
 *
 * @param tokens - Tokens on this chain+wallet that will be processed
 * @param chainId - The chain these tokens are on
 * @param destinationChainId - The final destination chain
 * @param usdcAddress - The USDC address on this chain
 */
export function estimateOperationsForChainWallet(
  tokens: ChainTokenInfo[],
  chainId: number,
  destinationChainId: number,
  usdcAddress: Address,
): OperationType[] {
  const ops: OperationType[] = [];
  const isDestChain = chainId === destinationChainId;

  const nonNativeNonUsdc = tokens.filter(
    (t) => !isAddressEqual(t.token, zeroAddress) && !isAddressEqual(t.token, usdcAddress),
  );
  const hasNative = tokens.some((t) => isAddressEqual(t.token, zeroAddress));
  const totalSwapTokens = nonNativeNonUsdc.length + (hasNative ? 1 : 0);

  if (!isDestChain) {
    // Source chain: swap to USDC (if needed), then bridge
    for (const _t of nonNativeNonUsdc) {
      ops.push("erc20-approval");
    }

    if (totalSwapTokens > 0) {
      const batchCount = Math.ceil(totalSwapTokens / 6);
      for (let i = 0; i < batchCount; i++) {
        const batchSize = Math.min(totalSwapTokens - i * 6, 6);
        ops.push(batchSize > 1 ? "swap-multi" : "swap");
      }
    }

    // CCTP bridge ops are only added when there's at least one token on this chain
    // (caller is expected to pass non-empty tokens for source chains).
    if (tokens.length > 0) {
      ops.push("cctp-approval", "cctp-burn");
    }
  } else {
    // Destination chain: final swaps + potential transfer
    for (const _t of nonNativeNonUsdc) {
      ops.push("erc20-approval");
    }

    if (totalSwapTokens > 0) {
      const batchCount = Math.ceil(totalSwapTokens / 6);
      for (let i = 0; i < batchCount; i++) {
        const batchSize = Math.min(totalSwapTokens - i * 6, 6);
        ops.push(batchSize > 1 ? "swap-multi" : "swap");
      }
    }
  }

  return ops;
}

/**
 * Determines operations for the destination chain including claim and final processing.
 *
 * @param hasBridges - Whether there are CCTP bridges arriving
 * @param nonNativeSwapTokenCount - Number of ERC20 (non-native) tokens that need final swapping
 * @param hasNativeInFinalSwap - Whether native token is among final swap inputs
 * @param needsTransfer - Whether a final transfer to destination wallet is needed
 * @param isNativeTransfer - Whether the final transfer is for a native token
 */
export function estimateDestinationChainOperations(
  hasBridges: boolean,
  nonNativeSwapTokenCount: number,
  hasNativeInFinalSwap: boolean,
  needsTransfer: boolean,
  isNativeTransfer: boolean,
): OperationType[] {
  const ops: OperationType[] = [];

  if (hasBridges) {
    ops.push("cctp-claim");
  }

  const totalSwapTokens = nonNativeSwapTokenCount + (hasNativeInFinalSwap ? 1 : 0);

  for (let i = 0; i < nonNativeSwapTokenCount; i++) {
    ops.push("erc20-approval");
  }

  if (totalSwapTokens > 0) {
    const batchCount = Math.ceil(totalSwapTokens / 6);
    for (let i = 0; i < batchCount; i++) {
      const batchSize = Math.min(totalSwapTokens - i * 6, 6);
      ops.push(batchSize > 1 ? "swap-multi" : "swap");
    }
  }

  if (needsTransfer) {
    ops.push(isNativeTransfer ? "transfer-native" : "transfer-erc20");
  }

  return ops;
}

/**
 * Builds a StepGasEstimate for a single step given its operation types.
 */
export function buildStepGasEstimate(
  operations: OperationType[],
  maxFeePerGas: bigint,
  nativeSymbol: string,
): {
  gasUnits: bigint;
  maxFeePerGas: bigint;
  gasCostWei: bigint;
  nativeSymbol: string;
} {
  const gasUnits = operations.reduce((sum, op) => sum + GAS_BUDGETS[op], 0n);
  const gasCostWei = (gasUnits * maxFeePerGas * SAFETY_BUFFER_PCT) / 100n;

  return { gasUnits, maxFeePerGas, gasCostWei, nativeSymbol };
}

/**
 * Returns the native currency symbol for a chain.
 */
export function getNativeSymbol(chainId: number): string {
  const chain = chains[chainId as keyof typeof chains] as Chain | undefined;
  return chain?.nativeCurrency?.symbol ?? "ETH";
}

/**
 * Pre-computed gas context for a planning session.
 * Fetched once per chain and reused across all steps.
 */
export interface GasContext {
  maxFeePerGas: Record<number, bigint>;
  nativeSymbol: Record<number, string>;
}

/**
 * Sentinel error thrown when, after gas adjustment, no native token amount remains
 * to perform the swap. Callers should surface this as an "insufficient gas" UX state.
 */
export class InsufficientNativeForGasError extends Error {
  constructor(
    message: string,
    public readonly chainId: number,
    public readonly walletAddress: Address,
  ) {
    super(message);
    this.name = "InsufficientNativeForGasError";
  }
}

/**
 * Formats a native-token gas cost in wei for human display.
 * Truncates to 6 fractional digits.
 */
export function formatGasCostNative(wei: bigint, decimals = 18): string {
  const full = formatUnits(wei, decimals);
  const [whole, frac = ""] = full.split(".");
  return frac ? `${whole}.${frac.slice(0, 6)}` : whole;
}

/**
 * Builds a GasContext for all chains involved in a consolidation.
 */
export async function buildGasContext(chainIds: number[]): Promise<GasContext> {
  const unique = [...new Set(chainIds)];
  const maxFeePerGas: Record<number, bigint> = {};
  const nativeSymbol: Record<number, string> = {};

  await Promise.all(
    unique.map(async (chainId) => {
      maxFeePerGas[chainId] = await fetchMaxFeePerGas(chainId);
      nativeSymbol[chainId] = getNativeSymbol(chainId);
    }),
  );

  return { maxFeePerGas, nativeSymbol };
}

/**
 * Determines per-step operations and attaches gas estimates to already-created steps.
 */
export function attachGasEstimates(steps: TransactionStep[], gasCtx: GasContext): void {
  for (const step of steps) {
    if (step.type === "attestation") continue;

    const ops = getStepOperations(step);
    const chainId = step.chainId;
    const fee = gasCtx.maxFeePerGas[chainId] ?? 0n;
    const symbol = gasCtx.nativeSymbol[chainId] ?? "ETH";

    step.estimatedGas = buildStepGasEstimate(ops, fee, symbol);
  }
}

function getStepOperations(step: TransactionStep): OperationType[] {
  switch (step.type) {
    case "swap": {
      const ops: OperationType[] = [];
      for (const input of step.inputTokens) {
        if (!isAddressEqual(input.token, zeroAddress)) {
          ops.push("erc20-approval");
        }
      }
      ops.push(step.inputTokens.length > 1 ? "swap-multi" : "swap");
      return ops;
    }
    case "bridge":
      return ["cctp-approval", "cctp-burn"];
    case "claim":
      return ["cctp-claim"];
    case "transfer": {
      const firstToken = step.inputTokens[0];
      if (!firstToken) return [];
      return [isAddressEqual(firstToken.token, zeroAddress) ? "transfer-native" : "transfer-erc20"];
    }
    default:
      return [];
  }
}
