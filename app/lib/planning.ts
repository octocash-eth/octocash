import { type Address, isAddressEqual } from "viem";
import { chains, transports } from "~/data/supported-chains";
import { USDC as USDC_ADDRESSES } from "~/data/token-contracts";
import { getBridgeFee } from "./cctp";
import { ensureSufficientGas } from "./gas";
import { getSwapQuote } from "./odos";
import { groupTokensByChainAndWallet } from "./tokens";
import type { DestinationToken, TokenAmount, TransactionStep } from "./types";

const SUPPORTED_CHAINS = Object.keys(chains).map(Number);

/**
 * Finds a suitable intermediate wallet in case the destination wallet is not connected
 * It ensures the wallet has sufficient gas to execute the claim and transfer steps
 *
 * @param sourceTokens - Array of source tokens
 * @param destinationToken - Destination token
 * @param connectedWallets - Array of connected wallets
 * @returns The intermediate wallet address
 */
async function resolveIntermediateWallet(
  sourceTokens: TokenAmount[],
  destinationToken: DestinationToken,
  connectedWallets: readonly Address[] = [],
): Promise<Address> {
  const destinationWallet = destinationToken.walletAddress;
  const isDestinationConnected = connectedWallets.some((wallet) => isAddressEqual(wallet, destinationWallet));

  if (isDestinationConnected) {
    await ensureSufficientGas([[destinationToken.chainId, destinationWallet]], transports);
    return destinationWallet;
  }

  const searchOrder = [...new Set([...sourceTokens.map((token) => token.walletAddress), ...connectedWallets])];

  const insufficient = await ensureSufficientGas(
    searchOrder.map((wallet) => [destinationToken.chainId, wallet]),
    transports,
    false,
  );

  // Find the first wallet that has sufficient gas
  const sufficient = searchOrder.find(
    (wallet) =>
      !insufficient.some(
        ([chainId, address]) => chainId === destinationToken.chainId && isAddressEqual(address, wallet),
      ),
  );
  if (!sufficient) {
    const chain = chains[destinationToken.chainId as keyof typeof chains];
    const chainName = chain?.name ?? `chain ${destinationToken.chainId}`;
    throw new Error(
      `PlanningError: Destination wallet ${destinationWallet} is not connected and no connected wallet has sufficient gas on ${chainName}`,
    );
  }

  return sufficient;
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

  if (sourceTokens.length > 50) {
    throw new Error("PlanningError: Too many source tokens (max 50)");
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
 * @param tokensToSwap - Tokens to swap to target
 * @param targetToken - Target token specification (without amount)
 * @param steps - Existing steps array to append to
 * @param dependencies - Step IDs that these swaps depend on
 * @param log - Logging function for debug output
 * @returns Array of output tokens from the swaps
 *
 * @throws {Error} ExternalAPIError if any swap quote fails
 */
async function createSwapSteps(
  tokensToSwap: TokenAmount[],
  targetToken: Omit<TokenAmount, "amount">,
  steps: TransactionStep[],
  dependencies: string[],
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
        dependsOn: dependencies,
        partialDependency: false,
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
  log: (...args: unknown[]) => void,
): Promise<{ steps: TransactionStep[]; tokens: TokenAmount[] }> {
  const steps: TransactionStep[] = [];
  const swappedTokens: TokenAmount[] = [];
  const tokensNotToSwap: TokenAmount[] = [];

  // Group tokens by chain and wallet
  const tokensByChainAndWallet = groupTokensByChainAndWallet(sourceTokens, true);

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

    for (const token of tokens) {
      const isUSDC = isAddressEqual(token.token, chainUSDC);

      // If tokens are on the destination chain, they will be swapped in the final swap step
      // If tokens are USDC on non-destination chain they won't be swapped but will be bridged
      if (isDestChain || isUSDC) {
        tokensNotToSwap.push(token);
        continue;
      }

      // Token needs to be swapped to USDC (for bridging or if dest is USDC)
      tokensToSwapToUSDC.push(token);
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

      const swapOutputs = await createSwapSteps(tokensToSwapToUSDC, chainUSDCToken, steps, [], log);
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
 * @param intermediateWallet - Wallet to execute the last steps (claim and transfer)
 * @param log - Logging function for debug output
 * @returns Object containing all steps (input + bridge) and bridged USDC tokens on dest chain
 *
 * @throws {Error} If bridge fee calculation fails
 */
async function createBridgeSteps(
  steps: TransactionStep[],
  tokens: TokenAmount[],
  destinationToken: DestinationToken,
  intermediateWallet: Address,
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
      walletAddress: intermediateWallet,
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
      dependsOn: deps,
      partialDependency: false,
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
 * @param intermediateWallet - Wallet to execute the last steps (claim and transfer)
 * @returns Object containing all steps (input + attestation + claim) and claim output token
 */
function createAttestationAndClaimSteps(
  steps: TransactionStep[],
  tokens: TokenAmount[],
  destinationToken: DestinationToken,
  intermediateWallet: Address,
): { steps: TransactionStep[]; tokens: TokenAmount[] } {
  const bridgeSteps = steps.filter((s) => s.type === "bridge");

  if (bridgeSteps.length === 0) {
    return { steps, tokens };
  }

  const destChainUSDC = USDC_ADDRESSES[destinationToken.chainId as keyof typeof USDC_ADDRESSES] as Address;
  const bridgeStepIds = bridgeSteps.map((s) => s.id);

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
      walletAddress: intermediateWallet,
      symbol: "USDC",
      decimals: 6,
    },
    dependsOn: bridgeStepIds,
    partialDependency: true,
  });

  // Create claim step
  const claimStepId = `step-${steps.length + 1}`;
  const totalBridged = bridgeSteps.reduce((sum, s) => sum + s.outputToken.amount, 0n);

  const claimOutput: TokenAmount = {
    token: destChainUSDC,
    amount: totalBridged,
    chainId: destinationToken.chainId,
    walletAddress: intermediateWallet,
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
    dependsOn: [...bridgeStepIds, attestationStepId],
    partialDependency: true,
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

  // Group tokens by chain and wallet, consolidating duplicate token addresses
  const tokensByChainAndWallet = groupTokensByChainAndWallet(tokens, true);

  log(
    "🔍 [DEBUG] Tokens grouped by wallet (consolidated):",
    tokensByChainAndWallet.map((tokens) => ({
      tokenCount: tokens.length,
    })),
  );

  const swappedTokens: TokenAmount[] = [];
  const tokensNeedingTransfer: TokenAmount[] = [];

  // Determine dependencies - should depend on claim step if it exists
  const claimSteps = steps.filter((s) => s.type === "claim");
  const dependencies = claimSteps.map((s) => s.id);

  // Step 1: Process each wallet - swap all tokens to destination token
  for (const consolidatedTokens of tokensByChainAndWallet.values()) {
    const walletAddress = consolidatedTokens[0].walletAddress;

    log(
      `🔍 [DEBUG] Wallet ${walletAddress} - Consolidated tokens:`,
      consolidatedTokens.map((t) => ({
        symbol: t.symbol,
        amount: t.amount.toString(),
        token: t.token,
      })),
    );

    // Separate tokens that need swapping from those that don't
    const tokensToSwap = consolidatedTokens.filter((token) => !isAddressEqual(token.token, destinationToken.token));

    const alreadyDestToken = consolidatedTokens.filter((token) => isAddressEqual(token.token, destinationToken.token));

    // Swap tokens to destination token, outputting directly to destination wallet
    if (tokensToSwap.length > 0) {
      log(
        `🔍 [DEBUG] Wallet ${walletAddress} - Creating final swap for ${tokensToSwap.length} tokens to ${destinationToken.symbol} at destination wallet, dependencies: ${dependencies.join(", ")}`,
      );

      // Create swap steps that output directly to destination wallet
      const walletSwapOutputs = await createSwapSteps(
        tokensToSwap,
        destinationToken, // Output to destination wallet
        steps,
        dependencies,
        log,
      );

      swappedTokens.push(...walletSwapOutputs);
    }

    // Tokens already at destination token: transfer only if at wrong wallet
    for (const token of alreadyDestToken) {
      if (isAddressEqual(token.walletAddress, destinationToken.walletAddress)) {
        // Already at destination wallet, no action needed
        log(
          `🔍 [DEBUG] Wallet ${walletAddress} - Token already destination token and at destination wallet, no swap needed`,
        );
        swappedTokens.push(token);
      } else {
        // At wrong wallet, needs transfer
        log(`🔍 [DEBUG] Wallet ${walletAddress} - Token already destination token but needs transfer`);
        tokensNeedingTransfer.push(token);
      }
    }
  }

  // Step 2: Create transfer steps only for tokens that need them
  // (tokens already at destination token but wrong wallet)
  const transferOutputs: TokenAmount[] = [];

  for (const token of tokensNeedingTransfer) {
    const stepId = `step-${steps.length + 1}`;

    const transferOutput: TokenAmount = {
      ...token,
      walletAddress: destinationToken.walletAddress,
    };

    steps.push({
      id: stepId,
      type: "transfer",
      status: "pending",
      chainId: destinationToken.chainId,
      inputTokens: [token],
      outputToken: transferOutput,
      dependsOn: dependencies,
      partialDependency: false,
    });

    transferOutputs.push(transferOutput);

    log(
      `🔍 [DEBUG] Added transfer step ${stepId} from wallet ${token.walletAddress} to ${destinationToken.walletAddress}`,
    );
  }

  // Step 3: Final consolidation - sum up all destination tokens at destination wallet
  const allFinalTokens = [...swappedTokens, ...transferOutputs];
  const finalTokens = groupTokensByChainAndWallet(allFinalTokens, true).flat();

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

  // Ensure sufficient gas for source wallets and find a suitable intermediate wallet
  await ensureSufficientGas(
    sourceTokens.map((token) => [token.chainId, token.walletAddress]),
    transports,
  );
  const intermediateWallet = await resolveIntermediateWallet(sourceTokens, destinationToken, connectedWallets);

  // Build consolidation pipeline
  let { steps, tokens } = await processChainWalletSwaps(sourceTokens, destinationToken, log);
  ({ steps, tokens } = await createBridgeSteps(steps, tokens, destinationToken, intermediateWallet, log));
  ({ steps, tokens } = createAttestationAndClaimSteps(steps, tokens, destinationToken, intermediateWallet));
  ({ steps, tokens } = await createFinalSwaps(steps, tokens, destinationToken, log));

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
      inputTokens: s.inputTokens.map((t) => ({ symbol: t.symbol, amount: t.amount.toString() })),
      outputToken: s.outputToken ? { symbol: s.outputToken.symbol, amount: s.outputToken.amount?.toString() } : null,
      dependsOn: s.dependsOn,
    })),
  );

  return steps;
}
