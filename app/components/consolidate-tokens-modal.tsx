import * as React from "react";
import { getAddress, isAddress, parseUnits } from "viem";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "~/components/ui/dialog";
import {
  Stepper,
  StepperContent,
  StepperIndicator,
  StepperItem,
  StepperNav,
  StepperPanel,
  StepperTitle,
  StepperTrigger,
} from "~/components/ui/stepper";
import { useFormatFiat } from "~/context/currency-provider";
import { usePriceMap, useRegisterPrices } from "~/context/token-price-provider";
import { USDC } from "~/data/token-contracts";
import { formatTokenAmount, getTokenId } from "~/lib/tokens";
import type { ConsolidationState, DestinationToken, SourceToken, TokenAmount } from "~/lib/types";
import { CompletionStage } from "./consolidation-stages/completion-stage";
import { ConfirmPlanStage } from "./consolidation-stages/confirm-plan-stage";
import { SelectAmountStage } from "./consolidation-stages/select-amount-stage";
import { type DestinationSelection, SelectDestinationStage } from "./consolidation-stages/select-destination-stage";

/**
 * TokenAmount extended with the amount to consolidate (as a formatted string)
 */
export interface TokenWithConsolidateAmount extends TokenAmount {
  amountToConsolidate: string;
}

interface ConsolidateTokensModalProps {
  tokens: TokenAmount[];
  rowSelection?: Record<string, boolean>;
  selectedRows?: number;
  onComplete?: () => void;
}

export function ConsolidateTokensModal({
  tokens,
  rowSelection = {},
  selectedRows = 0,
  onComplete,
}: ConsolidateTokensModalProps) {
  const [destination, setDestination] = React.useState({
    walletAddress: undefined,
    chainId: undefined,
    tokenInfo: undefined,
  } as DestinationSelection);
  const [open, setOpen] = React.useState(false);
  const [currentStage, setCurrentStage] = React.useState(1);
  const [planId, setPlanId] = React.useState("");
  const [tokenAmounts, setTokenAmounts] = React.useState<Record<string, string>>({});
  const [completedState, setCompletedState] = React.useState<ConsolidationState | null>(null);
  const [isExecuting, setIsExecuting] = React.useState(false);
  const formatFiat = useFormatFiat();

  const consolidatedTokens = React.useMemo<TokenWithConsolidateAmount[]>(() => {
    return tokens
      .filter((token) => rowSelection[getTokenId(token)])
      .map((token) => {
        const tokenId = getTokenId(token);
        const amount = tokenAmounts[tokenId] || formatTokenAmount(token);
        return { ...token, amountToConsolidate: amount };
      });
  }, [rowSelection, tokens, tokenAmounts]);

  // Derive sourceTokens from consolidatedTokens and other state. Note:
  // `unitaryPrice` is intentionally NOT copied here — downstream USD display
  // reads from the TokenPriceProvider context instead, so we don't propagate
  // Zerion's price into the plan.
  const sourceTokens = React.useMemo<SourceToken[]>(() => {
    if (currentStage !== 3) return [];

    return consolidatedTokens
      .filter((token) => Number.parseFloat(token.amountToConsolidate) > 0)
      .map((token) => ({
        amount: parseUnits(token.amountToConsolidate, token.decimals),
        chainId: token.chainId,
        token: token.token,
        walletAddress: token.walletAddress,
        symbol: token.symbol,
        decimals: token.decimals,
        name: token.name,
      }));
  }, [currentStage, consolidatedTokens]);

  // Derive destinationToken from form state
  const destinationToken = React.useMemo<DestinationToken | undefined>(() => {
    if (currentStage !== 3 || !isAddress(destination.walletAddress ?? "") || !destination.chainId) return undefined;

    const sendTo = getAddress(destination.walletAddress ?? "");
    if (sourceTokens.length === 0) return undefined;
    const tokenInfo = destination.tokenInfo;

    if (!tokenInfo || !isAddress(tokenInfo.address)) return undefined;

    return {
      token: getAddress(tokenInfo.address),
      chainId: destination.chainId,
      walletAddress: sendTo,
      symbol: tokenInfo.symbol,
      decimals: tokenInfo.decimals,
    };
  }, [currentStage, destination, sourceTokens]);

  // Register every selected token with the shared price context so its USD
  // value reflects the live Odos price.
  useRegisterPrices(consolidatedTokens);
  const { priceFor } = usePriceMap();

  // Calculate actual total value based on selected amounts. Uses live Odos
  // prices from the context — never the stale Zerion unitaryPrice that may
  // still be present on `token`.
  const actualTotalToConsolidate = React.useMemo(() => {
    return consolidatedTokens.reduce((total, token) => {
      const amountToConsolidate = Number.parseFloat(token.amountToConsolidate);
      if (!Number.isFinite(amountToConsolidate) || amountToConsolidate <= 0) return total;
      const price = priceFor(token);
      if (price === undefined) return total;
      return total + amountToConsolidate * price;
    }, 0);
  }, [consolidatedTokens, priceFor]);

  React.useEffect(() => {
    if (destination.chainId) {
      const usdcAddress = USDC[destination.chainId as keyof typeof USDC];
      if (usdcAddress) {
        setDestination((prev) => ({
          ...prev,
          chainId: destination.chainId,
          tokenInfo: {
            address: usdcAddress,
            decimals: 6,
            symbol: "USDC",
          },
        }));
      }
    }
  }, [destination.chainId]);

  // Reset stage when modal is closed
  React.useEffect(() => {
    if (!open) {
      setCurrentStage(1);
      setCompletedState(null);
      setTokenAmounts({});
      setPlanId("");
    }
  }, [open]);

  // Navigate to a stage, generating a fresh planId when entering stage 3.
  // This is synchronous (not in a useEffect) so the new planId is available
  // in the same render, preventing a one-frame flash of a stale cached plan.
  const navigateToStage = React.useCallback(
    (newStage: number) => {
      if (newStage === 3 && currentStage !== 3) {
        setPlanId(`consolidation-${Date.now()}`);
      }
      setCurrentStage(newStage);
    },
    [currentStage],
  );

  // Validation function for navigation
  const canNavigateToStage = React.useCallback(
    (stageNumber: number) => {
      // Cannot navigate to any stage while executing
      if (isExecuting && stageNumber !== currentStage) return false;

      // Can always navigate backwards
      if (stageNumber < currentStage) return true;

      // Can navigate to current stage
      if (stageNumber === currentStage) return true;

      // To navigate forward, all intermediate stages must be valid
      // Check stage 1 requirements (for stages 2 and 3)
      if (stageNumber >= 2) {
        const hasValidAmounts = consolidatedTokens.some((token) => Number.parseFloat(token.amountToConsolidate) > 0);
        if (!hasValidAmounts) return false;
      }

      // Check stage 2 requirements (for stage 3)
      if (stageNumber >= 3) {
        const hasValidDestination =
          isAddress(destination.walletAddress ?? "") && destination.chainId && destination.tokenInfo !== undefined;
        if (!hasValidDestination) return false;
      }

      return true;
    },
    [currentStage, consolidatedTokens, destination, isExecuting],
  );

  const handleNext = React.useCallback(() => {
    if (currentStage === 3) return;

    if (canNavigateToStage(currentStage + 1)) {
      navigateToStage(currentStage + 1);
    }
  }, [currentStage, canNavigateToStage, navigateToStage]);

  const handleBack = React.useCallback(() => {
    if (currentStage > 1) {
      navigateToStage(currentStage - 1);
    }
  }, [currentStage, navigateToStage]);

  const handleComplete = React.useCallback((state: ConsolidationState) => {
    console.log("[Modal] handleComplete called with status:", state.status);
    // Show completion view for terminal states (completed or partial)
    if (state.status === "completed" || state.status === "partial") {
      setCompletedState(state);
      setIsExecuting(false);
    }
  }, []);

  const handleOpenChange = React.useCallback(
    (newOpen: boolean) => {
      // Prevent closing while executing
      if (!newOpen && isExecuting) {
        return;
      }

      // If closing the modal while in completion state, trigger onComplete
      if (!newOpen && completedState) {
        onComplete?.();
      }
      setOpen(newOpen);
    },
    [completedState, onComplete, isExecuting],
  );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button
          size="lg"
          className={`text-lg font-semibold py-6 px-8 transition-all duration-200 ${selectedRows > 0 ? "min-w-[240px]" : ""}`}
          disabled={selectedRows === 0}
        >
          {selectedRows === 0 ? "Consolidate Tokens" : <>Consolidate tokens</>}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-5xl" showCloseButton={!isExecuting}>
        <DialogHeader className="pb-4">
          <DialogTitle className="text-xl">
            {completedState ? (
              completedState.status === "completed" ? (
                "Consolidation Complete"
              ) : (
                "Consolidation Partially Complete"
              )
            ) : (
              <>Consolidate {formatFiat(actualTotalToConsolidate)}</>
            )}
          </DialogTitle>
          {!completedState && (
            <DialogDescription>
              {currentStage === 1 &&
                `Adjust amounts for ${selectedRows} selected token${selectedRows !== 1 ? "s" : ""}.`}
              {currentStage === 2 && "Select the destination wallet, chain, and token."}
              {currentStage === 3 && "Review and execute the consolidation plan."}
            </DialogDescription>
          )}
        </DialogHeader>

        {completedState ? (
          <CompletionStage state={completedState} onClose={() => handleOpenChange(false)} />
        ) : (
          <Stepper value={currentStage} onValueChange={navigateToStage} className="space-y-6">
            <StepperNav className="gap-3.5">
              {[
                { id: "select-amount", title: "Select Amount" },
                { id: "select-destination", title: "Select Destination" },
                { id: "confirm-plan", title: "Confirm Plan" },
              ].map((stage, index) => {
                const stageNumber = index + 1;
                return (
                  <StepperItem
                    key={stage.id}
                    step={stageNumber}
                    className="relative flex-1 items-start"
                    disabled={!canNavigateToStage(stageNumber)}
                  >
                    <StepperTrigger className="flex flex-col items-start justify-center gap-3.5 grow">
                      <StepperIndicator className="bg-border rounded-full h-1 w-full data-[state=active]:bg-secondary/80 data-[state=completed]:bg-secondary/50" />
                      <div className="flex flex-col items-start gap-1">
                        <StepperTitle className="text-start font-semibold group-data-[state=inactive]/step:text-muted-foreground">
                          {stage.title}
                        </StepperTitle>
                      </div>
                    </StepperTrigger>
                  </StepperItem>
                );
              })}
            </StepperNav>

            <StepperPanel step={currentStage} className="text-sm">
              <StepperContent value={1}>
                <SelectAmountStage tokens={consolidatedTokens} onAmountsChange={setTokenAmounts} />
                <div className="pt-4 flex gap-2">
                  <Button onClick={handleNext} disabled={!canNavigateToStage(2)} className="w-full">
                    Next
                  </Button>
                </div>
              </StepperContent>

              <StepperContent value={2}>
                <SelectDestinationStage value={destination} onChange={setDestination} />
                <div className="pt-4 flex gap-2">
                  <Button onClick={handleBack} variant="outline" className="flex-1">
                    Back
                  </Button>
                  <Button onClick={handleNext} disabled={!canNavigateToStage(3)} className="flex-1">
                    Next
                  </Button>
                </div>
              </StepperContent>

              <StepperContent value={3}>
                {planId && destinationToken && (
                  <ConfirmPlanStage
                    planId={planId}
                    sourceTokens={sourceTokens}
                    destinationToken={destinationToken}
                    onComplete={handleComplete}
                    onBack={handleBack}
                    onExecutionStateChange={setIsExecuting}
                  />
                )}
              </StepperContent>
            </StepperPanel>
          </Stepper>
        )}
      </DialogContent>
    </Dialog>
  );
}
