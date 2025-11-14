import { isAddressEqual } from "viem";
import { TokenCard } from "~/components/token-card";
import type { ConsolidationState, TokenAmount } from "~/lib/types";

interface ConsolidationTokensSummaryProps {
  state: ConsolidationState;
}

export function ConsolidationTokensSummary({ state }: ConsolidationTokensSummaryProps) {
  // Get final tokens (always includes destination token first)
  const finalTokens = getFinalTokens(state);

  // Get source tokens with their usage status
  const sourceTokensWithStatus = getSourceTokensWithStatus(state);

  return (
    <div className="grid md:grid-cols-2 gap-4">
      {/* Source Tokens */}
      <div>
        <h4 className="text-sm font-medium mb-3 text-muted-foreground">Source Tokens</h4>
        <div className="space-y-2">
          {sourceTokensWithStatus.map(({ token, label }, idx) => (
            <TokenCard key={`${token.token}-${token.chainId}-${idx}`} token={token} label={label} />
          ))}
        </div>
      </div>

      {/* Final Token(s) */}
      <div>
        <h4 className="text-sm font-medium mb-3 text-muted-foreground">
          {finalTokens.length === 1 ? "Final Token" : "Final Tokens"}
        </h4>
        <div className="space-y-2">
          {finalTokens.map(({ token, label }, idx) => (
            <TokenCard key={`${token.token}-${token.chainId}-${idx}`} token={token} label={label} />
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Get the source tokens with their status labels
 * Returns tokens marked as "Unused" if they were part of skipped steps
 */
function getSourceTokensWithStatus(state: ConsolidationState): Array<{ token: TokenAmount; label?: string }> {
  return state.sourceTokens.map((token) => {
    // Find if any step that would consume this token was skipped
    const hasSkippedConsumer = state.plan.some(
      (step) =>
        step.status === "skipped" &&
        step.inputTokens.some(
          (input) =>
            isAddressEqual(input.token, token.token) &&
            input.chainId === token.chainId &&
            isAddressEqual(input.walletAddress, token.walletAddress) &&
            input.amount === token.amount,
        ),
    );

    return {
      token,
      label: hasSkippedConsumer ? "Unused" : undefined,
    };
  });
}

/**
 * Get the final tokens from the consolidation state
 * Always returns the destination token first (even with 0 amount if never reached)
 * For partial: includes other successful final step outputs marked as "Unintended"
 */
function getFinalTokens(state: ConsolidationState): Array<{ token: TokenAmount; label?: string }> {
  // Get all successful steps, excluding attestation steps (they're verification, not real tokens)
  const successfulSteps = state.plan.filter((step) => step.status === "success" && step.type !== "attestation");

  if (state.status === "completed") {
    // For completed: return the destination token with the final amount
    const lastStep = successfulSteps[successfulSteps.length - 1];
    return [
      {
        token: {
          ...state.destinationToken,
          amount: lastStep.outputToken.amount,
        },
        label: undefined,
      },
    ];
  }

  // For partial: collect outputs from all successful final steps
  // Find steps that don't have any dependent steps that succeeded
  const finalSteps = successfulSteps.filter((step) => {
    const hasSuccessfulDependent = successfulSteps.some((otherStep) =>
      otherStep.inputTokens.some((input) => input.provenance === step.id),
    );
    return !hasSuccessfulDependent;
  });

  const finalTokensList: Array<{ token: TokenAmount; label?: string }> = [];

  // Always include destination token first
  // Check if any final step produced the destination token
  const destinationFinalStep = finalSteps.find(
    (step) =>
      isAddressEqual(step.outputToken.token, state.destinationToken.token) &&
      step.outputToken.chainId === state.destinationToken.chainId,
  );

  if (destinationFinalStep) {
    // We reached the destination token
    finalTokensList.push({
      token: destinationFinalStep.outputToken,
      label: undefined,
    });
  } else {
    // We never reached the destination token, show it with 0 amount
    finalTokensList.push({
      token: {
        ...state.destinationToken,
        amount: 0n,
      },
      label: undefined,
    });
  }

  // Add other final tokens (not the destination) marked as "Unintended"
  for (const step of finalSteps) {
    const isDestinationToken =
      isAddressEqual(step.outputToken.token, state.destinationToken.token) &&
      step.outputToken.chainId === state.destinationToken.chainId;

    if (!isDestinationToken) {
      finalTokensList.push({
        token: step.outputToken,
        label: "Unintended",
      });
    }
  }

  return finalTokensList;
}
