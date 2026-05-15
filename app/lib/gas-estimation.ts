import type { Address, Block, Chain, Hex } from "viem";
import {
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  isAddressEqual,
  keccak256,
  pad,
  parseAbi,
  parseAbiParameters,
  zeroAddress,
} from "viem";
import { chainIdToDomain, tokenMessenger } from "~/data/cctp-contracts";
import { chains } from "~/data/supported-chains";
import { USDC as USDC_ADDRESSES } from "~/data/token-contracts";
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
  | "transfer-erc20"
  | "gas-topup-leg";

/**
 * Per-operation gas unit budgets used as a fallback whenever live simulation is
 * unavailable (e.g. Odos swaps whose calldata isn't built until execution, CCTP
 * claims that need an attestation, or RPCs that don't support `eth_estimateGas`
 * with state overrides). Conservative upper bounds derived from observed
 * mainnet/L2 traces; the SAFETY_BUFFER_PCT below is the second line of defense.
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
  // Single LI.FI cross-chain top-up leg (or same-chain native transfer accounted
  // generously). Same-chain legs only consume ~21k but using a single conservative
  // budget keeps step gas estimation simple.
  "gas-topup-leg": 300_000n,
};

/** Multiplier applied to raw gas cost. 130 = +30%. */
const SAFETY_BUFFER_PCT = 130n;

/**
 * Multiplier applied to the predicted next-block baseFee. EIP-1559 caps the
 * per-block change at ±12.5%, so `1.125^6 ≈ 2.03` ⇒ 200% gives ~6 blocks of
 * headroom before our `maxFeePerGas` is breached. Aligns with MetaMask's
 * "high" tier and is the canonical formula used by major wallets/aggregators.
 */
const BASE_FEE_BUFFER_PCT = 200n;

/** Number of historical blocks sampled for `eth_feeHistory`. */
const FEE_HISTORY_BLOCK_COUNT = 10;

/**
 * Percentile of effective priority fees per block to take as the "fast" tier.
 * 75 ≈ MetaMask's "high"; 50 would be "medium", 95 "aggressive". We stay on
 * a single tier by user request; this constant lets us shift the tier later
 * without touching the formula.
 */
const PRIORITY_FEE_PERCENTILE = 75;

/**
 * Per-chain minimum priority fee, in wei. Polygon validators enforce a 25 gwei
 * floor; we add a small margin and use 30 gwei. Mainnet values < 1 gwei
 * effectively hit the wallet's "low priority" warning. L2s (Optimism, Arbitrum,
 * Base, Linea, Unichain) have no meaningful floor — the chain default of 1 wei
 * is enough to satisfy ordering rules without overpaying.
 */
const PRIORITY_FEE_FLOOR: Record<number, bigint> = {
  1: 1_000_000_000n, // mainnet — 1 gwei
  137: 30_000_000_000n, // polygon — 30 gwei (validator min ≈ 25 gwei)
};

const PRIORITY_FEE_FLOOR_DEFAULT = 1n;

export interface GasEstimateResult {
  totalGasCost: bigint;
  maxFeePerGas: bigint;
  perOperation: { type: OperationType; gasUnits: bigint; gasCost: bigint }[];
}

/**
 * Estimates gas costs for a set of operations on a given chain.
 * Uses live fee data from the chain and per-operation gas budgets with a 30% safety buffer.
 *
 * Affordability checks run on the static `GAS_BUDGETS` table here (rather than
 * live `eth_estimateGas`) because the caller only knows the *shape* of the
 * operations — not their exact calldata. Static upper bounds make over-reserve
 * the failure mode, which is harmless; under-reserve would let txs run out of
 * gas mid-flight.
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
 * Fetches current EIP-1559 fees for a chain using the canonical formula:
 *
 *   maxFeePerGas        = (pendingBaseFee × {@link BASE_FEE_BUFFER_PCT}) + maxPriorityFeePerGas
 *   maxPriorityFeePerGas = max(median of `eth_feeHistory[p75]`, chain floor)
 *
 * `pendingBaseFee` is the *next-block* baseFee predicted from the EIP-1559
 * update rule (`baseFee ± baseFee × (gasUsed - target) / target / 8`), not the
 * latest block's baseFee — that lag is what made our prior implementation
 * underbid MetaMask's "Market" tier. The 2× buffer absorbs ~6 blocks of
 * worst-case base-fee growth (`1.125^6 ≈ 2.03`).
 *
 * On chains/RPCs that don't support EIP-1559, falls back to legacy `gasPrice`
 * (also 2×-buffered) so submissions still land.
 */
export async function fetchFastFees(chainId: number): Promise<{
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint | undefined;
}> {
  const client = getPublicClient(chainId);

  try {
    const [block, history] = await Promise.all([
      retryOnRateLimit(() => client.getBlock({ blockTag: "latest" })),
      retryOnRateLimit(() =>
        client.getFeeHistory({
          blockCount: FEE_HISTORY_BLOCK_COUNT,
          rewardPercentiles: [PRIORITY_FEE_PERCENTILE],
        }),
      ),
    ]);

    if (block.baseFeePerGas === null || block.baseFeePerGas === undefined) {
      throw new Error("not eip1559");
    }

    const pendingBase = computePendingBaseFee(block);
    const bufferedBase = (pendingBase * BASE_FEE_BUFFER_PCT) / 100n;

    const samples = (history.reward ?? []).map((row) => row[0]).filter((v): v is bigint => v !== undefined && v > 0n);
    const histPriority = medianBigint(samples);
    const floor = PRIORITY_FEE_FLOOR[chainId] ?? PRIORITY_FEE_FLOOR_DEFAULT;
    const maxPriorityFeePerGas = histPriority > floor ? histPriority : floor;

    return {
      maxFeePerGas: bufferedBase + maxPriorityFeePerGas,
      maxPriorityFeePerGas,
    };
  } catch {
    // Pre-EIP-1559 chain or RPC without `eth_feeHistory`. Use legacy gasPrice
    // and apply the same baseFee buffer so the submission still has headroom.
    const gasPrice = await retryOnRateLimit(() => client.getGasPrice());
    return {
      maxFeePerGas: (gasPrice * BASE_FEE_BUFFER_PCT) / 100n,
      maxPriorityFeePerGas: undefined,
    };
  }
}

/**
 * Computes the next-block baseFee using EIP-1559's update rule.
 *
 * Ref: https://eips.ethereum.org/EIPS/eip-1559#specification
 *   target = gasLimit / ELASTICITY_MULTIPLIER (= 2)
 *   if gasUsed == target: pendingBase = baseFee
 *   if gasUsed >  target: pendingBase = baseFee + baseFee × (gasUsed - target) / target / 8
 *   if gasUsed <  target: pendingBase = baseFee - baseFee × (target - gasUsed) / target / 8
 */
function computePendingBaseFee(block: Pick<Block, "baseFeePerGas" | "gasUsed" | "gasLimit">): bigint {
  const baseFee = block.baseFeePerGas;
  if (baseFee === null || baseFee === undefined) return 0n;

  const ELASTICITY = 2n;
  const DENOM = 8n; // EIP-1559 BASE_FEE_MAX_CHANGE_DENOMINATOR (12.5%)
  const target = block.gasLimit / ELASTICITY;
  if (target === 0n || block.gasUsed === target) return baseFee;

  if (block.gasUsed > target) {
    const delta = (baseFee * (block.gasUsed - target)) / target / DENOM;
    // EIP-1559 guarantees baseFee growth of at least 1 wei when gasUsed > target.
    return baseFee + (delta > 0n ? delta : 1n);
  }
  const delta = (baseFee * (target - block.gasUsed)) / target / DENOM;
  return baseFee - delta;
}

function medianBigint(values: bigint[]): bigint {
  if (values.length === 0) return 0n;
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * Fetches the buffered `maxFeePerGas` for a chain. See {@link fetchFastFees}.
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
 * FiatTokenV2_2 (Circle's USDC) packs `balances` at storage slot 9 and
 * `allowed` at slot 10. The same layout is used by every Circle-deployed USDC
 * across our supported chains. If a chain happens to host a USDC variant with
 * a different layout, `simulateOperationGas` will revert and the caller falls
 * back to the static `GAS_BUDGETS["cctp-burn"]`.
 */
const USDC_BALANCES_SLOT = 9n;
const USDC_ALLOWED_SLOT = 10n;

const MAX_UINT256_HEX: Hex = `0x${"f".repeat(64)}`;

function erc20BalanceSlot(owner: Address, mappingSlot: bigint): Hex {
  return keccak256(encodeAbiParameters(parseAbiParameters("address, uint256"), [owner, mappingSlot]));
}

function erc20AllowanceSlot(owner: Address, spender: Address, mappingSlot: bigint): Hex {
  const inner = keccak256(encodeAbiParameters(parseAbiParameters("address, uint256"), [owner, mappingSlot]));
  return keccak256(encodeAbiParameters(parseAbiParameters("address, bytes32"), [spender, inner]));
}

const depositForBurnAbi = parseAbi([
  "function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold)",
]);

/** Sentinel spender for ERC20-approval simulation in swap steps where the actual
 * Odos router calldata isn't built until execution. The gas of `approve()` is
 * independent of the spender's bytecode (the routine just writes a single
 * storage slot), so any non-precompile address yields the right answer. */
const APPROVAL_SIM_SPENDER: Address = "0x000000000000000000000000000000000000bEEF";

interface SimulationContext {
  step: TransactionStep;
}

/**
 * Tries to simulate a single operation's gas usage at planning time via
 * `eth_estimateGas`. Returns `null` for ops whose calldata isn't known yet
 * (Odos swaps, CCTP claims) or when the simulation reverts; callers fall
 * back to {@link GAS_BUDGETS} in that case.
 *
 * For `cctp-burn`, we use a `stateOverride` to fake a max USDC balance and
 * allowance for the user against the TokenMessenger spender — at planning
 * time the user hasn't yet approved USDC, so a naked `estimateGas` would
 * revert with `transferFrom: insufficient allowance`.
 */
async function simulateOperationGas(
  chainId: number,
  op: OperationType,
  ctx: SimulationContext,
): Promise<bigint | null> {
  const { step } = ctx;
  const client = getPublicClient(chainId);

  try {
    switch (op) {
      case "swap":
      case "swap-multi":
      case "cctp-claim":
      case "gas-topup-leg":
        // Calldata not available at planning time — Odos `/sor/assemble` runs
        // at execution, CCTP claim needs the attestation message, and the
        // gas-topup leg's LI.FI `transactionRequest` is quoted at execution.
        return null;

      case "transfer-native": {
        const input = step.inputTokens[0];
        if (!input) return null;
        const recipient = step.outputToken.walletAddress;
        return await retryOnRateLimit(() =>
          client.estimateGas({
            account: input.walletAddress,
            to: recipient,
            value: input.amount,
          }),
        );
      }

      case "transfer-erc20": {
        const input = step.inputTokens[0];
        if (!input || isAddressEqual(input.token, zeroAddress)) return null;
        const recipient = step.outputToken.walletAddress;
        const data = encodeFunctionData({
          abi: erc20Abi,
          functionName: "transfer",
          args: [recipient, input.amount],
        });
        return await retryOnRateLimit(() =>
          client.estimateGas({
            account: input.walletAddress,
            to: input.token,
            data,
          }),
        );
      }

      case "erc20-approval": {
        // Pick any non-native input as a representative ERC20 to approve. The
        // step may have several (e.g. multi-input swap) but `approve()` gas is
        // ~50k regardless of which token, so one sample is enough.
        const erc20Input = step.inputTokens.find((t) => !isAddressEqual(t.token, zeroAddress));
        if (!erc20Input) return null;
        const data = encodeFunctionData({
          abi: erc20Abi,
          functionName: "approve",
          args: [APPROVAL_SIM_SPENDER, erc20Input.amount],
        });
        return await retryOnRateLimit(() =>
          client.estimateGas({
            account: erc20Input.walletAddress,
            to: erc20Input.token,
            data,
          }),
        );
      }

      case "cctp-approval": {
        const usdc = USDC_ADDRESSES[chainId as keyof typeof USDC_ADDRESSES];
        const spender = tokenMessenger[chainId];
        if (!usdc || !spender) return null;
        const input = step.inputTokens[0];
        if (!input) return null;
        const data = encodeFunctionData({
          abi: erc20Abi,
          functionName: "approve",
          args: [spender, input.amount],
        });
        return await retryOnRateLimit(() =>
          client.estimateGas({
            account: input.walletAddress,
            to: usdc,
            data,
          }),
        );
      }

      case "cctp-burn": {
        const usdc = USDC_ADDRESSES[chainId as keyof typeof USDC_ADDRESSES];
        const spender = tokenMessenger[chainId];
        if (!usdc || !spender) return null;
        const input = step.inputTokens[0];
        if (!input) return null;
        const destDomain = chainIdToDomain[step.outputToken.chainId];
        if (destDomain === undefined) return null;
        const destChain = chains[step.outputToken.chainId as keyof typeof chains] as Chain | undefined;
        const multicall3 = destChain?.contracts?.multicall3?.address;
        if (!multicall3) return null;

        const data = encodeFunctionData({
          abi: depositForBurnAbi,
          functionName: "depositForBurn",
          args: [
            input.amount,
            destDomain,
            pad(step.outputToken.walletAddress),
            usdc,
            pad(multicall3 as Address),
            0n,
            1000,
          ],
        });

        const balanceSlot = erc20BalanceSlot(input.walletAddress, USDC_BALANCES_SLOT);
        const allowanceSlot = erc20AllowanceSlot(input.walletAddress, spender, USDC_ALLOWED_SLOT);

        return await retryOnRateLimit(() =>
          client.estimateGas({
            account: input.walletAddress,
            to: spender,
            data,
            stateOverride: [
              {
                address: usdc,
                stateDiff: [
                  { slot: balanceSlot, value: MAX_UINT256_HEX },
                  { slot: allowanceSlot, value: MAX_UINT256_HEX },
                ],
              },
            ],
          }),
        );
      }
    }
  } catch {
    // estimateGas reverted (insufficient balance/allowance, RPC error, or
    // unsupported `stateOverride`). Caller falls back to GAS_BUDGETS[op].
    return null;
  }
}

/**
 * Builds a {@link StepGasEstimate} for a single step. Calls
 * {@link simulateOperationGas} for each operation type and falls back to
 * {@link GAS_BUDGETS} when simulation isn't possible (Odos swaps, CCTP claim,
 * or revert). The 30% {@link SAFETY_BUFFER_PCT} layers on top of either
 * source so reserved native always exceeds actual cost.
 */
export async function buildStepGasEstimate(
  step: TransactionStep,
  maxFeePerGas: bigint,
  nativeSymbol: string,
): Promise<{
  gasUnits: bigint;
  maxFeePerGas: bigint;
  gasCostWei: bigint;
  nativeSymbol: string;
}> {
  const ops = getStepOperations(step);
  const sims = await Promise.all(ops.map((op) => simulateOperationGas(step.chainId, op, { step })));
  const gasUnits = ops.reduce((sum, op, i) => sum + (sims[i] ?? GAS_BUDGETS[op]), 0n);
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
 * Runs `eth_estimateGas` for every simulatable op in parallel and falls back to
 * static budgets where simulation isn't possible.
 */
export async function attachGasEstimates(steps: TransactionStep[], gasCtx: GasContext): Promise<void> {
  await Promise.all(
    steps.map(async (step) => {
      if (step.type === "attestation") return;

      const fee = gasCtx.maxFeePerGas[step.chainId] ?? 0n;
      const symbol = gasCtx.nativeSymbol[step.chainId] ?? "ETH";

      step.estimatedGas = await buildStepGasEstimate(step, fee, symbol);
    }),
  );
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
    case "gas-topup": {
      const destinations = step.gasTopUpDestinations ?? [];
      // One leg per destination (same-chain transfer or LI.FI bridge).
      return destinations.map(() => "gas-topup-leg" as OperationType);
    }
    case "gas-topup-wait":
      return [];
    default:
      return [];
  }
}
