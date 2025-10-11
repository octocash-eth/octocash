import { type Address, getAddress, isAddressEqual } from "viem";
import { chains } from "~/data/supported-chains";
import { USDC as USDC_ADDRESSES } from "~/data/token-contracts";
import { getBridgeFee } from "./cctp";
import { getSwapQuote } from "./odos";
import type { DestinationToken, TokenAmount, TransactionStep } from "./types";

const SUPPORTED_CHAINS = Object.keys(chains).map(Number);

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
}

/**
 * Groups source tokens by chain and wallet address for efficient processing
 *
 * Creates two groupings:
 * 1. By chain and wallet (key: "chainId-walletAddress") - for per-wallet swap operations
 * 2. By chain only - for bridge operations that aggregate across all wallets
 *
 * @param sourceTokens - Array of tokens to group
 * @param log - Logging function for debug output
 * @returns Object containing both grouping maps
 *
 * @example
 * // Returns:
 * {
 *   byChainAndWallet: Map { "1-0xabc...": [token1, token2], "8453-0xabc...": [token3] },
 *   byChain: Map { 1: [token1, token2], 8453: [token3] }
 * }
 */
function groupTokens(
  sourceTokens: TokenAmount[],
  log: (...args: unknown[]) => void,
): { byChainAndWallet: Map<string, TokenAmount[]>; byChain: Map<number, TokenAmount[]> } {
  const byChainAndWallet = new Map<string, TokenAmount[]>();
  const byChain = new Map<number, TokenAmount[]>();

  for (const token of sourceTokens) {
    // Group by chain and wallet
    const key = `${token.chainId}-${token.walletAddress}`;
    if (!byChainAndWallet.has(key)) {
      byChainAndWallet.set(key, []);
    }
    byChainAndWallet.get(key)?.push(token);

    // Group by chain
    if (!byChain.has(token.chainId)) {
      byChain.set(token.chainId, []);
    }
    byChain.get(token.chainId)?.push(token);
  }

  log(
    "🔍 [DEBUG] Tokens grouped by chain and wallet:",
    Array.from(byChainAndWallet.entries()).map(([key, tokens]) => ({
      key,
      tokenCount: tokens.length,
      tokens: tokens.map((t) => ({
        symbol: t.symbol,
        amount: t.amount.toString(),
        token: t.token,
        wallet: t.walletAddress,
      })),
    })),
  );

  return { byChainAndWallet, byChain };
}

/**
 * Categorizes tokens based on what swap operations they need
 *
 * Logic:
 * - If token is already the destination token → no swap needed
 * - If on destination chain and dest token is not USDC → swap directly to dest token
 * - If token is not USDC → swap to USDC (for bridging or when dest is USDC)
 * - If already USDC → will be bridged (if not on dest chain) or used directly
 *
 * @param tokens - Tokens from a specific chain and wallet to categorize
 * @param chainId - Chain ID where these tokens are located
 * @param destinationToken - Final target token and chain
 * @param log - Logging function for debug output
 * @returns Three arrays: tokens to swap to dest, tokens to swap to USDC, and tokens already correct
 */
function categorizeTokens(
  tokens: TokenAmount[],
  chainId: number,
  destinationToken: DestinationToken,
  log: (...args: unknown[]) => void,
): {
  tokensToSwapToDestToken: TokenAmount[];
  tokensToSwapToUSDC: TokenAmount[];
  tokensAlreadyCorrect: TokenAmount[];
} {
  const tokensToSwapToDestToken: TokenAmount[] = [];
  const tokensToSwapToUSDC: TokenAmount[] = [];
  const tokensAlreadyCorrect: TokenAmount[] = [];
  const isDestChain = chainId === destinationToken.chainId;
  const chainUSDC = USDC_ADDRESSES[chainId as keyof typeof USDC_ADDRESSES] as Address;

  for (const token of tokens) {
    const isDestinationToken =
      isAddressEqual(token.token, destinationToken.token) && token.chainId === destinationToken.chainId;

    if (isDestinationToken) {
      tokensAlreadyCorrect.push(token);
      log(`🔍 [DEBUG] Token ${token.symbol} is already destination token on chain ${chainId}, no swap needed`);
    } else if (isDestChain && !isAddressEqual(token.token, destinationToken.token)) {
      tokensToSwapToDestToken.push(token);
      log(
        `🔍 [DEBUG] Token ${token.symbol} will be swapped to ${destinationToken.symbol} on destination chain ${chainId}`,
      );
    } else if (!isDestChain && !isAddressEqual(token.token, chainUSDC)) {
      tokensToSwapToUSDC.push(token);
      log(`🔍 [DEBUG] Token ${token.symbol} will be swapped to USDC on chain ${chainId}`);
    } else {
      // If it were USDC on destination chain, it would have been caught by the previous conditions
      // The only option remaining is:
      log(`🔍 [DEBUG] Already USDC on non-destination chain ${chainId}, will bridge`);
    }
  }

  return { tokensToSwapToDestToken, tokensToSwapToUSDC, tokensAlreadyCorrect };
}

/**
 * Creates batched swap transaction steps for a list of tokens to a target token
 *
 * Batches tokens into groups of up to 6 tokens per swap (Odos limitation) and
 * requests swap quotes for each batch. Returns all created swap steps along with
 * the updated step counter.
 *
 * @param tokens - Array of tokens to swap
 * @param targetToken - Destination token for the swap (can be USDC or final destination)
 * @param chainId - Chain ID where the swap will occur
 * @param stepCounter - Current step counter for ID generation
 * @param log - Logging function for debug output
 * @returns Object containing array of swap steps and the next counter value
 *
 * @throws {Error} ExternalAPIError if swap quote request fails
 *
 * @example
 * const result = await createBatchedSwapSteps([token1, token2], usdcToken, 1, 0, log);
 * // Returns: { steps: [swapStep1], nextCounter: 1 }
 */
async function createBatchedSwapSteps(
  tokens: TokenAmount[],
  targetToken: DestinationToken,
  chainId: number,
  stepCounter: number,
  log: (...args: unknown[]) => void,
): Promise<{ steps: TransactionStep[]; nextCounter: number }> {
  if (tokens.length === 0) {
    return { steps: [], nextCounter: stepCounter };
  }

  log(`🔍 [DEBUG] Creating batched swaps for ${tokens.length} tokens to ${targetToken.symbol}`);
  const batches = batchTokens(tokens, 6);
  const steps: TransactionStep[] = [];
  let counter = stepCounter;

  for (const batch of batches) {
    try {
      const quote = await getSwapQuote(batch, targetToken);
      const stepId = `step-${++counter}`;

      steps.push({
        id: stepId,
        type: "swap",
        status: "pending",
        chainId,
        inputTokens: batch,
        outputToken: quote,
        dependsOn: [],
        partialDependency: false,
      });

      log(`🔍 [DEBUG] Added batched swap step ${stepId} for ${batch.length} tokens -> ${targetToken.symbol}`);
    } catch (error) {
      throw new Error(`ExternalAPIError: ${error instanceof Error ? error.message : "Swap quote failed"}`);
    }
  }

  return { steps, nextCounter: counter };
}

/**
 * Processes all swap operations for each chain-wallet combination
 *
 * For each wallet on each chain:
 * 1. Categorizes tokens into those needing swap to destination vs USDC
 * 2. Creates batched swap steps for tokens → destination token (if on dest chain)
 * 3. Creates batched swap steps for tokens → USDC (for bridging)
 *
 * This function orchestrates the first phase of consolidation where tokens are
 * swapped into the appropriate intermediate or final form before bridging.
 *
 * @param tokensByChainAndWallet - Map of tokens grouped by "chainId-walletAddress"
 * @param destinationToken - Final target token and chain
 * @param destChainUSDC - USDC address on the destination chain
 * @param stepCounter - Current step counter for ID generation
 * @param log - Logging function for debug output
 * @returns Object containing all swap steps and the next counter value
 *
 * @throws {Error} ExternalAPIError if any swap quote fails
 */
async function processChainWalletSwaps(
  tokensByChainAndWallet: Map<string, TokenAmount[]>,
  destinationToken: DestinationToken,
  stepCounter: number,
  log: (...args: unknown[]) => void,
): Promise<{ steps: TransactionStep[]; nextCounter: number }> {
  const allSteps: TransactionStep[] = [];
  let counter = stepCounter;

  for (const [_key, tokens] of tokensByChainAndWallet.entries()) {
    const chainId = tokens[0].chainId;
    const walletAddress = tokens[0].walletAddress;
    const isDestChain = chainId === destinationToken.chainId;

    log(
      `🔍 [DEBUG] Processing chain ${chainId}, wallet ${walletAddress}, isDestChain: ${isDestChain}, tokens:`,
      tokens.map((t) => ({
        symbol: t.symbol,
        amount: t.amount.toString(),
        token: t.token,
      })),
    );

    // Categorize tokens
    const { tokensToSwapToDestToken, tokensToSwapToUSDC } = categorizeTokens(tokens, chainId, destinationToken, log);

    const chainUSDC = USDC_ADDRESSES[chainId as keyof typeof USDC_ADDRESSES] as Address;

    // Create swap steps to destination token
    const destTokenResult = await createBatchedSwapSteps(
      tokensToSwapToDestToken,
      destinationToken,
      chainId,
      counter,
      log,
    );
    allSteps.push(...destTokenResult.steps);
    counter = destTokenResult.nextCounter;

    // Create swap steps to USDC
    const usdcTarget: DestinationToken = {
      token: chainUSDC,
      chainId,
      walletAddress: tokens[0].walletAddress,
      symbol: "USDC",
      decimals: 6,
    };
    const usdcResult = await createBatchedSwapSteps(tokensToSwapToUSDC, usdcTarget, chainId, counter, log);
    allSteps.push(...usdcResult.steps);
    counter = usdcResult.nextCounter;
  }

  return { steps: allSteps, nextCounter: counter };
}

/**
 * Creates CCTP bridge steps to transfer USDC from source chains to destination chain
 *
 * For each non-destination chain:
 * 1. Calculates total USDC (existing + estimated swap outputs)
 * 2. Gets bridge fee quote from CCTP
 * 3. Creates bridge step with dependencies on swap steps from that chain
 *
 * Bridge steps aggregate all USDC from a chain (across wallets) into a single
 * cross-chain transfer to optimize gas costs.
 *
 * @param tokensByChain - Map of tokens grouped by chain ID
 * @param existingSteps - Previously created swap steps (needed to calculate dependencies and totals)
 * @param destinationToken - Final target token and chain
 * @param destChainUSDC - USDC address on the destination chain
 * @param stepCounter - Current step counter for ID generation
 * @param log - Logging function for debug output
 * @returns Object containing bridge steps and the next counter value
 *
 * @throws {Error} If bridge fee calculation fails
 */
async function createBridgeSteps(
  tokensByChain: Map<number, TokenAmount[]>,
  existingSteps: TransactionStep[],
  destinationToken: DestinationToken,
  destChainUSDC: Address,
  stepCounter: number,
  log: (...args: unknown[]) => void,
): Promise<{ steps: TransactionStep[]; nextCounter: number }> {
  const bridgeSteps: TransactionStep[] = [];
  let counter = stepCounter;

  for (const [chainId, tokens] of tokensByChain.entries()) {
    const isDestChain = chainId === destinationToken.chainId;

    if (isDestChain) {
      log(`🔍 [DEBUG] Chain ${chainId} is destination chain, skipping bridging`);
      continue;
    }

    log(`🔍 [DEBUG] Chain ${chainId} is not destination chain, processing bridging`);
    const chainUSDC = USDC_ADDRESSES[chainId as keyof typeof USDC_ADDRESSES] as Address;
    const totalUSDC = tokens.reduce((sum, t) => {
      if (isAddressEqual(t.token, chainUSDC)) {
        return sum + t.amount;
      }
      return sum;
    }, 0n);

    // Add estimated swap outputs
    const swapOutputs = existingSteps
      .filter((s) => s.chainId === chainId && s.type === "swap")
      .reduce((sum, s) => sum + (s.outputToken?.amount || 0n), 0n);

    const totalToBridge = totalUSDC + swapOutputs;

    log(
      `🔍 [DEBUG] Bridge calculation for chain ${chainId}: totalUSDC=${totalUSDC.toString()}, swapOutputs=${swapOutputs.toString()}, totalToBridge=${totalToBridge.toString()}`,
    );

    const bridgeFee = await getBridgeFee(totalToBridge, chainId, destinationToken.chainId);
    const stepId = `step-${++counter}`;

    // Find dependencies: this bridge depends on swaps from this chain
    const deps = existingSteps.filter((s) => s.chainId === chainId && s.type === "swap").map((s) => s.id);

    bridgeSteps.push({
      id: stepId,
      type: "bridge",
      status: "pending",
      chainId,
      inputTokens: [
        {
          token: chainUSDC,
          amount: totalToBridge - bridgeFee,
          chainId,
          walletAddress: tokens[0].walletAddress,
          symbol: "USDC",
          decimals: 6,
        },
      ],
      outputToken: {
        token: destChainUSDC,
        amount: totalToBridge - bridgeFee,
        chainId: destinationToken.chainId,
        walletAddress: destinationToken.walletAddress,
        symbol: "USDC",
        decimals: 6,
      },
      dependsOn: deps,
      partialDependency: false,
    });

    log(`🔍 [DEBUG] Added bridge step ${stepId} for chain ${chainId}`);
  }

  return { steps: bridgeSteps, nextCounter: counter };
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
 * @param bridgeSteps - Array of bridge steps created in previous phase
 * @param destinationToken - Final target token and chain
 * @param destChainUSDC - USDC address on the destination chain
 * @param stepCounter - Current step counter for ID generation
 * @returns Object containing attestation and claim steps (or empty if no bridges) and next counter
 *
 * @example
 * // If no bridge steps, returns empty:
 * createAttestationAndClaimSteps([], dest, usdc, 5) // { steps: [], nextCounter: 5 }
 *
 * // If bridge steps exist, returns 2 steps:
 * createAttestationAndClaimSteps([bridge1, bridge2], dest, usdc, 5)
 * // { steps: [attestation, claim], nextCounter: 7 }
 */
function createAttestationAndClaimSteps(
  bridgeSteps: TransactionStep[],
  destinationToken: DestinationToken,
  destChainUSDC: Address,
  stepCounter: number,
): { steps: TransactionStep[]; nextCounter: number } {
  if (bridgeSteps.length === 0) {
    return { steps: [], nextCounter: stepCounter };
  }

  const steps: TransactionStep[] = [];
  let counter = stepCounter;
  const bridgeStepIds = bridgeSteps.map((s) => s.id);

  // Create attestation step
  const attestationStepId = `step-${++counter}`;
  steps.push({
    id: attestationStepId,
    type: "attestation",
    status: "pending",
    chainId: destinationToken.chainId,
    inputTokens: [],
    outputToken: {
      token: destChainUSDC,
      amount: 0n,
      chainId: destinationToken.chainId,
      walletAddress: destinationToken.walletAddress,
      symbol: "USDC",
      decimals: 6,
    },
    dependsOn: bridgeStepIds,
    partialDependency: true,
  });

  // Create claim step
  const claimStepId = `step-${++counter}`;
  const totalBridged = bridgeSteps.reduce((sum, bridge) => sum + (bridge.outputToken.amount || 0n), 0n);

  steps.push({
    id: claimStepId,
    type: "claim",
    status: "pending",
    chainId: destinationToken.chainId,
    inputTokens: [],
    outputToken: {
      token: destChainUSDC,
      amount: totalBridged,
      chainId: destinationToken.chainId,
      walletAddress: destinationToken.walletAddress,
      symbol: "USDC",
      decimals: 6,
    },
    dependsOn: [attestationStepId],
    partialDependency: true,
  });

  return { steps, nextCounter: counter };
}

/**
 * Creates final swap step to convert USDC to the destination token on destination chain
 *
 * This is the last step in consolidation when the destination token is not USDC.
 * It aggregates:
 * - USDC that was already on the destination chain (excluding tokens already swapped)
 * - USDC that was bridged and claimed from other chains
 *
 * The final swap depends on claim steps (if any bridges exist).
 *
 * @param allSteps - All steps created so far (swaps, bridges, attestation, claim)
 * @param tokensByChain - Map of original tokens grouped by chain (to find dest chain USDC)
 * @param destinationToken - Final target token and chain
 * @param destChainUSDC - USDC address on the destination chain
 * @param stepCounter - Current step counter for ID generation
 * @param log - Logging function for debug output
 * @returns Object containing final swap step (or empty if dest is USDC) and next counter
 *
 * @throws {Error} ExternalAPIError if swap quote fails
 *
 * @example
 * // If destination is USDC, returns empty:
 * createFinalSwap(steps, tokens, usdcDest, usdc, 10, log) // { steps: [], nextCounter: 10 }
 *
 * // If destination is ETH, returns swap step:
 * createFinalSwap(steps, tokens, ethDest, usdc, 10, log) // { steps: [finalSwap], nextCounter: 11 }
 */
async function createFinalSwap(
  allSteps: TransactionStep[],
  tokensByChain: Map<number, TokenAmount[]>,
  destinationToken: DestinationToken,
  destChainUSDC: Address,
  stepCounter: number,
  log: (...args: unknown[]) => void,
): Promise<{ steps: TransactionStep[]; nextCounter: number }> {
  if (isAddressEqual(destinationToken.token, destChainUSDC)) {
    log(`🔍 [DEBUG] Destination token is USDC, no final swap needed`);
    return { steps: [], nextCounter: stepCounter };
  }

  log(
    `🔍 [DEBUG] Destination token is not USDC, need final swap. Dest token: ${destinationToken.token}, USDC: ${destChainUSDC}`,
  );

  // Calculate total USDC on destination chain
  const destChainTokens = tokensByChain.get(destinationToken.chainId) || [];
  const tokensAlreadySwappedToDest = allSteps
    .filter(
      (s) =>
        s.chainId === destinationToken.chainId &&
        s.type === "swap" &&
        isAddressEqual(s.outputToken.token, destinationToken.token),
    )
    .flatMap((s) => s.inputTokens.map((t) => getAddress(t.token)));

  const destChainUSDCAmount = destChainTokens
    .filter((t) => isAddressEqual(t.token, destChainUSDC) && !tokensAlreadySwappedToDest.includes(getAddress(t.token)))
    .reduce((sum, t) => sum + t.amount, 0n);

  log(
    `🔍 [DEBUG] Destination chain ${destinationToken.chainId} USDC tokens:`,
    destChainTokens
      .filter((t) => isAddressEqual(t.token, destChainUSDC))
      .map((t) => ({
        symbol: t.symbol,
        amount: t.amount.toString(),
        token: t.token,
      })),
  );
  log(`🔍 [DEBUG] Tokens already swapped to dest:`, tokensAlreadySwappedToDest);

  const bridgedUSDC = allSteps.find((s) => s.type === "claim")?.outputToken.amount || 0n;
  const totalUSDC = destChainUSDCAmount + bridgedUSDC;

  log(
    `🔍 [DEBUG] Final swap calculation: destChainUSDC=${destChainUSDCAmount.toString()}, bridgedUSDC=${bridgedUSDC.toString()}, totalUSDC=${totalUSDC.toString()}`,
  );

  if (totalUSDC === 0n) {
    log(`🔍 [DEBUG] No USDC to swap on destination chain ${destinationToken.chainId}`);
    return { steps: [], nextCounter: stepCounter };
  }

  log(`🔍 [DEBUG] Getting swap quote for ${totalUSDC.toString()} USDC to ${destinationToken.symbol}`);
  const quote = await getSwapQuote(
    {
      token: destChainUSDC,
      amount: totalUSDC,
      chainId: destinationToken.chainId,
      walletAddress: destinationToken.walletAddress,
      symbol: "USDC",
      decimals: 6,
    },
    destinationToken,
  );

  const finalSwapId = `step-${++stepCounter}`;
  const deps = allSteps.filter((s) => s.type === "claim").map((s) => s.id);

  const finalStep: TransactionStep = {
    id: finalSwapId,
    type: "swap",
    status: "pending",
    chainId: destinationToken.chainId,
    inputTokens: [
      {
        token: destChainUSDC,
        amount: totalUSDC,
        chainId: destinationToken.chainId,
        walletAddress: destinationToken.walletAddress,
        symbol: "USDC",
        decimals: 6,
      },
    ],
    outputToken: quote,
    dependsOn: deps,
    partialDependency: false,
  };

  log(`🔍 [DEBUG] Added final swap step ${finalSwapId} for USDC -> ${destinationToken.symbol}`);
  return { steps: [finalStep], nextCounter: stepCounter };
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
 * 7. Identifies bundling opportunities for parallel execution
 *
 * **Strategy:**
 * - Tokens are first swapped to USDC on their source chains
 * - USDC is bridged to destination chain using Circle's CCTP
 * - On destination chain, USDC is swapped to final token (if needed)
 * - Steps are bundled when they can execute in parallel
 *
 * @param sourceTokens - Array of tokens to consolidate (max 50)
 * @param destinationToken - Final target token and chain for consolidation
 * @param log - Optional logging function for debug output
 * @returns Array of transaction steps with dependencies and bundling information
 *
 * @throws {Error} PlanningError - Invalid inputs or too many tokens
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
 *   console.log
 * );
 * // Returns: [swap1, swap2, bridge, attestation, claim, finalSwap]
 */
export async function planConsolidation(
  sourceTokens: TokenAmount[],
  destinationToken: DestinationToken,
  log: (...args: unknown[]) => void = () => {},
): Promise<TransactionStep[]> {
  // Step 1: Validate inputs
  validateInputs(sourceTokens, destinationToken, log);

  // Step 2: Group tokens
  const { byChainAndWallet, byChain } = groupTokens(sourceTokens, log);

  // Get destination chain USDC address
  const destChainUSDC = USDC_ADDRESSES[destinationToken.chainId as keyof typeof USDC_ADDRESSES] as Address;

  // Step 3: Process swaps for each chain-wallet group
  let stepCounter = 0;
  const swapResult = await processChainWalletSwaps(byChainAndWallet, destinationToken, stepCounter, log);
  stepCounter = swapResult.nextCounter;
  const allSteps = [...swapResult.steps];

  // Step 4: Create bridge steps
  const bridgeResult = await createBridgeSteps(byChain, allSteps, destinationToken, destChainUSDC, stepCounter, log);
  stepCounter = bridgeResult.nextCounter;
  allSteps.push(...bridgeResult.steps);

  // Step 5: Create attestation and claim steps
  const attestClaimResult = createAttestationAndClaimSteps(
    bridgeResult.steps,
    destinationToken,
    destChainUSDC,
    stepCounter,
  );
  stepCounter = attestClaimResult.nextCounter;
  allSteps.push(...attestClaimResult.steps);

  // Step 6: Create final swap on destination chain
  const finalSwapResult = await createFinalSwap(allSteps, byChain, destinationToken, destChainUSDC, stepCounter, log);
  allSteps.push(...finalSwapResult.steps);

  // Step 7: Identify bundling opportunities
  log(
    "🔍 [DEBUG] Generated steps before bundling:",
    allSteps.map((s) => ({
      id: s.id,
      type: s.type,
      chainId: s.chainId,
      inputTokens: s.inputTokens.map((t) => ({ symbol: t.symbol, amount: t.amount.toString() })),
      outputToken: s.outputToken ? { symbol: s.outputToken.symbol, amount: s.outputToken.amount?.toString() } : null,
      dependsOn: s.dependsOn,
    })),
  );

  return allSteps;
}
