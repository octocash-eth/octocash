import type { Address, Block, Chain, Hex, StateOverride } from "viem";
import {
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  getAddress,
  isAddressEqual,
  keccak256,
  pad,
  parseAbi,
  parseAbiParameters,
  zeroAddress,
} from "viem";
import { gnosis, mainnet } from "viem/chains";
import { chainIdToDomain, tokenMessenger } from "~/data/cctp-contracts";
import { FOREIGN_OMNIBRIDGE, HOME_OMNIBRIDGE, USDC_ON_XDAI, USDC_TRANSMUTER } from "~/data/omnibridge-contracts";
import { chains } from "~/data/supported-chains";
import { USDC as USDC_ADDRESSES } from "~/data/token-contracts";
import type { DeloraSwapLeg } from "./delora";
import { getPublicClient, retryOnRateLimit } from "./public-client";
import type { GasEstimateSource, StepGasEstimate, TransactionStep } from "./types";

// Note: native-token USD pricing is intentionally not handled here. Gas costs are
// tracked in native wei; fiat conversion belongs at the UI layer (see
// `GasCostTooltip` in `plan-card.tsx`, which reads native price via
// `usePrice(chainId, zeroAddress)` and formats with `useFormatFiat`).

export type OperationType =
  | "erc20-approval"
  | "swap"
  | "cctp-approval"
  | "cctp-burn"
  | "cctp-claim"
  | "transfer-native"
  | "transfer-erc20"
  | "gas-topup-leg"
  | "shield"
  | "omnibridge-relay"
  | "omnibridge-claim";

/**
 * Per-operation gas unit budgets: the terminal rung of the estimation ladder,
 * used when neither the `eth_simulateV1` batch, a Delora `gasLimit` hint, nor
 * per-op `eth_estimateGas` produced a figure (CCTP claims need an attestation,
 * shields need a wallet signature, gas-topup legs are quoted at execution, and
 * some RPCs lack the simulation methods). Conservative upper bounds derived
 * from observed mainnet/L2 traces; the unit buffers are the second line of
 * defense.
 */
const GAS_BUDGETS: Record<OperationType, bigint> = {
  "erc20-approval": 65_000n,
  swap: 500_000n,
  "cctp-approval": 65_000n,
  "cctp-burn": 200_000n,
  "cctp-claim": 300_000n,
  "transfer-native": 21_000n,
  "transfer-erc20": 65_000n,
  // Single cross-chain refuel leg (Gas.zip deposit or Delora route; same-chain
  // native transfers accounted
  // generously). Same-chain legs only consume ~21k but using a single conservative
  // budget keeps step gas estimation simple.
  "gas-topup-leg": 300_000n,
  // Railgun shield(): commitment hashing + merkle-tree insertion on-chain.
  // Observed single-ERC20 shields run ~350–500k; budget conservatively.
  shield: 600_000n,
  // One Omnibridge bridging call: transmuter withdraw/deposit, transferAndCall
  // into the home mediator, or relayTokensAndCall on the foreign mediator.
  "omnibridge-relay": 350_000n,
  // executeSignatures on the mainnet AMB (N validator sig checks + the token
  // mediator's unlock). Observed claims run ~220-315k; budget with headroom.
  "omnibridge-claim": 350_000n,
};

/** Multiplier applied to raw gas cost. 130 = +30%. */
const SAFETY_BUFFER_PCT = 130n;

/**
 * Per-source gas-unit buffers, in percent. Simulated `gasUsed` can sit below
 * the required gas *limit* (EIP-150 63/64 retention in deep call trees, and
 * SSTORE refunds — e.g. allowance-clearing swaps — applied post-execution),
 * so even measured values keep a cushion. Delora's `gasLimit` hint is already
 * a limit with the provider's own margin, so it gets the smallest buffer.
 * Estimate-gas and static budgets keep today's 30%.
 */
const UNIT_BUFFER_PCT: Record<GasEstimateSource, bigint> = {
  simulated: 125n,
  "delora-hint": 115n,
  "estimate-gas": 130n,
  budget: 130n,
};

function bufferUnits(units: bigint, source: GasEstimateSource): bigint {
  return (units * UNIT_BUFFER_PCT[source]) / 100n;
}

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
  100: 1_000_000_000n, // gnosis — 1 gwei (xDAI ≈ $1, so this is negligible)
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

    // Delora swaps are single-input: one swap tx per token.
    for (let i = 0; i < totalSwapTokens; i++) {
      ops.push("swap");
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

    // Delora swaps are single-input: one swap tx per token.
    for (let i = 0; i < totalSwapTokens; i++) {
      ops.push("swap");
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
 * @param needsShield - Whether a final Railgun shield (approve + shield) is needed
 */
export function estimateDestinationChainOperations(
  hasBridges: boolean,
  nonNativeSwapTokenCount: number,
  hasNativeInFinalSwap: boolean,
  needsTransfer: boolean,
  isNativeTransfer: boolean,
  needsShield = false,
): OperationType[] {
  const ops: OperationType[] = [];

  if (hasBridges) {
    ops.push("cctp-claim");
  }

  const totalSwapTokens = nonNativeSwapTokenCount + (hasNativeInFinalSwap ? 1 : 0);

  for (let i = 0; i < nonNativeSwapTokenCount; i++) {
    ops.push("erc20-approval");
  }

  // Delora swaps are single-input: one swap tx per token.
  for (let i = 0; i < totalSwapTokens; i++) {
    ops.push("swap");
  }

  if (needsTransfer) {
    ops.push(isNativeTransfer ? "transfer-native" : "transfer-erc20");
  }

  if (needsShield) {
    ops.push("erc20-approval", "shield");
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

/**
 * USDC FiatTokenV2_2 packs the blacklist flag into bit 255 of the balance slot
 * (`balanceAndBlacklistStates`): bit 255 = blacklisted, bits 0–254 = balance.
 * Overriding the balance slot with full `MAX_UINT256_HEX` flips that flag, so the
 * simulated account reads as blacklisted and `transferFrom` reverts with
 * `Blacklistable: account is blacklisted`. Cap at 2^255 - 1 to keep the top bit
 * clear while still faking a balance far larger than any burn amount.
 */
const MAX_BALANCE_HEX: Hex = `0x7${"f".repeat(63)}`;

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
 * Delora calldata isn't built until execution. The gas of `approve()` is
 * independent of the spender's bytecode (the routine just writes a single
 * storage slot), so any non-precompile address yields the right answer. */
const APPROVAL_SIM_SPENDER: Address = "0x000000000000000000000000000000000000bEEF";

interface SimulationContext {
  step: TransactionStep;
}

/**
 * Tries to simulate a single operation's gas usage at planning time via
 * `eth_estimateGas`. Returns `null` for ops whose calldata isn't known yet
 * (Delora swaps, CCTP claims) or when the simulation reverts; callers fall
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
      case "cctp-claim":
      case "gas-topup-leg":
      case "shield":
      case "omnibridge-relay":
      case "omnibridge-claim":
        // Not simulatable as a lone eth_estimateGas call: swaps need their
        // approval mined first (they're covered by the eth_simulateV1 batch
        // upstream via the retained quote calldata), CCTP claim needs the
        // attestation message, the gas-topup leg's refuel transaction
        // is quoted at execution, the shield note requires a wallet
        // signature at execution, and the Omnibridge ops likewise depend on
        // in-batch approvals (relay) or unknown signature blobs (claim).
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
                  { slot: balanceSlot, value: MAX_BALANCE_HEX },
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
 * Planning-time side-channel artifacts keyed by step id. Swap legs carry the
 * Delora quote calldata + gas hints already fetched during planning so the
 * gas simulation can execute them; they must never reach execution (which
 * re-quotes via `buildDeloraCalls`) or be persisted with the plan.
 */
export interface PlanArtifacts {
  swapLegs: Map<string, DeloraSwapLeg[]>;
}

export function emptyPlanArtifacts(): PlanArtifacts {
  return { swapLegs: new Map() };
}

/**
 * Native balance forced onto the sender during batch simulation so
 * value-carrying calls succeed even on wallets that will only be refueled by
 * a gas-topup step at execution time. 2^96 wei (~79 billion ETH) exceeds any
 * plausible plan amount.
 */
const SIM_NATIVE_BALANCE = 2n ** 96n;

/**
 * One operation inside an `eth_simulateV1` batch. Ops without a `call` (CCTP
 * claim, shield, gas-topup legs — calldata genuinely unknowable at planning
 * time) skip the batch and resolve through the fallback ladder directly.
 */
export interface SimOp {
  op: OperationType;
  call?: { to: Address; data?: Hex; value?: bigint };
  /** Delora quote `gasLimit` fallback (swap ops only). */
  hint?: bigint;
}

interface OpGasResult {
  op: OperationType;
  units: bigint;
  source: GasEstimateSource;
}

/**
 * Builds SimOps for a set of Delora swap legs: each ERC20 leg gets an approval
 * call (to the quote's spender) before the verbatim quote calldata; the leg's
 * `gasLimit` hint rides along as the first fallback rung.
 */
export function buildSwapLegSimOps(legs: DeloraSwapLeg[]): SimOp[] {
  const ops: SimOp[] = [];
  for (const leg of legs) {
    if (!isAddressEqual(leg.input.token, zeroAddress)) {
      ops.push({
        op: "erc20-approval",
        call: {
          to: leg.input.token,
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: "approve",
            args: [leg.approvalAddress, leg.input.amount],
          }),
        },
      });
    }
    ops.push({ op: "swap", call: leg.call, hint: leg.gasLimitHint });
  }
  return ops;
}

/**
 * Builds approve + `depositForBurn` SimOps for a CCTP bridge of `amount` USDC.
 * Falls back to call-less budget ops when chain data is missing.
 */
export function buildBridgeSimOps(
  chainId: number,
  destChainId: number,
  mintRecipient: Address,
  amount: bigint,
): SimOp[] {
  const usdc = USDC_ADDRESSES[chainId as keyof typeof USDC_ADDRESSES];
  const spender = tokenMessenger[chainId];
  const destDomain = chainIdToDomain[destChainId];
  const destChain = chains[destChainId as keyof typeof chains] as Chain | undefined;
  const multicall3 = destChain?.contracts?.multicall3?.address;
  if (!usdc || !spender || destDomain === undefined || !multicall3) {
    return [{ op: "cctp-approval" }, { op: "cctp-burn" }];
  }
  return [
    {
      op: "cctp-approval",
      call: {
        to: usdc,
        data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] }),
      },
    },
    {
      op: "cctp-burn",
      call: {
        to: spender,
        data: encodeFunctionData({
          abi: depositForBurnAbi,
          functionName: "depositForBurn",
          args: [amount, destDomain, pad(mintRecipient), usdc, pad(multicall3 as Address), 0n, 1000],
        }),
      },
    },
  ];
}

/**
 * Builds the Omnibridge SimOps for a `gnosis-bridge` step. The USDC route: on
 * Gnosis the egress triple (approve transmuter, unwrap USDC.e,
 * `transferAndCall` into the home mediator), on mainnet the ingress pair
 * (approve, `relayTokensAndCall` through the transmuter). A direct-route
 * token (non-USDC, registered on the bridge itself) is the pair approve +
 * `relayTokens` on either side. All calldata is known at planning time, so
 * `eth_simulateV1` can measure the real cost.
 *
 * @param token - Token sent into the bridge on `chainId`; defaults to that
 *   side's USDC.
 */
export function buildOmnibridgeSimOps(chainId: number, receiver: Address, amount: bigint, token?: Address): SimOp[] {
  const usdc = USDC_ADDRESSES[chainId as keyof typeof USDC_ADDRESSES];
  const bridgedToken = token ?? usdc;
  if (!isAddressEqual(bridgedToken, usdc)) {
    const mediator = chainId === gnosis.id ? HOME_OMNIBRIDGE : FOREIGN_OMNIBRIDGE;
    return [
      {
        op: "erc20-approval",
        call: {
          to: bridgedToken,
          data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [mediator, amount] }),
        },
      },
      {
        op: "omnibridge-relay",
        call: {
          to: mediator,
          data: encodeFunctionData({
            abi: parseAbi(["function relayTokens(address token, address receiver, uint256 value)"]),
            functionName: "relayTokens",
            args: [bridgedToken, receiver, amount],
          }),
        },
      },
    ];
  }
  if (chainId === gnosis.id) {
    return [
      {
        op: "erc20-approval",
        call: {
          to: USDC_ADDRESSES[gnosis.id],
          data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [USDC_TRANSMUTER, amount] }),
        },
      },
      {
        op: "omnibridge-relay",
        call: {
          to: USDC_TRANSMUTER,
          data: encodeFunctionData({
            abi: parseAbi(["function withdraw(uint256 amount)"]),
            functionName: "withdraw",
            args: [amount],
          }),
        },
      },
      {
        op: "omnibridge-relay",
        call: {
          to: USDC_ON_XDAI,
          data: encodeFunctionData({
            abi: parseAbi(["function transferAndCall(address to, uint256 value, bytes data) returns (bool)"]),
            functionName: "transferAndCall",
            args: [HOME_OMNIBRIDGE, amount, receiver],
          }),
        },
      },
    ];
  }
  return [
    {
      op: "erc20-approval",
      call: {
        to: USDC_ADDRESSES[mainnet.id],
        data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [FOREIGN_OMNIBRIDGE, amount] }),
      },
    },
    {
      op: "omnibridge-relay",
      call: {
        to: FOREIGN_OMNIBRIDGE,
        data: encodeFunctionData({
          abi: parseAbi(["function relayTokensAndCall(address token, address receiver, uint256 value, bytes data)"]),
          functionName: "relayTokensAndCall",
          args: [
            USDC_ADDRESSES[mainnet.id],
            USDC_TRANSMUTER,
            amount,
            encodeAbiParameters([{ type: "address" }], [receiver]),
          ],
        }),
      },
    },
  ];
}

/**
 * Builds the ordered simulate-able operations for one step. Swap steps use the
 * Delora legs retained in {@link PlanArtifacts} (approval + verbatim quote
 * calldata); bridge steps encode approve + `depositForBurn`; transfers and the
 * shield approval encode directly. Everything else resolves via the ladder.
 */
function buildStepSimOps(step: TransactionStep, artifacts: PlanArtifacts): SimOp[] {
  switch (step.type) {
    case "swap": {
      const legs = artifacts.swapLegs.get(step.id);
      if (!legs || legs.length === 0) {
        // No retained quote (e.g. estimating a persisted/re-built plan) —
        // resolve through the ladder only.
        return getStepOperations(step).map((op) => ({ op }));
      }
      return buildSwapLegSimOps(legs);
    }

    case "bridge": {
      const totalAmount = step.inputTokens.reduce((sum, t) => sum + t.amount, 0n);
      return buildBridgeSimOps(step.chainId, step.outputToken.chainId, step.outputToken.walletAddress, totalAmount);
    }

    case "gnosis-bridge": {
      const totalAmount = step.inputTokens.reduce((sum, t) => sum + t.amount, 0n);
      return buildOmnibridgeSimOps(
        step.chainId,
        step.outputToken.walletAddress,
        totalAmount,
        step.inputTokens[0]?.token,
      );
    }

    case "transfer": {
      const first = step.inputTokens[0];
      if (!first) return [];
      const totalAmount = step.inputTokens.reduce((sum, t) => sum + t.amount, 0n);
      const recipient = step.outputToken.walletAddress;
      if (isAddressEqual(first.token, zeroAddress)) {
        return [{ op: "transfer-native", call: { to: recipient, value: totalAmount } }];
      }
      return [
        {
          op: "transfer-erc20",
          call: {
            to: first.token,
            data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [recipient, totalAmount] }),
          },
        },
      ];
    }

    case "shield": {
      const first = step.inputTokens[0];
      if (!first) return [];
      const totalAmount = step.inputTokens.reduce((sum, t) => sum + t.amount, 0n);
      return [
        {
          op: "erc20-approval",
          call: {
            to: first.token,
            data: encodeFunctionData({
              abi: erc20Abi,
              functionName: "approve",
              args: [APPROVAL_SIM_SPENDER, totalAmount],
            }),
          },
        },
        // The shield note requires a wallet signature at execution — budget only.
        { op: "shield" },
      ];
    }

    default:
      // claim / gnosis-claim (attestation and signature calldata unknown),
      // gas-topup (refuel transaction quoted at execution), and wait steps:
      // ladder/budget only.
      return getStepOperations(step).map((op) => ({ op }));
  }
}

/**
 * Resolves gas units for the ordered steps of one (chain, wallet) group: one
 * `eth_simulateV1` batch covers every op with a call — state materializes
 * across calls, so a swap's USDC output funds the subsequent CCTP burn — then
 * the fallback ladder (Delora `gasLimit` hint → per-op `eth_estimateGas` →
 * static budget) covers the rest.
 *
 * State overrides: the sender's native balance is forced high (gas-poor
 * wallets are refueled before real execution but must still simulate), and
 * the wallet's USDC balance slot is forced to max — mid-plan USDC (bridged
 * funds on the destination chain, quoted-vs-simulated swap output drift on
 * source chains) doesn't exist at simulation time but will at execution.
 * Allowances are NOT overridden: approvals execute inside the batch.
 *
 * Failure policy mirrors `simulateSwapDelivery`: a failed call inside the
 * batch invalidates the simulated state, so that call and everything after it
 * fall down the ladder; a thrown batch (RPC without `eth_simulateV1`) degrades
 * the whole group — never the plan.
 */
async function resolveGroupOpGas(
  chainId: number,
  wallet: Address,
  entries: { step?: TransactionStep; simOps: SimOp[] }[],
): Promise<OpGasResult[][]> {
  const calls: NonNullable<SimOp["call"]>[] = [];
  const positions: { entryIdx: number; opIdx: number }[] = [];
  entries.forEach(({ simOps }, entryIdx) => {
    simOps.forEach((simOp, opIdx) => {
      if (simOp.call) {
        calls.push(simOp.call);
        positions.push({ entryIdx, opIdx });
      }
    });
  });

  // Simulated units per (entry, op); null resolves through the ladder below.
  const simulated: (bigint | null)[][] = entries.map(({ simOps }) => simOps.map(() => null));

  if (calls.length > 0) {
    try {
      const client = getPublicClient(chainId);
      const stateOverrides: StateOverride = [{ address: wallet, balance: SIM_NATIVE_BALANCE }];
      const usdc = USDC_ADDRESSES[chainId as keyof typeof USDC_ADDRESSES];
      if (usdc) {
        stateOverrides.push({
          address: usdc,
          stateDiff: [{ slot: erc20BalanceSlot(wallet, USDC_BALANCES_SLOT), value: MAX_BALANCE_HEX }],
        });
      }
      const { results } = await retryOnRateLimit(() =>
        client.simulateCalls({ account: wallet, calls, stateOverrides }),
      );
      for (let i = 0; i < results.length && i < positions.length; i++) {
        const result = results[i] as { status: "success" | "failure"; gasUsed?: bigint };
        if (result.status !== "success" || result.gasUsed === undefined) {
          // Post-failure simulated state is unreliable — everything from this
          // call onward falls down the ladder; earlier results are kept.
          break;
        }
        const { entryIdx, opIdx } = positions[i];
        simulated[entryIdx][opIdx] = result.gasUsed;
      }
    } catch (error) {
      console.warn(`[gas] eth_simulateV1 unavailable on chain ${chainId}; falling back to estimateGas/budgets.`, error);
    }
  }

  return Promise.all(
    entries.map(({ step, simOps }, entryIdx) =>
      Promise.all(
        simOps.map(async (simOp, opIdx): Promise<OpGasResult> => {
          const units = simulated[entryIdx][opIdx];
          if (units !== null) return { op: simOp.op, units, source: "simulated" };
          if (simOp.hint !== undefined) return { op: simOp.op, units: simOp.hint, source: "delora-hint" };
          const estimated = step ? await simulateOperationGas(chainId, simOp.op, { step }) : null;
          if (estimated !== null) return { op: simOp.op, units: estimated, source: "estimate-gas" };
          return { op: simOp.op, units: GAS_BUDGETS[simOp.op], source: "budget" };
        }),
      ),
    ),
  );
}

/**
 * Measures the buffered gas cost of an ad-hoc operation sequence for one
 * wallet — used by planning to make capping/dust decisions BEFORE the steps
 * (and their calldata-bearing artifacts) are turned into a plan. Same batch +
 * ladder machinery as {@link attachGasEstimates}, minus the per-op
 * `eth_estimateGas` rung (there is no step context to derive it from).
 */
export async function measureOpsGas(
  chainId: number,
  wallet: Address,
  simOps: SimOp[],
  maxFeePerGas: bigint,
): Promise<bigint> {
  if (simOps.length === 0) return 0n;
  const [opResults] = await resolveGroupOpGas(chainId, wallet, [{ simOps }]);
  const gasUnits = opResults.reduce((sum, r) => sum + bufferUnits(r.units, r.source), 0n);
  return gasUnits * maxFeePerGas;
}

/**
 * Sums per-op buffered units into a {@link StepGasEstimate}. The estimate's
 * `source` reports where the largest contribution came from — the number the
 * user should trust least dominates the badge.
 */
function assembleStepEstimate(opResults: OpGasResult[], maxFeePerGas: bigint, nativeSymbol: string): StepGasEstimate {
  let gasUnits = 0n;
  let source: GasEstimateSource = "budget";
  let dominant = -1n;
  for (const r of opResults) {
    const buffered = bufferUnits(r.units, r.source);
    gasUnits += buffered;
    if (buffered > dominant) {
      dominant = buffered;
      source = r.source;
    }
  }
  return { gasUnits, maxFeePerGas, gasCostWei: gasUnits * maxFeePerGas, nativeSymbol, source };
}

/**
 * Builds a {@link StepGasEstimate} for a single step: batch-simulates the
 * step's own call sequence and resolves the rest via the ladder. Buffers are
 * applied per op according to the source of its gas units.
 */
export async function buildStepGasEstimate(
  step: TransactionStep,
  maxFeePerGas: bigint,
  nativeSymbol: string,
  artifacts: PlanArtifacts = emptyPlanArtifacts(),
): Promise<StepGasEstimate> {
  const simOps = buildStepSimOps(step, artifacts);
  const wallet = step.inputTokens[0]?.walletAddress;
  if (!wallet) {
    return assembleStepEstimate(
      simOps.map((s) => ({ op: s.op, units: GAS_BUDGETS[s.op], source: "budget" as const })),
      maxFeePerGas,
      nativeSymbol,
    );
  }
  const [opResults] = await resolveGroupOpGas(step.chainId, wallet, [{ step, simOps }]);
  return assembleStepEstimate(opResults, maxFeePerGas, nativeSymbol);
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
 * Attaches per-step gas estimates. Steps are grouped by (chain, executing
 * wallet) in plan order and each group runs as ONE `eth_simulateV1` batch —
 * fewer RPC calls than the previous per-op `eth_estimateGas` fan-out, and the
 * sequential state lets ops that were previously unsimulatable (Delora swaps
 * needing their approval, CCTP burns consuming swap output) return measured
 * gas. Ops without calldata and RPCs without `eth_simulateV1` degrade down
 * the ladder to `eth_estimateGas` / static budgets — never fail the plan.
 */
export async function attachGasEstimates(
  steps: TransactionStep[],
  gasCtx: GasContext,
  artifacts: PlanArtifacts = emptyPlanArtifacts(),
): Promise<void> {
  const groups = new Map<
    string,
    { chainId: number; wallet: Address; entries: { step: TransactionStep; simOps: SimOp[] }[] }
  >();
  for (const step of steps) {
    if (step.type === "attestation" || step.type === "gas-topup-wait" || step.type === "gnosis-wait") continue;
    const wallet = step.inputTokens[0]?.walletAddress;
    if (!wallet) continue;
    const key = `${step.chainId}:${getAddress(wallet)}`;
    let group = groups.get(key);
    if (!group) {
      group = { chainId: step.chainId, wallet, entries: [] };
      groups.set(key, group);
    }
    group.entries.push({ step, simOps: buildStepSimOps(step, artifacts) });
  }

  await Promise.all(
    [...groups.values()].map(async ({ chainId, wallet, entries }) => {
      const fee = gasCtx.maxFeePerGas[chainId] ?? 0n;
      const symbol = gasCtx.nativeSymbol[chainId] ?? "ETH";
      const opResults = await resolveGroupOpGas(chainId, wallet, entries);
      entries.forEach(({ step }, i) => {
        step.estimatedGas = assembleStepEstimate(opResults[i], fee, symbol);
      });
    }),
  );
}

function getStepOperations(step: TransactionStep): OperationType[] {
  switch (step.type) {
    case "swap": {
      // One approval (ERC20 only) + one Delora swap tx per unique token
      // address. Same-address entries with different provenance share one
      // quote/swap (see `dedupeSwapInputs` in delora.ts).
      const ops: OperationType[] = [];
      const uniqueTokens = new Set(step.inputTokens.map((input) => input.token.toLowerCase()));
      for (const token of uniqueTokens) {
        if (!isAddressEqual(token as Address, zeroAddress)) {
          ops.push("erc20-approval");
        }
        ops.push("swap");
      }
      return ops;
    }
    case "bridge":
      return ["cctp-approval", "cctp-burn"];
    case "claim":
      return ["cctp-claim"];
    case "gnosis-bridge": {
      // USDC egress: approve + transmuter withdraw + transferAndCall; USDC
      // ingress and direct-route tokens on either side: approve + relay
      // (matches buildOmnibridgeSimOps).
      const inputToken = step.inputTokens[0]?.token;
      const isUsdcEgress =
        step.chainId === gnosis.id && (!inputToken || isAddressEqual(inputToken, USDC_ADDRESSES[gnosis.id] as Address));
      return isUsdcEgress
        ? ["erc20-approval", "omnibridge-relay", "omnibridge-relay"]
        : ["erc20-approval", "omnibridge-relay"];
    }
    case "gnosis-claim":
      // One executeSignatures per AMB message (one message per bridge step).
      return step.inputTokens.map(() => "omnibridge-claim" as OperationType);
    case "gnosis-wait":
      return [];
    case "transfer": {
      const firstToken = step.inputTokens[0];
      if (!firstToken) return [];
      return [isAddressEqual(firstToken.token, zeroAddress) ? "transfer-native" : "transfer-erc20"];
    }
    case "gas-topup": {
      const destinations = step.gasTopUpDestinations ?? [];
      // One leg per destination (same-chain transfer or cross-chain refuel).
      return destinations.map(() => "gas-topup-leg" as OperationType);
    }
    case "gas-topup-wait":
      return [];
    case "shield":
      return ["erc20-approval", "shield"];
    default:
      return [];
  }
}
