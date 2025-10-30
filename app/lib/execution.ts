import type { Account, Chain, HttpTransport, WalletClient } from "viem";
import { type Call, encodeFunctionData, parseAbi } from "viem";
import { executeCCTPBurn, executeCCTPMint, retrieveAttestations } from "./cctp";
import { createTransactionError } from "./errors";
import { executeOdosSwapOrTransfer, getSwapQuote } from "./odos";
import { prepareSendCalls } from "./send-calls";
import type { ConsolidationState, StepResult, TokenAmount, TransactionStep } from "./types";

/**
 * Execute consolidation plan with dependency tracking and error handling (T014)
 * Yields state after each significant change for progress tracking and persistence.
 * @param state - Consolidation state
 * @param walletClient - Wallet client for transaction execution
 * @yields Updated consolidation state after each step change
 */
export async function* executeConsolidationPlan(
  state: ConsolidationState,
  walletClient: WalletClient<HttpTransport, Chain, Account>,
): AsyncGenerator<ConsolidationState, void, void> {
  // Validate initial state - allow ready, paused, or executing (for recovery scenarios)
  if (state.status !== "ready" && state.status !== "paused" && state.status !== "executing") {
    throw new Error("Invalid state: must be 'ready', 'paused', or 'executing'");
  }

  // Create a working copy of the state to avoid mutating the parameter
  const workingState: ConsolidationState = {
    ...state,
    status: "executing",
    updatedAt: Date.now(),
    results: { ...state.results },
    plan: [...state.plan],
    metadata: state.metadata ? { ...state.metadata } : undefined,
  };

  // Yield initial state change
  yield structuredClone(workingState);

  let pausedDueToFailure = false;

  // Execute steps in order
  for (let i = workingState.currentStepIndex; i < workingState.plan.length; i++) {
    const step = workingState.plan[i];
    const updatedState = {
      ...workingState,
      currentStepIndex: i,
    };
    Object.assign(workingState, updatedState);

    // Skip if already completed or failed
    const existingResult = workingState.results[step.id];
    if (existingResult?.status === "success" || existingResult?.status === "failed") {
      continue;
    }

    // Check if step should be skipped (T015)
    if (shouldSkipStep(step, workingState.results)) {
      const skipReason = getSkipReason(step, workingState.results);
      const skippedStep = { ...step, status: "skipped" as const };
      workingState.results = {
        ...workingState.results,
        [step.id]: {
          stepId: step.id,
          status: "skipped",
          chainId: step.chainId,
          skipReason,
        },
      };
      workingState.plan = [...workingState.plan];
      workingState.plan[i] = skippedStep;
      workingState.updatedAt = Date.now();

      // Yield state after skipping step
      yield structuredClone(workingState);
      continue;
    }

    // Execute step - create new step reference with executing status
    const executingStep = { ...step, status: "executing" as const };
    workingState.plan = [...workingState.plan];
    workingState.plan[i] = executingStep;
    workingState.updatedAt = Date.now();

    // Yield state when starting step execution
    yield structuredClone(workingState);

    try {
      const result = await executeStep(executingStep, workingState, walletClient);

      // Success - create new step reference with success status
      const successStep = {
        ...executingStep,
        status: "success" as const,
        transactionHash: result.transactionHash,
        executedAt: Date.now(),
      };
      workingState.results = {
        ...workingState.results,
        [successStep.id]: result,
      };
      workingState.plan = [...workingState.plan];
      workingState.plan[i] = successStep;
      workingState.updatedAt = Date.now();

      // Recalculate remaining steps with actual amounts (T016)
      if (result.actualOutput) {
        await recalculatePlan(workingState, i, result.actualOutput);
        workingState.updatedAt = Date.now();
      }

      // Yield state after successful step execution
      yield structuredClone(workingState);
    } catch (error) {
      // Failure - create new step reference with failed status
      const txError = createTransactionError(error);
      const failedStep = {
        ...executingStep,
        status: "failed" as const,
        error: txError,
      };
      workingState.results = {
        ...workingState.results,
        [failedStep.id]: {
          stepId: failedStep.id,
          status: "failed",
          chainId: failedStep.chainId,
          error: txError,
        },
      };
      workingState.plan = [...workingState.plan];
      workingState.plan[i] = failedStep;
      workingState.updatedAt = Date.now();

      // If hasSubsequentExecution is false, pause for retry
      if (!workingState.hasSubsequentExecution) {
        pausedDueToFailure = true;
        workingState.status = "paused";
        workingState.currentStepIndex = i;

        // Yield paused state and return
        yield structuredClone(workingState);
        return;
      }

      // Otherwise, yield state and continue to next step
      yield structuredClone(workingState);
    }
  }

  // All steps completed (only if we didn't pause)
  if (!pausedDueToFailure) {
    const hasSkipped = Object.values(workingState.results).some((r) => r.status === "skipped");
    const hasFailed = Object.values(workingState.results).some((r) => r.status === "failed");
    const finalStatus = hasSkipped || hasFailed ? ("partial" as const) : ("completed" as const);
    workingState.status = finalStatus;
    workingState.currentStepIndex = workingState.plan.length;
    workingState.updatedAt = Date.now();

    // Yield final state and return
    yield structuredClone(workingState);
    return;
  }
}

/**
 * Filters out tokens with zero amounts and validates at least one token remains
 * @param tokens - Array of tokens to filter
 * @param stepId - Step ID for error message
 * @param stepType - Step type for error message
 * @returns Non-empty array of tokens with amounts > 0
 * @throws {Error} If all tokens have zero amounts
 */
function filterZeroAmounts(
  tokens: readonly TokenAmount[],
  stepId: string,
  stepType: string,
): [TokenAmount, ...TokenAmount[]] {
  const nonZeroTokens = tokens.filter((t) => t.amount > 0n);

  if (nonZeroTokens.length === 0) {
    throw new Error(`Cannot execute ${stepType} with zero input amounts for step ${stepId}`);
  }

  return nonZeroTokens as [TokenAmount, ...TokenAmount[]];
}

/**
 * Execute a single transaction step
 * @param step - Transaction step
 * @param state - Consolidation state
 * @param walletClient - Wallet client
 * @returns Step result
 */
async function executeStep(
  step: TransactionStep,
  state: ConsolidationState,
  walletClient: WalletClient<HttpTransport, Chain, Account>,
): Promise<StepResult> {
  const sendCalls = prepareSendCalls(walletClient);

  switch (step.type) {
    case "swap": {
      // Filter out tokens with zero amounts
      const nonZeroTokens = filterZeroAmounts(step.inputTokens, step.id, "swap");

      // Execute swap using Odos with non-zero tokens
      const { amount: actualAmount, transactionHash } = await executeOdosSwapOrTransfer(
        nonZeroTokens,
        step.outputToken,
        sendCalls,
      );

      const actualOutput: TokenAmount = {
        ...step.outputToken,
        amount: actualAmount,
        provenance: step.id, // When swap is successful, the amount of all dependent steps will update
      };

      return {
        stepId: step.id,
        status: "success",
        chainId: step.chainId,
        actualOutput,
        transactionHash,
      };
    }

    case "bridge": {
      // Validate all input tokens are homogeneous before combining
      if (step.inputTokens.length > 1) {
        const firstToken = step.inputTokens[0];
        for (let i = 1; i < step.inputTokens.length; i++) {
          const token = step.inputTokens[i];
          if (
            token.token !== firstToken.token ||
            token.chainId !== firstToken.chainId ||
            token.walletAddress !== firstToken.walletAddress
          ) {
            throw new Error(
              `Cannot combine heterogeneous input tokens for bridge step ${step.id}: ` +
                `token[0]={token: ${firstToken.token}, chainId: ${firstToken.chainId}, wallet: ${firstToken.walletAddress}} vs ` +
                `token[${i}]={token: ${token.token}, chainId: ${token.chainId}, wallet: ${token.walletAddress}}`,
            );
          }
        }
      }

      // Filter out tokens with zero amounts
      const nonZeroTokens = filterZeroAmounts(step.inputTokens, step.id, "bridge");

      // Sum all non-zero input amounts (bridge may have multiple USDC sources)
      const totalAmount = nonZeroTokens.reduce((sum, t) => sum + t.amount, 0n);
      const combinedInput = { ...nonZeroTokens[0], amount: totalAmount };

      // Execute CCTP burn
      const [burnTx] = await executeCCTPBurn(combinedInput, step.outputToken, sendCalls);

      return {
        stepId: step.id,
        status: "success",
        chainId: step.chainId,
        actualOutput: {
          ...step.outputToken,
          provenance: step.id, // When bridge is successful, the amount of all dependent steps will update
        },
        transactionHash: burnTx,
      };
    }

    case "attestation": {
      // Collect transaction hashes from successful bridge steps using input token provenance
      const bridgeStepIds = getProvenanceSteps(step);
      const bridgeTxs = Array.from(bridgeStepIds)
        .map((stepId) => {
          const depResult = state.results[stepId];
          if (!depResult?.transactionHash) return null;
          return [depResult.transactionHash, depResult.chainId] as [string, number];
        })
        .filter((tx): tx is [string, number] => tx !== null);

      if (bridgeTxs.length === 0) {
        throw new Error("No bridge transactions found for attestation");
      }

      // Retrieve attestations
      const attestations = await retrieveAttestations(bridgeTxs);

      // Store attestations for claim step (mutation of working state during execution)
      const updatedMetadata = { ...state.metadata, attestations };
      Object.assign(state, { metadata: updatedMetadata });

      // Calculate actual bridged amount from attestations
      const actualAmount = attestations.reduce(
        (sum, attestation) =>
          sum +
          BigInt(attestation.decodedMessage.decodedMessageBody.amount) -
          BigInt(attestation.decodedMessage.decodedMessageBody.feeExecuted),
        0n,
      );

      const actualOutput: TokenAmount = {
        ...step.outputToken,
        amount: actualAmount,
        provenance: step.id, // When attestation is successful, the amount of all dependent steps will update
      };

      return {
        stepId: step.id,
        status: "success",
        chainId: step.chainId,
        actualOutput,
      };
    }

    case "claim": {
      // Get attestations from previous attestation step
      const attestations = state.metadata?.attestations;
      if (!attestations || attestations.length === 0) {
        throw new Error("No attestations found for claim");
      }

      // Execute CCTP mint
      const [mintTx] = await executeCCTPMint(attestations, step.outputToken, sendCalls);

      // Calculate actual amount from attestations
      const actualAmount = attestations.reduce(
        (sum, attestation) =>
          sum +
          BigInt(attestation.decodedMessage.decodedMessageBody.amount) -
          BigInt(attestation.decodedMessage.decodedMessageBody.feeExecuted),
        0n,
      );

      const actualOutput: TokenAmount = {
        ...step.outputToken,
        amount: actualAmount,
        provenance: step.id, // When claim is successful, the amount of all dependent steps will update
      };

      return {
        stepId: step.id,
        status: "success",
        chainId: step.chainId,
        actualOutput,
        transactionHash: mintTx,
      };
    }

    case "transfer": {
      // Execute simple ERC20 transfer(s)
      const calls: Call[] = [];

      if (step.inputTokens.length > 1) {
        throw new Error("Transfer step can only have one input token");
      }

      const inputToken = step.inputTokens[0];

      // Validate tokens are on the same chain
      if (inputToken.chainId !== step.outputToken.chainId) {
        throw new Error("Transfer source and destination must be on the same chain");
      }

      // Build transfer call
      calls.push({
        to: inputToken.token,
        data: encodeFunctionData({
          abi: parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]),
          args: [step.outputToken.walletAddress, inputToken.amount],
        }),
      });

      // Execute all transfers
      const [transactionHash] = await sendCalls("transfer", step.chainId, step.inputTokens[0].walletAddress, calls);

      return {
        stepId: step.id,
        status: "success",
        chainId: step.chainId,
        actualOutput: {
          ...inputToken,
          walletAddress: step.outputToken.walletAddress,
          provenance: step.id, // When transfer is successful, the amount of all dependent steps will update
        },
        transactionHash,
      };
    }

    default:
      throw new Error(`Unknown step type: ${step.type}`);
  }
}

/**
 * Get unique step IDs from input token provenance
 * @param step - Transaction step
 * @returns Set of step IDs that produced the input tokens
 */
function getProvenanceSteps(step: TransactionStep): Set<string> {
  return new Set(step.inputTokens.map((t) => t.provenance).filter((p): p is string => p !== undefined));
}

/**
 * Check if a step should be skipped due to failed dependencies (T015)
 * Uses input token provenance to determine dependencies
 * @param step - Transaction step
 * @param results - Map of step results
 * @returns True if step should be skipped
 */
export function shouldSkipStep(step: TransactionStep, results: Record<string, StepResult>): boolean {
  const provenanceSteps = getProvenanceSteps(step);

  if (provenanceSteps.size === 0) return false; // No dependencies

  // Skip if ALL provenance steps failed/skipped
  return Array.from(provenanceSteps).every((stepId) => {
    const result = results[stepId];
    return result?.status === "failed" || result?.status === "skipped";
  });
}

/**
 * Get skip reason for a step
 * Uses input token provenance to identify failed dependencies
 * @param step - Transaction step
 * @param results - Map of step results
 * @returns Skip reason message
 */
function getSkipReason(step: TransactionStep, results: Record<string, StepResult>): string {
  const provenanceSteps = getProvenanceSteps(step);

  const failedDeps = Array.from(provenanceSteps).filter((stepId) => {
    const depResult = results[stepId];
    return depResult?.status === "failed";
  });

  if (failedDeps.length > 0) {
    return `Depends on failed step ${failedDeps[0]}`;
  }

  const skippedDeps = Array.from(provenanceSteps).filter((stepId) => {
    const depResult = results[stepId];
    return depResult?.status === "skipped";
  });

  if (skippedDeps.length > 0) {
    return `Depends on skipped step ${skippedDeps[0]}`;
  }

  // Note: This fallback should never be reached given current shouldSkipStep() logic,
  // but kept as defensive programming in case skip logic changes in the future
  return "Skipped";
}

/**
 * Calculate updated output for a step based on its type and updated inputs
 * @param step - Transaction step to calculate output for
 * @param updatedInputs - Updated input token amounts
 * @returns Updated output token amount
 */
async function calculateStepOutput(
  step: TransactionStep,
  updatedInputs: [TokenAmount, ...TokenAmount[]],
): Promise<TokenAmount> {
  switch (step.type) {
    case "swap":
      // Re-quote with ALL inputs for proportional adjustment
      try {
        return await getSwapQuote(updatedInputs, step.outputToken);
      } catch (_error) {
        return step.outputToken; // Keep original on failure
      }
    case "bridge": {
      // Bridge outputs sum of all inputs (minus bridge fees, handled elsewhere)
      const totalAmount = updatedInputs.reduce((sum, t) => sum + t.amount, 0n);
      return {
        ...step.outputToken,
        amount: totalAmount,
      };
    }
    case "claim": {
      // Claim outputs what it claims (sum of all bridged amounts)
      const totalClaimAmount = updatedInputs.reduce((sum, t) => sum + t.amount, 0n);
      return {
        ...step.outputToken,
        amount: totalClaimAmount,
      };
    }
    case "transfer":
      // Transfer outputs what it inputs (1:1)
      return {
        ...step.outputToken,
        amount: updatedInputs[0].amount,
      };
    case "attestation":
      // Attestations don't change amounts
      return step.outputToken;

    default:
      return step.outputToken;
  }
}

/**
 * Recalculate plan after a step completes with actual amounts (T016)
 * Cascades changes through all dependent steps in the plan.
 * @param state - Consolidation state (mutated in place for working state)
 * @param completedStepIndex - Index of completed step
 * @param actualOutput - Actual output amount
 */
async function recalculatePlan(
  state: ConsolidationState,
  completedStepIndex: number,
  actualOutput: TokenAmount,
): Promise<void> {
  const completedStep = state.plan[completedStepIndex];

  // Create a new plan array with updated steps
  const updatedPlan = [...state.plan];

  // Track which outputs have changed, starting with the completed step
  const changedOutputs = new Map<string, TokenAmount>();
  changedOutputs.set(completedStep.id, actualOutput);

  // Iterate through remaining steps in order
  for (let i = completedStepIndex + 1; i < updatedPlan.length; i++) {
    const step = updatedPlan[i];

    // Check if this step depends on any changed outputs using input token provenance
    const dependenciesChanged = step.inputTokens.some(
      (input) => input.provenance && changedOutputs.has(input.provenance),
    );

    if (!dependenciesChanged) {
      continue; // Skip, no updates needed
    }

    // Update inputs: check each token's provenance to see if it needs updating
    const updatedInputs = step.inputTokens.map((input) => {
      const sourceStepId = input.provenance;

      if (sourceStepId) {
        const changedOutput = changedOutputs.get(sourceStepId);
        if (changedOutput) {
          // Update amount but preserve other metadata including provenance
          return { ...input, amount: changedOutput.amount };
        }
      }

      // No provenance or no change: keep input unchanged
      return input;
    }) as [TokenAmount, ...TokenAmount[]];

    // Recalculate output based on step type
    const newOutput = await calculateStepOutput(step, updatedInputs);

    // Update the step in the plan
    updatedPlan[i] = {
      ...step,
      inputTokens: updatedInputs,
      outputToken: newOutput,
    };

    // Track this change for downstream dependencies
    if (newOutput.amount !== step.outputToken.amount) {
      changedOutputs.set(step.id, newOutput);
    }
  }

  // Update state with new plan and timestamp
  Object.assign(state, {
    plan: updatedPlan,
    updatedAt: Date.now(),
  });
}
