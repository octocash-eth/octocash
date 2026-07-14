import * as React from "react";
import { getAddress, isAddress, parseUnits, zeroAddress } from "viem";
import { AnimateHeight } from "~/components/ui/animate-height";
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
import { useConnectedAddresses } from "~/hooks/use-connected-addresses";
import { type AccountsMap, accountFor, type WalletAccount } from "~/lib/accounts";
import { isRailgunAddress } from "~/lib/railgun";
import { formatTokenAmount, getTokenId } from "~/lib/tokens";
import type { ConsolidationState, DestinationToken, SourceToken, TokenAmount } from "~/lib/types";
import { CompletionStage } from "./consolidation-stages/completion-stage";
import { ConfirmPlanStage } from "./consolidation-stages/confirm-plan-stage";
import { SelectAmountStage } from "./consolidation-stages/select-amount-stage";
import { type DestinationSelection, SelectDestinationStage } from "./consolidation-stages/select-destination-stage";

const EMPTY_DESTINATION: DestinationSelection = {
  walletAddress: undefined,
  chainId: undefined,
  tokenInfo: undefined,
};

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
  /** Account-kind lookup for source/destination wallets; absent entries are EOAs. */
  accounts?: AccountsMap;
}

export function ConsolidateTokensModal({
  tokens,
  rowSelection = {},
  selectedRows = 0,
  onComplete,
  accounts,
}: ConsolidateTokensModalProps) {
  const [destination, setDestination] = React.useState<DestinationSelection>(EMPTY_DESTINATION);
  const [railgunBetaAccepted, setRailgunBetaAccepted] = React.useState(false);
  const [open, setOpen] = React.useState(false);
  const [currentStage, setCurrentStage] = React.useState(1);
  const [planId, setPlanId] = React.useState("");
  const [tokenAmounts, setTokenAmounts] = React.useState<Record<string, string>>({});
  const [completedState, setCompletedState] = React.useState<ConsolidationState | null>(null);
  const [isExecuting, setIsExecuting] = React.useState(false);
  const formatFiat = useFormatFiat();

  // Watch the set of connected addresses (and enabled Safes) so we can drop
  // any stale destination the user selected before switching accounts in
  // their wallet (e.g. Rabby) or toggling a Safe off.
  const connectedAddresses = useConnectedAddresses();
  const connectedAddressesKey = React.useMemo(
    () =>
      [...Array.from(connectedAddresses).map((a) => a.toLowerCase()), ...Array.from(accounts?.keys() ?? [])]
        .sort()
        .join(","),
    [connectedAddresses, accounts],
  );

  const consolidatedTokens = React.useMemo<TokenWithConsolidateAmount[]>(() => {
    return tokens
      .filter((token) => rowSelection[getTokenId(token)])
      .map((token) => {
        const tokenId = getTokenId(token);
        const amount = tokenAmounts[tokenId] || formatTokenAmount(token);
        return { ...token, amountToConsolidate: amount };
      });
  }, [rowSelection, tokens, tokenAmounts]);

  // Derive sourceTokens from consolidatedTokens and other state.
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
    const isRailgun = isRailgunAddress(destination.walletAddress);
    if (currentStage !== 3 || !destination.chainId) return undefined;
    if (!isRailgun && !isAddress(destination.walletAddress ?? "")) return undefined;

    if (sourceTokens.length === 0) return undefined;
    const tokenInfo = destination.tokenInfo;

    if (!tokenInfo || !isAddress(tokenInfo.address)) return undefined;

    return {
      token: getAddress(tokenInfo.address),
      chainId: destination.chainId,
      // For Railgun the public holder is resolved during planning (an
      // intermediate connected wallet shields); zeroAddress is a placeholder.
      walletAddress: isRailgun ? zeroAddress : getAddress(destination.walletAddress ?? ""),
      symbol: tokenInfo.symbol,
      decimals: tokenInfo.decimals,
      ...(isRailgun ? { railgunAddress: destination.walletAddress } : {}),
    };
  }, [currentStage, destination, sourceTokens]);

  // Safe mode: every selected source is Safe-held (the Addresses / Safes
  // tabs guarantee a plan never mixes kinds). Planning then only accepts a
  // Safe intermediate — funds are never custodied by an EOA mid-plan — so
  // the destination chain must be one where a candidate Safe (a source Safe,
  // or the chosen destination Safe) has a controlled deployment.
  const safeMode = React.useMemo(
    () =>
      consolidatedTokens.length > 0 &&
      consolidatedTokens.every((token) => accountFor(accounts, token.walletAddress).kind === "safe"),
    [consolidatedTokens, accounts],
  );

  const allowedChainIds = React.useMemo(() => {
    if (!safeMode) return undefined;
    const chainIds = new Set<number>();
    const addControlledChains = (account: WalletAccount) => {
      if (account.kind !== "safe") return;
      for (const deployment of Object.values(account.deployments)) {
        if (deployment.controlled) chainIds.add(deployment.chainId);
      }
    };
    for (const token of consolidatedTokens) {
      addControlledChains(accountFor(accounts, token.walletAddress));
    }
    if (destination.walletAddress && isAddress(destination.walletAddress)) {
      addControlledChains(accountFor(accounts, getAddress(destination.walletAddress)));
    }
    return [...chainIds];
  }, [safeMode, consolidatedTokens, accounts, destination.walletAddress]);

  // Register every selected token with the shared price context so its USD
  // value reflects the live Delora price.
  useRegisterPrices(consolidatedTokens);
  const { priceFor } = usePriceMap();

  // Calculate actual total value based on selected amounts using live Delora
  // prices from the context.
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
      setRailgunBetaAccepted(false);
    }
  }, [open]);

  // Reset the modal whenever the connected addresses change so a previously
  // selected destination address can't linger after the user switches
  // accounts (or disconnects one) in their wallet. We skip the first run so
  // the initial mount doesn't immediately clear default state, and we skip
  // resets while a consolidation is in flight to avoid tearing down an
  // active execution.
  const prevConnectedAddressesKeyRef = React.useRef(connectedAddressesKey);
  React.useEffect(() => {
    if (prevConnectedAddressesKeyRef.current === connectedAddressesKey) return;
    prevConnectedAddressesKeyRef.current = connectedAddressesKey;
    if (isExecuting) return;

    setOpen(false);
    setDestination(EMPTY_DESTINATION);
    setCurrentStage(1);
    setCompletedState(null);
    setTokenAmounts({});
    setPlanId("");
    setRailgunBetaAccepted(false);
  }, [connectedAddressesKey, isExecuting]);

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
        const hasValidWallet =
          isAddress(destination.walletAddress ?? "") || isRailgunAddress(destination.walletAddress);
        const hasValidDestination = hasValidWallet && destination.chainId && destination.tokenInfo !== undefined;
        if (!hasValidDestination) return false;

        // A Railgun (0zk) destination requires acknowledging the beta-risk disclaimer.
        if (isRailgunAddress(destination.walletAddress) && !railgunBetaAccepted) return false;
      }

      return true;
    },
    [currentStage, consolidatedTokens, destination, isExecuting, railgunBetaAccepted],
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
          className={`text-lg font-semibold py-6 px-8 transition-all duration-200 max-md:w-full ${selectedRows > 0 ? "min-w-[240px]" : ""}`}
          disabled={selectedRows === 0}
        >
          {selectedRows === 0 ? "Consolidate Tokens" : <>Consolidate tokens</>}
        </Button>
      </DialogTrigger>
      <DialogContent
        className="sm:max-w-5xl max-h-[calc(100dvh-1rem)] sm:max-h-[calc(100dvh-2rem)] gap-3 sm:gap-4 p-4 sm:p-6 border-2 border-pink-500 shadow-[10px_8px_0_0_var(--color-pink-600)] dark:shadow-[10px_8px_0_0_var(--color-pink-700)] [&_[data-slot=dialog-close]]:text-primary [&_[data-slot=dialog-close]]:opacity-100"
        showCloseButton={!isExecuting}
      >
        <DialogHeader className="items-center pb-2 sm:pb-4 text-center">
          <DialogTitle className="flex flex-col items-center gap-0.5 sm:gap-1">
            {completedState ? (
              <span className="text-lg sm:text-xl">
                {completedState.status === "completed" ? "Consolidation Complete" : "Consolidation Partially Complete"}
              </span>
            ) : (
              <>
                <span className="text-base sm:text-xl font-semibold text-foreground">Consolidate</span>
                <span className="font-grotesque text-3xl sm:text-4xl font-semibold text-primary">
                  {formatFiat(actualTotalToConsolidate)}
                </span>
              </>
            )}
          </DialogTitle>
          {!completedState && (
            <DialogDescription className="text-center text-xs sm:text-sm">
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
          <Stepper value={currentStage} onValueChange={navigateToStage} className="space-y-4 sm:space-y-6">
            <StepperNav className="gap-2 sm:gap-3.5">
              {[
                { id: "select-amount", title: "Select Amount", shortTitle: "Amount" },
                { id: "select-destination", title: "Select Destination", shortTitle: "Destination" },
                { id: "confirm-plan", title: "Confirm Plan", shortTitle: "Confirm Plan" },
              ].map((stage, index) => {
                const stageNumber = index + 1;
                return (
                  <StepperItem
                    key={stage.id}
                    step={stageNumber}
                    className="relative flex-1 items-start"
                    disabled={!canNavigateToStage(stageNumber)}
                  >
                    <StepperTrigger className="flex flex-col items-start justify-center gap-2 sm:gap-3.5 grow">
                      <div className="flex flex-col items-start gap-1">
                        <StepperTitle className="text-start text-xs sm:text-sm font-semibold group-data-[state=inactive]/step:text-muted-foreground">
                          <span className="md:hidden">{stage.shortTitle}</span>
                          <span className="hidden md:inline">{stage.title}</span>
                        </StepperTitle>
                      </div>
                      <StepperIndicator className="bg-border rounded-full h-1 w-full data-[state=active]:bg-secondary/80 data-[state=completed]:bg-secondary/50" />
                    </StepperTrigger>
                  </StepperItem>
                );
              })}
            </StepperNav>

            <AnimateHeight>
              <StepperPanel step={currentStage} className="text-sm">
                <StepperContent value={1}>
                  <SelectAmountStage tokens={consolidatedTokens} onAmountsChange={setTokenAmounts} />
                  <div className="pt-3 sm:pt-4 flex gap-2">
                    <Button onClick={handleNext} disabled={!canNavigateToStage(2)} className="w-full">
                      Next
                    </Button>
                  </div>
                </StepperContent>

                <StepperContent value={2}>
                  <SelectDestinationStage
                    value={destination}
                    onChange={setDestination}
                    betaAccepted={railgunBetaAccepted}
                    onBetaAcceptedChange={setRailgunBetaAccepted}
                    accounts={accounts}
                    allowedChainIds={allowedChainIds}
                  />
                  <div className="pt-3 sm:pt-4 flex gap-2">
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
                      accounts={accounts}
                    />
                  )}
                </StepperContent>
              </StepperPanel>
            </AnimateHeight>
          </Stepper>
        )}
      </DialogContent>
    </Dialog>
  );
}
