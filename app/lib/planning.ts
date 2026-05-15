import { type Address, isAddressEqual, zeroAddress } from "viem";
import { chains, transports } from "~/data/supported-chains";
import { USDC as USDC_ADDRESSES } from "~/data/token-contracts";
import { getBridgeFee } from "./cctp";
import { getNativeBalance } from "./gas";
import {
  attachGasEstimates,
  buildGasContext,
  estimateChainGasCosts,
  estimateDestinationChainOperations,
  estimateOperationsForChainWallet,
  formatGasCostNative,
  type GasContext,
  type OperationType,
} from "./gas-estimation";
import { getSwapQuote } from "./odos";
import { getPublicClient } from "./public-client";
import { groupTokensByChainAndWallet } from "./tokens";
import type { DestinationToken, TokenAmount, TransactionStep } from "./types";

/** Throws an InsufficientGasError-style message in the format users already know. */
function throwInsufficientGas(chainId: number, walletAddress: Address, gasCost: bigint): never {
  const chain = chains[chainId as keyof typeof chains];
  const chainName = chain?.name ?? `chain ${chainId}`;
  const symbol = chain?.nativeCurrency?.symbol ?? "ETH";
  throw new Error(
    `Insufficient gas on ${chainName} for ${walletAddress}. Please top up at https://gas.zip. Need ~${formatGasCostNative(gasCost)} ${symbol}.`,
  );
}

/**
 * Variant of {@link throwInsufficientGas} for the specific case where the user
 * picked the chain's native token as a source and the predicted gas cost
 * exceeds their wallet's entire native balance. In that situation "top up at
 * gas.zip" is misleading — the wallet does hold native, but every wei of it
 * would have to be reserved for gas, leaving nothing to bridge/swap and
 * producing an empty plan. The error tells the user what actually went wrong
 * and what they can do: reduce/deselect the native amount, or fund the wallet
 * with more native.
 */
function throwNativeConsumedByGas(
  chainId: number,
  walletAddress: Address,
  nativeBalance: bigint,
  gasCost: bigint,
): never {
  const chain = chains[chainId as keyof typeof chains];
  const chainName = chain?.name ?? `chain ${chainId}`;
  const symbol = chain?.nativeCurrency?.symbol ?? "ETH";
  throw new Error(
    `Not enough ${symbol} on ${chainName} to consolidate from ${walletAddress}. ` +
      `Gas (~${formatGasCostNative(gasCost)} ${symbol}) exceeds the wallet balance ` +
      `(${formatGasCostNative(nativeBalance)} ${symbol}), so the selected ${symbol} would be entirely spent on fees. ` +
      `Deselect ${symbol}, lower its amount, or add more ${symbol} to the wallet.`,
  );
}

const SUPPORTED_CHAINS = Object.keys(chains).map(Number);

/**
 * EIP-7702 designation prefix. An EOA that has authorized a delegate has
 * bytecode of the form `0xef0100 || <20-byte delegate address>` (23 bytes
 * total). The account remains an EOA — the original key still controls it
 * and the address is the same on every chain — so for our planning purposes
 * (CCTP mintRecipient, intermediate-wallet candidate, signing) it should be
 * treated like a plain EOA, not a smart-account wallet.
 *
 * See https://eips.ethereum.org/EIPS/eip-7702.
 */
const EIP7702_DELEGATION_PREFIX = "0xef0100";

/**
 * Source wallets sign on their source chain and (since the same address is the
 * default CCTP mintRecipient and the intermediate-wallet candidate pool) need
 * to be reachable as EOAs everywhere. Smart-account wallets (Safe, ERC-4337)
 * have counterfactual addresses that may not be controllable on other chains —
 * bridging risks stranded funds. The destination wallet only needs this check
 * when it's itself a connected wallet (intermediate-wallet candidate); an
 * arbitrary destination address can be a contract and just receive ERC20.
 *
 * EIP-7702-delegated EOAs report non-empty bytecode but are still EOAs (same
 * address on every chain, signable by the original key), so we recognize the
 * `0xef0100` designation prefix and let them through.
 */
async function assertEoaWallets(
  sourceTokens: TokenAmount[],
  destinationToken: DestinationToken,
  connectedWallets: readonly Address[],
): Promise<void> {
  const pairs = new Map<string, { address: Address; chainId: number }>();
  for (const t of sourceTokens) {
    pairs.set(`${t.chainId}:${t.walletAddress.toLowerCase()}`, { address: t.walletAddress, chainId: t.chainId });
  }
  const destinationIsConnected = connectedWallets.some((w) => isAddressEqual(w, destinationToken.walletAddress));
  if (destinationIsConnected) {
    pairs.set(`${destinationToken.chainId}:${destinationToken.walletAddress.toLowerCase()}`, {
      address: destinationToken.walletAddress,
      chainId: destinationToken.chainId,
    });
  }

  const checks = await Promise.all(
    Array.from(pairs.values()).map(async ({ address, chainId }) => {
      const code = await getPublicClient(chainId).getCode({ address });
      const hasCode = code !== undefined && code !== "0x";
      const is7702 = hasCode && code.toLowerCase().startsWith(EIP7702_DELEGATION_PREFIX);
      return { address, chainId, isContract: hasCode && !is7702 };
    }),
  );

  const contract = checks.find((c) => c.isContract);
  if (contract) {
    const chainName = chains[contract.chainId as keyof typeof chains]?.name ?? `chain ${contract.chainId}`;
    throw new Error(
      `PlanningError: Smart-account wallets are not supported. ${contract.address} is a contract on ${chainName}.`,
    );
  }
}

/** Max source tokens accepted by a single consolidation plan. */
export const MAX_SOURCE_TOKENS = 50;

/**
 * Finds a suitable intermediate wallet in case the destination wallet is not connected
 * It ensures the wallet has sufficient gas to execute the claim and transfer steps
 *
 * @param sourceTokens - Array of source tokens
 * @param destinationToken - Destination token
 * @param connectedWallets - Array of connected wallets
 * @returns The intermediate wallet address
 */
/**
 * Predicts the destination-chain ops a specific candidate intermediate wallet
 * would execute. The shape depends on whether the candidate is the destination
 * wallet (no final transfer) and on which source tokens it holds on the dest
 * chain (those participate in the same final swap as bridged USDC).
 */
function predictIntermediateDestinationOps(
  sourceTokens: TokenAmount[],
  destinationToken: DestinationToken,
  candidate: Address,
  isCandidateDestination: boolean,
): OperationType[] {
  const destChainId = destinationToken.chainId;
  const destChainUsdc = USDC_ADDRESSES[destChainId as keyof typeof USDC_ADDRESSES] as Address | undefined;
  const destIsNative = isAddressEqual(destinationToken.token, zeroAddress);
  const hasBridges = sourceTokens.some((t) => t.chainId !== destChainId);

  const candidateDestSources = sourceTokens.filter(
    (t) => t.chainId === destChainId && isAddressEqual(t.walletAddress, candidate),
  );
  const candidateNonMatching = candidateDestSources.filter((t) => !isAddressEqual(t.token, destinationToken.token));

  const bridgedUsdcNeedsSwap = hasBridges && !!destChainUsdc && !isAddressEqual(destinationToken.token, destChainUsdc);
  const nonNativeFromSources = candidateNonMatching.filter((t) => !isAddressEqual(t.token, zeroAddress)).length;
  const nonNativeSwapTokenCount = nonNativeFromSources + (bridgedUsdcNeedsSwap ? 1 : 0);
  const hasNativeInFinalSwap = candidateNonMatching.some((t) => isAddressEqual(t.token, zeroAddress));

  return estimateDestinationChainOperations(
    hasBridges,
    nonNativeSwapTokenCount,
    hasNativeInFinalSwap,
    !isCandidateDestination,
    destIsNative,
  );
}

async function resolveIntermediateWallet(
  sourceTokens: TokenAmount[],
  destinationToken: DestinationToken,
  connectedWallets: readonly Address[] = [],
  gasCtx: GasContext,
): Promise<Address> {
  const destinationWallet = destinationToken.walletAddress;
  const isDestinationConnected = connectedWallets.some((wallet) => isAddressEqual(wallet, destinationWallet));
  const destChainId = destinationToken.chainId;
  const chain = chains[destChainId as keyof typeof chains];

  if (isDestinationConnected) {
    const destOps = predictIntermediateDestinationOps(sourceTokens, destinationToken, destinationWallet, true);
    const destGas = await estimateChainGasCosts(destChainId, destOps, gasCtx.maxFeePerGas[destChainId]);
    const balance = await getNativeBalance(
      chain,
      destinationWallet,
      transports?.[destChainId as keyof typeof transports],
    );
    if (balance < destGas.totalGasCost) {
      throwInsufficientGas(destChainId, destinationWallet, destGas.totalGasCost);
    }
    return destinationWallet;
  }

  const searchOrder = [...new Set([...sourceTokens.map((token) => token.walletAddress), ...connectedWallets])];

  // Find first wallet whose destination-chain balance covers its predicted ops
  // (each candidate may need a different op shape — e.g. one holds extra
  // dest-chain source tokens that increase the final-swap batch).
  for (const wallet of searchOrder) {
    const destOps = predictIntermediateDestinationOps(sourceTokens, destinationToken, wallet, false);
    const destGas = await estimateChainGasCosts(destChainId, destOps, gasCtx.maxFeePerGas[destChainId]);
    const balance = await getNativeBalance(chain, wallet, transports?.[destChainId as keyof typeof transports]);
    if (balance >= destGas.totalGasCost) {
      return wallet;
    }
  }

  const chainName = chain?.name ?? `chain ${destChainId}`;
  throw new Error(
    `PlanningError: Destination wallet ${destinationWallet} is not connected and no connected wallet has sufficient gas on ${chainName}`,
  );
}

/**
 * Batches tokens into groups of maximum size for efficient processing
 *
 * @param tokens - Array of tokens to split into batches
 * @param maxBatchSize - Maximum number of tokens per batch
 * @returns Array of token batches, each containing up to maxBatchSize tokens
 *
 * @example
 * const tokens = [token1, token2, token3, token4, token5];
 * const batches = batchTokens(tokens, 2);
 * // Returns: [[token1, token2], [token3, token4], [token5]]
 */
function batchTokens(tokens: TokenAmount[], maxBatchSize: number): TokenAmount[][] {
  const batches: TokenAmount[][] = [];
  for (let i = 0; i < tokens.length; i += maxBatchSize) {
    batches.push(tokens.slice(i, i + maxBatchSize));
  }
  return batches;
}

/**
 * Validates that all input parameters meet the requirements for planning
 *
 * Checks include:
 * - Source tokens array is not empty and contains no more than 50 tokens
 * - All token amounts are greater than 0
 * - All chains (source and destination) are supported
 *
 * @param sourceTokens - Array of tokens to consolidate
 * @param destinationToken - Target token and chain for consolidation
 * @param log - Logging function for debug output
 *
 * @throws {Error} PlanningError if validation fails
 * @throws {Error} UnsupportedRouteError if chain is not supported
 */
function validateInputs(
  sourceTokens: TokenAmount[],
  destinationToken: DestinationToken,
  connectedWallets: readonly Address[],
  log: (...args: unknown[]) => void,
): void {
  log("🔍 [DEBUG] planConsolidation called with:", {
    sourceTokensCount: sourceTokens.length,
    sourceTokens: sourceTokens.map((t) => ({
      chainId: t.chainId,
      token: t.token,
      symbol: t.symbol,
      amount: t.amount.toString(),
      walletAddress: t.walletAddress,
    })),
    destinationToken: {
      chainId: destinationToken.chainId,
      token: destinationToken.token,
      symbol: destinationToken.symbol,
      walletAddress: destinationToken.walletAddress,
    },
  });

  if (!sourceTokens || sourceTokens.length === 0) {
    throw new Error("PlanningError: Source tokens cannot be empty");
  }

  if (sourceTokens.length > MAX_SOURCE_TOKENS) {
    throw new Error(`PlanningError: Too many source tokens (max ${MAX_SOURCE_TOKENS})`);
  }

  for (const token of sourceTokens) {
    if (token.amount <= 0n) {
      throw new Error(`PlanningError: Token amount must be greater than 0`);
    }
    if (!SUPPORTED_CHAINS.includes(token.chainId)) {
      throw new Error(`UnsupportedRouteError: Chain ${token.chainId} is not supported`);
    }
  }

  if (!SUPPORTED_CHAINS.includes(destinationToken.chainId)) {
    throw new Error(`UnsupportedRouteError: Destination chain ${destinationToken.chainId} is not supported`);
  }

  const missingSourceWallet = sourceTokens.find(
    (token) => !connectedWallets.some((wallet) => isAddressEqual(wallet, token.walletAddress)),
  );

  if (missingSourceWallet) {
    throw new Error(
      `PlanningError: Source wallet ${missingSourceWallet.walletAddress} is not among the connected wallets`,
    );
  }
}

/**
 * Creates swap steps from a list of tokens to a target token
 *
 * Batches tokens (max 6 per batch due to Odos limitation) and creates swap steps.
 * Each swap step will depend on the provided dependencies.
 *
 * @param tokensToSwap - Tokens to swap to target (must be different tokens)
 * @param targetToken - Target token specification (without amount)
 * @param steps - Existing steps array to append to
 * @param log - Logging function for debug output
 * @returns Array of output tokens from the swaps
 *
 * @throws {Error} ExternalAPIError if any swap quote fails
 */
async function createSwapSteps(
  tokensToSwap: TokenAmount[],
  targetToken: Omit<TokenAmount, "amount">,
  steps: TransactionStep[],
  log: (...args: unknown[]) => void,
): Promise<TokenAmount[]> {
  const outputTokens: TokenAmount[] = [];

  if (tokensToSwap.length === 0) {
    return outputTokens;
  }

  const batches = batchTokens(tokensToSwap, 6); // Odos limits to 6 tokens per step

  for (const batch of batches) {
    try {
      const quote = await getSwapQuote(batch, targetToken);
      const stepId = `step-${steps.length + 1}`;

      const outputTokenWithProvenance = {
        ...quote,
        provenance: stepId, // Mark this token as coming from this swap step
      };

      steps.push({
        id: stepId,
        type: "swap",
        status: "pending",
        chainId: targetToken.chainId,
        inputTokens: batch as [TokenAmount, ...TokenAmount[]],
        outputToken: outputTokenWithProvenance,
        quotedAt: Date.now(),
      });

      outputTokens.push(outputTokenWithProvenance);

      log(`🔍 [DEBUG] Added swap step ${stepId} for ${batch.length} tokens -> ${targetToken.symbol}`);
    } catch (error) {
      throw new Error(`ExternalAPIError: ${error instanceof Error ? error.message : "Swap quote failed"}`);
    }
  }

  return outputTokens;
}

/**
 * Creates swap and transfer steps to consolidate tokens to a target token at a target wallet
 *
 * This function handles the complete logic of converting and moving tokens:
 * 1. Swaps tokens with different addresses to the target token
 * 2. Creates transfer steps for tokens already at target token but wrong wallet
 * 3. Keeps tokens already at target token and target wallet (no action needed)
 *
 * @param tokens - Tokens to process (from one or multiple wallets on the same chain)
 * @param targetToken - Target token specification including wallet address
 * @param steps - Existing steps array to append to
 * @param log - Logging function for debug output
 * @returns Array of output tokens (swapped + transferred + staying)
 *
 * @throws {Error} ExternalAPIError if any swap quote fails
 */
async function createSwapsAndTransfers(
  tokens: TokenAmount[],
  targetToken: DestinationToken,
  steps: TransactionStep[],
  log: (...args: unknown[]) => void,
): Promise<TokenAmount[]> {
  const outputTokens: TokenAmount[] = [];

  // Separate tokens that need swapping from those already at destination token
  const tokensToSwap = tokens.filter((token) => !isAddressEqual(token.token, targetToken.token));
  const alreadyTargetToken = tokens.filter((token) => isAddressEqual(token.token, targetToken.token));

  // Swap tokens to target token
  if (tokensToSwap.length > 0) {
    log(
      `🔍 [DEBUG] Creating swap steps for ${tokensToSwap.length} tokens to ${targetToken.symbol} at wallet ${targetToken.walletAddress}`,
    );
    const swapOutputs = await createSwapSteps(tokensToSwap, targetToken, steps, log);
    outputTokens.push(...swapOutputs);
  }

  // Handle tokens already at target token
  for (const token of alreadyTargetToken) {
    if (isAddressEqual(token.walletAddress, targetToken.walletAddress)) {
      // Already at target wallet - no action needed
      log(`🔍 [DEBUG] Token ${token.symbol} already destination token and at destination wallet, no action needed`);
      outputTokens.push(token);
    } else {
      // Same token, wrong wallet - needs transfer
      log(`🔍 [DEBUG] Token ${token.symbol} already destination token but needs transfer`);
      const stepId = `step-${steps.length + 1}`;

      const transferOutput: TokenAmount = {
        ...token,
        walletAddress: targetToken.walletAddress,
        provenance: stepId,
      };

      steps.push({
        id: stepId,
        type: "transfer",
        status: "pending",
        chainId: targetToken.chainId,
        inputTokens: [token],
        outputToken: transferOutput,
      });

      outputTokens.push(transferOutput);
    }
  }

  return outputTokens;
}

/**
 * Processes all swap operations for non-destination chains
 *
 * For each wallet on each non-destination chain:
 * 1. Swaps non-USDC tokens to USDC (for bridging)
 * 2. Collects already-existing USDC tokens
 *
 * This function orchestrates the first phase of consolidation where tokens are
 * swapped to USDC before bridging.
 *
 * @param sourceTokens - Array of all source tokens
 * @param destinationToken - Final target token and chain
 * @param log - Logging function for debug output
 * @returns Object containing swap steps and all tokens (swapped outputs + existing USDC + destination chain tokens)
 *
 * @throws {Error} ExternalAPIError if any swap quote fails
 */
async function processChainWalletSwaps(
  sourceTokens: TokenAmount[],
  destinationToken: DestinationToken,
  gasCtx: GasContext,
  log: (...args: unknown[]) => void,
): Promise<{ steps: TransactionStep[]; tokens: TokenAmount[] }> {
  const steps: TransactionStep[] = [];
  const swappedTokens: TokenAmount[] = [];
  const tokensNotToSwap: TokenAmount[] = [];

  // Group tokens by chain and wallet
  const tokensByChainAndWallet = groupTokensByChainAndWallet(sourceTokens);

  log(
    "🔍 [DEBUG] Tokens grouped by chain and wallet:",
    tokensByChainAndWallet.map((tokens) => ({
      tokenCount: tokens.length,
      tokens: tokens.map((t) => ({
        symbol: t.symbol,
        amount: t.amount.toString(),
        token: t.token,
        wallet: t.walletAddress,
      })),
    })),
  );

  for (const tokens of tokensByChainAndWallet) {
    const { chainId, walletAddress } = tokens[0];
    const isDestChain = chainId === destinationToken.chainId;

    log(
      `🔍 [DEBUG] Processing chain ${chainId}, wallet ${walletAddress}, isDestChain: ${isDestChain}, tokens:`,
      tokens.map((t) => ({
        symbol: t.symbol,
        amount: t.amount.toString(),
        token: t.token,
      })),
    );

    const chainUSDC = USDC_ADDRESSES[chainId as keyof typeof USDC_ADDRESSES] as Address;
    const tokensToSwapToUSDC: TokenAmount[] = [];
    const usdcAlreadyHere: TokenAmount[] = [];

    for (const token of tokens) {
      const isUSDC = isAddressEqual(token.token, chainUSDC);

      if (isDestChain) {
        // Destination chain tokens are processed by createFinalSwaps later
        tokensNotToSwap.push(token);
        continue;
      }

      if (isUSDC) {
        // USDC stays as-is but still needs to be bridged
        usdcAlreadyHere.push(token);
        tokensNotToSwap.push(token);
        continue;
      }

      tokensToSwapToUSDC.push(token);
    }

    // Adjust native token amount for gas on source (non-destination) chains.
    // We need to run this whenever the wallet has *anything* to do on this chain
    // (swapping or bridging), since CCTP-burn alone still consumes gas.
    if (!isDestChain && (tokensToSwapToUSDC.length > 0 || usdcAlreadyHere.length > 0)) {
      const opsInputTokens = [...tokensToSwapToUSDC, ...usdcAlreadyHere];
      const ops = estimateOperationsForChainWallet(
        opsInputTokens.map((t) => ({
          token: t.token,
          symbol: t.symbol,
          decimals: t.decimals,
          amount: t.amount,
        })),
        chainId,
        destinationToken.chainId,
        chainUSDC,
      );
      const gasCost = await estimateChainGasCosts(chainId, ops, gasCtx.maxFeePerGas[chainId]);

      const chain = chains[chainId as keyof typeof chains];
      const nativeBalance = await getNativeBalance(
        chain,
        walletAddress,
        transports?.[chainId as keyof typeof transports],
      );
      const nativeIdx = tokensToSwapToUSDC.findIndex((t) => isAddressEqual(t.token, zeroAddress));

      if (nativeIdx >= 0) {
        const nativeToken = tokensToSwapToUSDC[nativeIdx];
        const maxAffordable = nativeBalance > gasCost.totalGasCost ? nativeBalance - gasCost.totalGasCost : 0n;

        if (nativeToken.amount > maxAffordable) {
          log(
            `🔍 [DEBUG] Adjusting native token on chain ${chainId}: selected=${nativeToken.amount.toString()}, maxAffordable=${maxAffordable.toString()}, gasCost=${gasCost.totalGasCost.toString()}`,
          );
          if (maxAffordable <= 0n) {
            // Gas eats the entire native balance — there is nothing left to swap
            // and silently dropping the user's selection would yield an empty
            // (or partially-empty) plan with no explanation. Surface a
            // dedicated error that explains the native was fully consumed by
            // gas (the generic "top up gas" copy is misleading here since the
            // wallet does hold native; it just got reserved for fees).
            throwNativeConsumedByGas(chainId, walletAddress, nativeBalance, gasCost.totalGasCost);
          } else {
            tokensToSwapToUSDC[nativeIdx] = { ...nativeToken, amount: maxAffordable };
          }
        }
      } else if (nativeBalance < gasCost.totalGasCost) {
        // No native token being swapped (e.g. USDC-only or ERC20-only wallet)
        // — ensure wallet has enough native for the swap/bridge gas.
        throwInsufficientGas(chainId, walletAddress, gasCost.totalGasCost);
      }
    }

    // Create swap steps to USDC
    if (tokensToSwapToUSDC.length > 0) {
      const chainUSDCToken: Omit<TokenAmount, "amount"> = {
        token: chainUSDC,
        chainId,
        walletAddress,
        symbol: "USDC",
        decimals: 6,
      };

      const swapOutputs = await createSwapSteps(tokensToSwapToUSDC, chainUSDCToken, steps, log);
      swappedTokens.push(...swapOutputs);
    }
  }

  return { steps, tokens: [...swappedTokens, ...tokensNotToSwap] };
}

/**
 * Creates CCTP bridge steps to transfer USDC from source chains to destination chain
 *
 * For each non-destination chain wallet:
 * 1. Calculates total USDC (existing + swap outputs)
 * 2. Gets bridge fee quote from CCTP
 * 3. Creates bridge step with dependencies on swap steps from that wallet
 *
 * @param steps - Previously created swap steps
 * @param tokens - Tokens containing USDC to bridge (from processChainWalletSwaps)
 * @param destinationToken - Final target token and chain
 * @param log - Logging function for debug output
 * @returns Object containing all steps (input + bridge) and bridged USDC tokens on dest chain
 *
 * @throws {Error} If bridge fee calculation fails
 */
async function createBridgeSteps(
  steps: TransactionStep[],
  tokens: TokenAmount[],
  destinationToken: DestinationToken,
  log: (...args: unknown[]) => void,
): Promise<{ steps: TransactionStep[]; tokens: TokenAmount[] }> {
  const bridgedTokens: TokenAmount[] = [];
  const destChainUSDC = USDC_ADDRESSES[destinationToken.chainId as keyof typeof USDC_ADDRESSES] as Address;

  // Extract destination chain tokens
  const destinationChainTokens = tokens.filter((t) => t.chainId === destinationToken.chainId);
  // The rest are USDC tokens to bridge
  const usdcTokens = tokens.filter((t) => t.chainId !== destinationToken.chainId);

  // Group USDC tokens by chain and wallet
  const usdcTokensByChainAndWallet = groupTokensByChainAndWallet(usdcTokens);

  for (const usdcTokens of usdcTokensByChainAndWallet) {
    const { chainId, walletAddress } = usdcTokens[0];

    const inputTokens: TokenAmount[] = [];
    const deps: string[] = []; // Tokens from swap outputs come first (with dependencies), then existing USDC

    // Find which tokens are swap outputs and track their step IDs
    for (const token of usdcTokens) {
      // Check if this token has provenance from a swap step
      if (token.provenance) {
        // This is a swap output - add it first with dependency
        inputTokens.unshift(token);
        deps.unshift(token.provenance);
      } else {
        // This is existing USDC - add it after swap outputs
        inputTokens.push(token);
      }
    }

    // Calculate total amount
    const totalAmount = inputTokens.reduce((sum, t) => sum + t.amount, 0n);

    const bridgeFee = await getBridgeFee(totalAmount, chainId, destinationToken.chainId);
    const amountAfterFee = totalAmount - bridgeFee;

    const stepId = `step-${steps.length + 1}`;

    const bridgeOutput: TokenAmount = {
      token: destChainUSDC,
      amount: amountAfterFee,
      chainId: destinationToken.chainId,
      walletAddress: destinationToken.walletAddress,
      symbol: "USDC",
      decimals: 6,
      provenance: stepId, // Mark this token as coming from this bridge step
    };

    steps.push({
      id: stepId,
      type: "bridge",
      status: "pending",
      chainId,
      inputTokens: inputTokens as [TokenAmount, ...TokenAmount[]],
      outputToken: bridgeOutput,
    });

    bridgedTokens.push(bridgeOutput);

    log(
      `🔍 [DEBUG] Added bridge step ${stepId} for wallet ${walletAddress} on chain ${chainId}: ${deps.length} swap deps + ${inputTokens.length - deps.length} existing, total=${totalAmount.toString()}, amount=${amountAfterFee.toString()}, fee=${bridgeFee.toString()}`,
    );
  }

  return { steps, tokens: [...bridgedTokens, ...destinationChainTokens] };
}

/**
 * Creates CCTP attestation and claim steps for bridged USDC
 *
 * CCTP requires two steps on the destination chain:
 * 1. Attestation: Verifies the bridge messages are valid (depends on all bridge steps)
 * 2. Claim: Actually receives the bridged USDC (depends on attestation)
 *
 * Both steps support partial dependencies, meaning they can proceed even if some
 * bridge transactions fail or are skipped.
 *
 * **Important:** This function creates exactly ONE attestation step per plan. Plans
 * must contain at most one attestation step, as attestations are stored in global
 * state metadata. This constraint is enforced by validation in planConsolidation().
 *
 * @param steps - All steps created so far (includes bridge steps)
 * @param tokens - Bridged USDC tokens on destination chain
 * @param destinationToken - Final target token and chain
 * @returns Object containing all steps (input + attestation + claim) and claim output token
 */
function createAttestationAndClaimSteps(
  steps: TransactionStep[],
  tokens: TokenAmount[],
  destinationToken: DestinationToken,
): { steps: TransactionStep[]; tokens: TokenAmount[] } {
  const bridgeSteps = steps.filter((s) => s.type === "bridge");

  if (bridgeSteps.length === 0) {
    return { steps, tokens };
  }

  const destChainUSDC = USDC_ADDRESSES[destinationToken.chainId as keyof typeof USDC_ADDRESSES] as Address;

  // Create attestation step
  const attestationStepId = `step-${steps.length + 1}`;
  steps.push({
    id: attestationStepId,
    type: "attestation",
    status: "pending",
    chainId: destinationToken.chainId,
    inputTokens: bridgeSteps.map((s) => s.outputToken) as [TokenAmount, ...TokenAmount[]],
    outputToken: {
      token: destChainUSDC,
      amount: bridgeSteps.reduce((sum, s) => sum + s.outputToken.amount, 0n),
      chainId: destinationToken.chainId,
      walletAddress: destinationToken.walletAddress,
      symbol: "USDC",
      decimals: 6,
      provenance: attestationStepId,
    },
  });

  // Create claim step
  const claimStepId = `step-${steps.length + 1}`;
  const totalBridged = bridgeSteps.reduce((sum, s) => sum + s.outputToken.amount, 0n);

  const claimOutput: TokenAmount = {
    token: destChainUSDC,
    amount: totalBridged,
    chainId: destinationToken.chainId,
    walletAddress: destinationToken.walletAddress,
    symbol: "USDC",
    decimals: 6,
    provenance: claimStepId, // Mark this token as coming from this claim step
  };

  steps.push({
    id: claimStepId,
    type: "claim",
    status: "pending",
    chainId: destinationToken.chainId,
    inputTokens: bridgeSteps.map((s) => s.outputToken) as [TokenAmount, ...TokenAmount[]],
    outputToken: claimOutput,
  });

  // Filter out bridged tokens (they're now claimed) and add the claim output
  // Bridged tokens have provenance from bridge steps - exclude them since they're being claimed
  const bridgeStepProvenance = new Set(bridgeSteps.map((s) => s.id));
  const destinationChainTokens = tokens.filter(
    (t) => t.chainId === destinationToken.chainId && !bridgeStepProvenance.has(t.provenance || ""),
  );
  return { steps, tokens: [...destinationChainTokens, claimOutput] };
}

/**
 * Creates final swap steps to convert remaining tokens to the destination token on destination chain
 *
 * This is the last phase in consolidation when the destination token is not USDC.
 * It aggregates:
 * - USDC that was already on the destination chain
 * - USDC that was bridged and claimed from other chains
 *
 * Batches USDC into groups of up to 6 tokens (Odos limitation) if needed.
 * The final swaps depend on claim steps (if any bridges exist).
 *
 * @param steps - All steps created so far (swaps, bridges, attestation, claim)
 * @param tokens - Remaining tokens on destination chain (includes USDC that was already on the destination
 * chain and USDC that was bridged and claimed from other chains, among other tokens)
 * @param destinationToken - Final target token and chain
 * @param log - Logging function for debug output
 * @returns Object containing all steps (input + final swaps) and final output tokens
 *
 * @throws {Error} ExternalAPIError if swap quote fails
 */
async function createFinalSwaps(
  steps: TransactionStep[],
  tokens: TokenAmount[],
  destinationToken: DestinationToken,
  gasCtx: GasContext,
  hasBridges: boolean,
  needsFinalTransfer: boolean,
  log: (...args: unknown[]) => void,
): Promise<{ steps: TransactionStep[]; tokens: TokenAmount[] }> {
  log(
    "🔍 [DEBUG] createFinalSwaps called with tokens:",
    tokens.map((t) => ({
      symbol: t.symbol,
      amount: t.amount.toString(),
      token: t.token,
      wallet: t.walletAddress,
      provenance: t.provenance,
    })),
  );

  // Group tokens by chain and wallet
  const tokensByChainAndWallet = groupTokensByChainAndWallet(tokens);

  log(
    "🔍 [DEBUG] Tokens grouped by wallet (consolidated):",
    tokensByChainAndWallet.map((tokens) => ({
      tokenCount: tokens.length,
    })),
  );

  const allOutputTokens: TokenAmount[] = [];

  // Process each wallet - create swaps and transfers as needed
  for (const consolidatedTokens of tokensByChainAndWallet.values()) {
    const walletAddress = consolidatedTokens[0].walletAddress;

    log(
      `🔍 [DEBUG] Wallet ${walletAddress} - Processing ${consolidatedTokens.length} consolidated tokens`,
      consolidatedTokens.map((t) => ({
        symbol: t.symbol,
        amount: t.amount.toString(),
        token: t.token,
      })),
    );

    // Adjust native token on destination chain for gas. Only relevant when the
    // user holds native (zeroAddress) on the dest chain AND the destination token
    // is not native — in the latter case the user wants to KEEP their native.
    const tokensToProcess = [...consolidatedTokens];
    const destIsNative = isAddressEqual(destinationToken.token, zeroAddress);
    const nativeIdx = destIsNative ? -1 : tokensToProcess.findIndex((t) => isAddressEqual(t.token, zeroAddress));

    if (nativeIdx >= 0) {
      const nativeToken = tokensToProcess[nativeIdx];
      const destChainId = destinationToken.chainId;
      const tokensNeedingSwap = tokensToProcess.filter((t) => !isAddressEqual(t.token, destinationToken.token));
      const nonNativeSwapCount = tokensNeedingSwap.filter((t) => !isAddressEqual(t.token, zeroAddress)).length;
      const hasNativeInSwap = tokensNeedingSwap.some((t) => isAddressEqual(t.token, zeroAddress));

      const destOps = estimateDestinationChainOperations(
        hasBridges,
        nonNativeSwapCount,
        hasNativeInSwap,
        needsFinalTransfer,
        destIsNative,
      );

      const gasCost = await estimateChainGasCosts(destChainId, destOps, gasCtx.maxFeePerGas[destChainId]);
      const chain = chains[destChainId as keyof typeof chains];
      const nativeBalance = await getNativeBalance(
        chain,
        walletAddress,
        transports?.[destChainId as keyof typeof transports],
      );
      const maxAffordable = nativeBalance > gasCost.totalGasCost ? nativeBalance - gasCost.totalGasCost : 0n;

      if (nativeToken.amount > maxAffordable) {
        log(
          `🔍 [DEBUG] Adjusting native token on dest chain ${destChainId}: selected=${nativeToken.amount.toString()}, maxAffordable=${maxAffordable.toString()}, gasCost=${gasCost.totalGasCost.toString()}`,
        );
        if (maxAffordable <= 0n) {
          // Mirrors the source-chain check in `processChainWalletSwaps`:
          // silently dropping the selected native would erase the final swap
          // and the user's chosen amount with no message. Use the dedicated
          // "native consumed by gas" error so the user is told exactly which
          // action to take (deselect/reduce the native or fund the wallet).
          throwNativeConsumedByGas(destChainId, walletAddress, nativeBalance, gasCost.totalGasCost);
        } else {
          tokensToProcess[nativeIdx] = { ...nativeToken, amount: maxAffordable };
        }
      }
    }

    // Use shared logic to create swaps and transfers
    const walletOutputs = await createSwapsAndTransfers(tokensToProcess, destinationToken, steps, log);

    allOutputTokens.push(...walletOutputs);
  }

  // Final consolidation - sum up all destination tokens at destination wallet
  const finalTokens = groupTokensByChainAndWallet(allOutputTokens).flat();

  log(
    "🔍 [DEBUG] Final tokens after consolidation:",
    finalTokens.map((t) => ({
      symbol: t.symbol,
      amount: t.amount.toString(),
      wallet: t.walletAddress,
    })),
  );

  return { steps, tokens: finalTokens };
}

async function createFinalTransfer(
  steps: TransactionStep[],
  tokens: TokenAmount[],
  destinationToken: DestinationToken,
  log: (...args: unknown[]) => void,
): Promise<{ steps: TransactionStep[]; tokens: TokenAmount[] }> {
  const consolidatedTokens = groupTokensByChainAndWallet(tokens);

  // Validate that all tokens are at the same wallet, chain, and token address
  if (consolidatedTokens.length !== 1) {
    throw new Error("PlanningError: Final transfer step must have tokens from exactly one wallet and chain");
  }

  const tokensAtWallet = consolidatedTokens[0];
  if (tokensAtWallet.length === 0) {
    throw new Error("PlanningError: Final transfer step must have at least one token");
  }

  // Verify all tokens are the same token address
  const tokenAddress = tokensAtWallet[0].token;
  for (const token of tokensAtWallet) {
    if (token.token !== tokenAddress) {
      throw new Error("PlanningError: Final transfer step must have tokens of the same address");
    }
  }

  const stepId = `step-${steps.length + 1}`;

  // Calculate total amount from all tokens (they may have different provenances)
  const totalAmount = tokensAtWallet.reduce((sum, t) => sum + t.amount, 0n);
  const sourceWallet = tokensAtWallet[0].walletAddress;

  const transferOutput: TokenAmount = {
    ...tokensAtWallet[0],
    amount: totalAmount,
    walletAddress: destinationToken.walletAddress,
    provenance: stepId,
  };

  steps.push({
    id: stepId,
    type: "transfer",
    status: "pending",
    chainId: destinationToken.chainId,
    inputTokens: tokensAtWallet as [TokenAmount, ...TokenAmount[]],
    outputToken: transferOutput,
  });

  log(
    `🔍 [DEBUG] Added transfer step ${stepId} from wallet ${sourceWallet} to ${destinationToken.walletAddress} with ${tokensAtWallet.length} input token(s) totaling ${totalAmount.toString()}`,
  );

  return { steps, tokens: [transferOutput] };
}

/**
 * Plans a complete multi-chain token consolidation by generating transaction steps
 *
 * This is the main planning function that orchestrates the entire consolidation process:
 *
 * **Planning Flow:**
 * 1. Validates inputs (token limits, chain support, amounts)
 * 2. Groups tokens by chain and wallet for efficient processing
 * 3. Creates swap steps to convert tokens to USDC or destination token
 * 4. Creates bridge steps to transfer USDC across chains via CCTP
 * 5. Creates attestation and claim steps for bridged USDC
 * 6. Creates final swap step if destination is not USDC
 * 7. Validates plan constraints (at most one attestation step)
 *
 * **Strategy:**
 * - Tokens are first swapped to USDC on their source chains
 * - USDC is bridged to destination chain using Circle's CCTP
 * - On destination chain, USDC is swapped to final token (if needed)
 * - Steps are bundled when they can execute in parallel
 *
 * **Constraints:**
 * - Plans must contain at most one attestation step (enforced by validation)
 * - This ensures attestations stored in global state metadata don't conflict
 *
 * @param sourceTokens - Array of tokens to consolidate (max 50)
 * @param destinationToken - Final target token and chain for consolidation
 * @param connectedWallets - Wallets that are available for signing
 * @param log - Optional logging function for debug output
 * @returns Array of transaction steps with dependencies and bundling information
 *
 * @throws {Error} PlanningError - Invalid inputs, too many tokens, or multiple attestation steps
 * @throws {Error} UnsupportedRouteError - Unsupported chain
 * @throws {Error} ExternalAPIError - Swap quote or bridge fee request failed
 *
 * @example
 * const steps = await planConsolidation(
 *   [
 *     { token: "0x...", amount: 100n, chainId: 1, ... },    // ETH on Ethereum
 *     { token: "0x...", amount: 50n, chainId: 8453, ... },  // USDC on Base
 *   ],
 *   { token: "0x...", chainId: 8453, symbol: "WETH", ... }, // Target: WETH on Base
 *   [WALLET1, WALLET2], // Wallets that are available for signing
 *   console.log
 * );
 * // Returns: [swap1, swap2, bridge, attestation, claim, finalSwap]
 */
export async function planConsolidation(
  sourceTokens: TokenAmount[],
  destinationToken: DestinationToken,
  connectedWallets: readonly Address[],
  log: (...args: unknown[]) => void = () => {},
): Promise<TransactionStep[]> {
  // Validate inputs
  validateInputs(sourceTokens, destinationToken, connectedWallets, log);
  await assertEoaWallets(sourceTokens, destinationToken, connectedWallets);

  // Build gas context for all involved chains (fetches gas prices + native token prices)
  const allChainIds = [...new Set([...sourceTokens.map((t) => t.chainId), destinationToken.chainId])];
  const gasCtx = await buildGasContext(allChainIds);

  // Find a suitable intermediate wallet using gas estimation
  const intermediateWallet = await resolveIntermediateWallet(sourceTokens, destinationToken, connectedWallets, gasCtx);
  const intermediateToken = { ...destinationToken, walletAddress: intermediateWallet };

  // Build consolidation pipeline (gas-adjusted)
  let { steps, tokens } = await processChainWalletSwaps(sourceTokens, intermediateToken, gasCtx, log);
  ({ steps, tokens } = await createBridgeSteps(steps, tokens, intermediateToken, log));
  ({ steps, tokens } = createAttestationAndClaimSteps(steps, tokens, intermediateToken));

  const hasBridges = steps.some((s) => s.type === "bridge");
  const needsFinalTransfer = !isAddressEqual(intermediateWallet, destinationToken.walletAddress);
  ({ steps, tokens } = await createFinalSwaps(
    steps,
    tokens,
    intermediateToken,
    gasCtx,
    hasBridges,
    needsFinalTransfer,
    log,
  ));

  if (needsFinalTransfer) {
    ({ steps, tokens } = await createFinalTransfer(steps, tokens, destinationToken, log));
  }

  // Attach per-step gas estimates for UI display
  await attachGasEstimates(steps, gasCtx);

  // Validate plan constraints
  const attestationSteps = steps.filter((s) => s.type === "attestation");
  if (attestationSteps.length > 1) {
    throw new Error("PlanningError: Plans must contain at most one attestation step");
  }

  log(
    "🔍 [DEBUG] Generated steps:",
    steps.map((s) => ({
      id: s.id,
      type: s.type,
      chainId: s.chainId,
      estimatedGas: s.estimatedGas
        ? { gasCostWei: s.estimatedGas.gasCostWei.toString(), nativeSymbol: s.estimatedGas.nativeSymbol }
        : null,
      inputTokens: s.inputTokens.map((t) => ({
        symbol: t.symbol,
        amount: t.amount.toString(),
        provenance: t.provenance,
      })),
      outputToken: s.outputToken ? { symbol: s.outputToken.symbol, amount: s.outputToken.amount?.toString() } : null,
    })),
  );

  return steps;
}
