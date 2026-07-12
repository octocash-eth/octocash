import { isAddressEqual } from "viem";
import { TokenCard } from "~/components/token";
import { ScrollArea } from "~/components/ui/scroll-area";
import type { ConsolidationState, DestinationToken, TokenAmount, TransactionStep } from "~/lib/types";

/**
 * Check if a token matches the destination (same token address, chain, and wallet)
 */
function isTokenAtDestination(token: TokenAmount, destination: DestinationToken): boolean {
  // A Railgun destination is private — no public token is ever "at" it.
  if (destination.railgunAddress !== undefined) return false;
  return (
    isAddressEqual(token.token, destination.token) &&
    token.chainId === destination.chainId &&
    isAddressEqual(token.walletAddress, destination.walletAddress)
  );
}

/**
 * Find final steps (steps whose output is not consumed by any other step in the list)
 */
function findFinalSteps(steps: TransactionStep[]): TransactionStep[] {
  return steps.filter(
    (step) => !steps.some((other) => other.inputTokens.some((input) => input.provenance === step.id)),
  );
}

interface ConsolidationTokensSummaryProps {
  state: ConsolidationState;
}

function getTokenSummaryKey(token: TokenAmount, label?: string, railgunAddress?: string) {
  return [
    token.walletAddress,
    token.chainId,
    token.token,
    token.amount.toString(),
    label ?? "",
    railgunAddress ?? "",
  ].join(":");
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
        <ScrollArea className="max-h-[400px] w-full">
          <div className="space-y-2 pr-3">
            {sourceTokensWithStatus.map(({ token, label }) => (
              <TokenCard key={getTokenSummaryKey(token, label)} token={token} label={label} />
            ))}
          </div>
        </ScrollArea>
      </div>

      {/* Final Token(s) */}
      <div>
        <h4 className="text-sm font-medium mb-3 text-muted-foreground">
          {finalTokens.length === 1 ? "Final Token" : "Final Tokens"}
        </h4>
        <ScrollArea className="max-h-[400px] w-full">
          <div className="space-y-2 pr-3">
            {finalTokens.map(({ token, label, railgunAddress }) => (
              <TokenCard
                key={getTokenSummaryKey(token, label, railgunAddress)}
                token={token}
                label={label}
                railgunAddress={railgunAddress}
              />
            ))}
          </div>
        </ScrollArea>
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
function getFinalTokens(
  state: ConsolidationState,
): Array<{ token: TokenAmount; label?: string; railgunAddress?: string }> {
  const { destinationToken } = state;
  const successfulSteps = state.plan.filter(
    (step) =>
      step.status === "success" &&
      step.type !== "attestation" &&
      step.type !== "gas-topup" &&
      step.type !== "gas-topup-wait" &&
      step.type !== "gnosis-wait",
  );
  const finalSteps = findFinalSteps(successfulSteps);

  // Railgun destination: the final balance is whatever the shield step(s)
  // credited to the private 0zk address (already net of the 0.25% fee).
  if (destinationToken.railgunAddress !== undefined) {
    const shieldedAmount = successfulSteps
      .filter((step) => step.type === "shield")
      .reduce((sum, step) => sum + (state.results[step.id]?.actualOutput?.amount ?? step.outputToken.amount), 0n);

    const finalToken = {
      token: { ...destinationToken, amount: shieldedAmount },
      label: "Shielded",
      railgunAddress: destinationToken.railgunAddress,
    };

    if (state.status === "completed") return [finalToken];

    // Partial: anything that reached the public intermediate wallet but was
    // never shielded is still sitting there.
    const strandedTokens = finalSteps
      .filter((step) => step.type !== "shield")
      .map((step) => ({ token: step.outputToken, label: "Not shielded" as const }));
    return [finalToken, ...strandedTokens];
  }

  if (state.status === "completed") {
    // Sum source tokens already at destination
    const sourceAmount = state.sourceTokens
      .filter((token) => isTokenAtDestination(token, destinationToken))
      .reduce((sum, token) => sum + token.amount, 0n);

    // Sum final steps that produced destination tokens
    // (excluding steps that consumed source tokens already at destination)
    const stepsAmount = finalSteps
      .filter((step) => isTokenAtDestination(step.outputToken, destinationToken))
      .filter(
        (step) => !step.inputTokens.some((input) => !input.provenance && isTokenAtDestination(input, destinationToken)),
      )
      .reduce((sum, step) => sum + (state.results[step.id]?.actualOutput?.amount ?? step.outputToken.amount), 0n);

    return [{ token: { ...destinationToken, amount: sourceAmount + stepsAmount } }];
  }

  // For partial: check token type and chain (not wallet) to find destination token
  const isDestinationType = (step: TransactionStep) =>
    isAddressEqual(step.outputToken.token, destinationToken.token) &&
    step.outputToken.chainId === destinationToken.chainId;

  const destinationFinalStep = finalSteps.find(isDestinationType);
  const destinationResult = destinationFinalStep
    ? { token: destinationFinalStep.outputToken }
    : { token: { ...destinationToken, amount: 0n } };

  const unintendedTokens = finalSteps
    .filter((step) => !isDestinationType(step))
    .map((step) => ({ token: step.outputToken, label: "Unintended" as const }));

  return [destinationResult, ...unintendedTokens];
}
