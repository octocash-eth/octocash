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

  try {
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

      // Adapt step for partial dependencies (T015)
      const adaptedStep = adaptStepForPartialDependencies(step, workingState.results);
      workingState.plan = [...workingState.plan];
      workingState.plan[i] = adaptedStep;

      // Execute step - create new step reference with executing status
      const executingStep = { ...adaptedStep, status: "executing" as const };
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
  } catch (error) {
    // Unexpected error
    workingState.status = "paused";
    workingState.updatedAt = Date.now();

    // Yield error state before throwing
    yield structuredClone(workingState);
    throw error;
  }
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
      // Execute swap using Odos
      const { amount: actualAmount, transactionHash } = await executeOdosSwapOrTransfer(
        step.inputTokens,
        step.outputToken,
        sendCalls,
      );

      const actualOutput: TokenAmount = {
        ...step.outputToken,
        amount: actualAmount,
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
      // Execute CCTP burn
      const [burnTx] = await executeCCTPBurn(step.inputTokens[0], step.outputToken, sendCalls);

      return {
        stepId: step.id,
        status: "success",
        chainId: step.chainId,
        transactionHash: burnTx,
      };
    }

    case "attestation": {
      // Collect transaction hashes from successful bridge steps
      const bridgeTxs = step.dependsOn
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
        actualOutput: inputToken,
        transactionHash,
      };
    }

    default:
      throw new Error(`Unknown step type: ${step.type}`);
  }
}

/**
 * Check if a step should be skipped due to failed dependencies (T015)
 * @param step - Transaction step
 * @param results - Map of step results
 * @returns True if step should be skipped
 */
export function shouldSkipStep(step: TransactionStep, results: Record<string, StepResult>): boolean {
  // Steps with no dependencies should never be skipped
  if (step.dependsOn.length === 0) {
    return false;
  }

  // Partial dependency steps can execute with subset of dependencies
  if (step.partialDependency) {
    // Check if at least one dependency succeeded
    const hasAnySuccess = step.dependsOn.some((depId) => {
      const depResult = results[depId];
      return depResult?.status === "success";
    });
    return !hasAnySuccess; // Skip only if ALL dependencies failed/skipped
  }

  // Regular steps require ALL dependencies to succeed
  for (const depId of step.dependsOn) {
    const depResult = results[depId];
    if (depResult?.status === "failed" || depResult?.status === "skipped") {
      return true; // Skip if ANY dependency failed or was skipped
    }
  }

  return false;
}

/**
 * Adapt step to execute with partial dependencies (T015)
 * @param step - Transaction step
 * @param results - Map of step results
 * @returns Adapted step
 */
export function adaptStepForPartialDependencies(
  step: TransactionStep,
  results: Record<string, StepResult>,
): TransactionStep {
  if (!step.partialDependency) {
    return step; // No adaptation needed
  }

  // Filter dependencies to only successful ones
  const successfulDeps = step.dependsOn.filter((depId) => {
    const depResult = results[depId];
    return depResult?.status === "success";
  });

  if (successfulDeps.length === step.dependsOn.length) {
    return step; // All dependencies succeeded, no adaptation needed
  }

  return {
    ...step,
    dependsOn: successfulDeps,
    adaptedFrom: step.adaptedFrom || step.dependsOn, // Keep original for display
  };
}

/**
 * Get skip reason for a step
 * @param step - Transaction step
 * @param results - Map of step results
 * @returns Skip reason message
 */
function getSkipReason(step: TransactionStep, results: Record<string, StepResult>): string {
  const failedDeps = step.dependsOn.filter((depId) => {
    const depResult = results[depId];
    return depResult?.status === "failed";
  });

  if (failedDeps.length > 0) {
    return `Depends on failed step ${failedDeps[0]}`;
  }

  const skippedDeps = step.dependsOn.filter((depId) => {
    const depResult = results[depId];
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
async function calculateStepOutput(step: TransactionStep, updatedInputs: TokenAmount[]): Promise<TokenAmount> {
  switch (step.type) {
    case "swap":
      // Re-quote with ALL inputs for proportional adjustment
      if (updatedInputs.length > 0) {
        try {
          return await getSwapQuote(updatedInputs, step.outputToken);
        } catch (_error) {
          return step.outputToken; // Keep original on failure
        }
      }
      return step.outputToken;

    case "bridge":
      // Bridge outputs what it inputs (1:1, same token/amount)
      if (updatedInputs.length > 0) {
        const firstInput = updatedInputs[0];
        return {
          ...step.outputToken,
          amount: firstInput.amount,
        };
      }
      return step.outputToken;

    case "claim":
      // Claim outputs what it claims (1:1, amount from dependency)
      if (updatedInputs.length > 0) {
        const firstInput = updatedInputs[0];
        return {
          ...step.outputToken,
          amount: firstInput.amount,
        };
      }
      return step.outputToken;

    case "transfer":
      // Transfer outputs what it inputs (1:1)
      if (updatedInputs.length > 0) {
        const firstInput = updatedInputs[0];
        return {
          ...step.outputToken,
          amount: firstInput.amount,
        };
      }
      return step.outputToken;

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

    // Check if this step depends on any changed outputs
    const dependenciesChanged = step.dependsOn.some((depId) => changedOutputs.has(depId));

    if (!dependenciesChanged) {
      continue; // Skip, no updates needed
    }

    // Update inputs: replace any input that matches a changed output
    const updatedInputs: TokenAmount[] = [];

    for (const input of step.inputTokens) {
      // Find if this input matches any changed output
      let matchingChange: TokenAmount | undefined;
      for (const changedOutput of changedOutputs.values()) {
        if (
          changedOutput.token === input.token &&
          changedOutput.chainId === input.chainId &&
          changedOutput.walletAddress === input.walletAddress
        ) {
          matchingChange = changedOutput;
          break;
        }
      }

      if (matchingChange) {
        updatedInputs.push({ ...input, amount: matchingChange.amount });
      } else {
        updatedInputs.push(input);
      }
    }

    // Handle case where dependency added a new token (not in original inputs)
    for (const depId of step.dependsOn) {
      const changedOutput = changedOutputs.get(depId);
      if (changedOutput) {
        // Check if this output is already in updatedInputs
        const existsInInputs = updatedInputs.some(
          (input) =>
            input.token === changedOutput.token &&
            input.chainId === changedOutput.chainId &&
            input.walletAddress === changedOutput.walletAddress,
        );

        if (!existsInInputs) {
          updatedInputs.push(changedOutput);
        }
      }
    }

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
