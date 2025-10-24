import * as React from "react";
import { getAddress, isAddress, parseUnits } from "viem";
import { useAccount } from "wagmi";
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
import type { WalletData } from "~/components/wallet-table/columns";
import { supportedChains } from "~/data/supported-chains";
import { USDC } from "~/data/token-contracts";
import type { ConsolidationState, DestinationToken, SourceToken } from "~/lib/types";
import { ConfirmPlanStage } from "./consolidation-stages/confirm-plan-stage";
import { SelectAmountStage } from "./consolidation-stages/select-amount-stage";
import { SelectDestinationStage } from "./consolidation-stages/select-destination-stage";
import { formatTokenValue, parseTokenValue } from "./token-selector";

interface ConsolidateTokensModalProps {
  walletData: WalletData[];
  rowSelection?: Record<string, boolean>;
  selectedRows?: number;
}

export function ConsolidateTokensModal({
  walletData,
  rowSelection = {},
  selectedRows = 0,
}: ConsolidateTokensModalProps) {
  const [destinationWallet, setDestinationWallet] = React.useState("");
  const [destinationChain, setDestinationChain] = React.useState("");
  const [destinationTokenAddr, setDestinationTokenAddr] = React.useState("");
  const [open, setOpen] = React.useState(false);
  const [currentStage, setCurrentStage] = React.useState(1);
  const [planId, setPlanId] = React.useState("");
  const [tokenAmounts, setTokenAmounts] = React.useState<Record<string, string>>({});

  const consolidatedTokens = React.useMemo(() => {
    return Object.entries(rowSelection)
      .filter(([rowId, isSelected]) => isSelected && walletData[parseInt(rowId, 10)])
      .map(([rowId, _isSelected]) => {
        const token = walletData[parseInt(rowId, 10)];
        const amount = tokenAmounts[token.id] || token.amount;
        return { ...token, amountToConsolidate: amount };
      });
  }, [rowSelection, walletData, tokenAmounts]);

  const { addresses } = useAccount();

  const addressOptions = React.useMemo(
    () => (addresses ?? []).map((address) => ({ value: address, label: address })),
    [addresses],
  );

  const destinationChainId = Number(destinationChain);

  // Derive sourceTokens from consolidatedTokens and other state
  const sourceTokens = React.useMemo<SourceToken[]>(() => {
    if (currentStage !== 3) return [];

    return consolidatedTokens
      .filter((token) => Number.parseFloat(token.amountToConsolidate) > 0)
      .map((token) => {
        const chainInfo = supportedChains.find((chain) => chain.name === token.chain);
        return {
          amount: parseUnits(token.amountToConsolidate, token.decimals),
          chainId: chainInfo?.id || 0,
          token: token.tokenAddress,
          walletAddress: token.wallet,
          symbol: token.token,
          decimals: token.decimals,
        };
      });
  }, [currentStage, consolidatedTokens]);

  // Derive destinationToken from form state
  const destinationToken = React.useMemo<DestinationToken | null>(() => {
    if (currentStage !== 3 || !isAddress(destinationWallet) || !addresses) return null;

    const sendTo = getAddress(destinationWallet);
    const intermediateWallet = addresses.includes(sendTo) ? sendTo : addresses[0];
    const tokenInfo = parseTokenValue(destinationTokenAddr);

    if (!tokenInfo) return null;

    return {
      token: getAddress(tokenInfo.address),
      chainId: tokenInfo.chainId,
      walletAddress: intermediateWallet,
      symbol: tokenInfo.symbol,
      decimals: tokenInfo.decimals,
    };
  }, [currentStage, destinationWallet, destinationTokenAddr, addresses]);

  // Calculate actual total value based on selected amounts
  const actualTotalToConsolidate = React.useMemo(() => {
    return consolidatedTokens.reduce((total, token) => {
      const amountToConsolidate = Number.parseFloat(token.amountToConsolidate);
      const fullAmount = Number.parseFloat(token.amount);
      const ratio = fullAmount > 0 ? amountToConsolidate / fullAmount : 0;
      return total + token.amountInUsd * ratio;
    }, 0);
  }, [consolidatedTokens]);

  React.useEffect(() => {
    if (destinationChainId) {
      const usdcAddress = USDC[destinationChainId as keyof typeof USDC];
      if (usdcAddress) {
        setDestinationTokenAddr(formatTokenValue(destinationChainId, usdcAddress, 6, "USDC"));
      }
    }
  }, [destinationChainId]);

  // Reset stage when modal is closed
  React.useEffect(() => {
    if (!open) {
      setCurrentStage(1);
    }
  }, [open]);

  // Track previous stage to detect stage transitions
  const prevStageRef = React.useRef(currentStage);

  // Generate new planId when transitioning to stage 3 from any other stage
  // This ensures the plan is regenerated whenever the user navigates to stage 3
  React.useEffect(() => {
    const prevStage = prevStageRef.current;
    prevStageRef.current = currentStage;

    if (currentStage === 3 && prevStage !== 3) {
      const newPlanId = `consolidation-${Date.now()}`;
      setPlanId(newPlanId);
    }
  }, [currentStage]);

  // Validation function for navigation
  const canNavigateToStage = React.useCallback(
    (stageNumber: number) => {
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
          isAddress(destinationWallet) && destinationChain !== "" && destinationTokenAddr !== "";
        if (!hasValidDestination) return false;
      }

      return true;
    },
    [currentStage, consolidatedTokens, destinationWallet, destinationChain, destinationTokenAddr],
  );

  const handleNext = React.useCallback(() => {
    if (currentStage === 3) return;

    if (canNavigateToStage(currentStage + 1)) {
      setCurrentStage((prev) => prev + 1);
    }
  }, [currentStage, canNavigateToStage]);

  const handleBack = React.useCallback(() => {
    if (currentStage > 1) {
      setCurrentStage((prev) => prev - 1);
    }
  }, [currentStage]);

  const handleComplete = React.useCallback((completedState: ConsolidationState) => {
    console.log("[Modal] handleComplete called with status:", completedState.status);
    // Close modal on successful completion after a delay
    if (completedState.status === "completed") {
      setTimeout(() => {
        setOpen(false);
      }, 2000); // Give user time to see success
    }
  }, []);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          size="lg"
          className={`text-lg font-semibold py-6 px-8 transition-all duration-200 ${selectedRows > 0 ? "min-w-[240px]" : ""}`}
          disabled={selectedRows === 0}
        >
          {selectedRows === 0 ? "Consolidate Tokens" : <>Consolidate tokens</>}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-5xl">
        <DialogHeader className="pb-4">
          <DialogTitle className="text-xl">
            Consolidate{" "}
            {actualTotalToConsolidate.toLocaleString("en-US", {
              style: "currency",
              currency: "USD",
              minimumFractionDigits: 0,
              maximumFractionDigits: 0,
            })}
          </DialogTitle>
          <DialogDescription>
            {currentStage === 1 && `Adjust amounts for ${selectedRows} selected token${selectedRows !== 1 ? "s" : ""}.`}
            {currentStage === 2 && "Select the destination wallet, chain, and token."}
            {currentStage === 3 && "Review and execute the consolidation plan."}
          </DialogDescription>
        </DialogHeader>

        <Stepper value={currentStage} onValueChange={setCurrentStage} className="space-y-6">
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
                    <StepperIndicator className="bg-border rounded-full h-1 w-full data-[state=active]:bg-primary data-[state=completed]:bg-primary" />
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
              <SelectDestinationStage
                destinationWallet={destinationWallet}
                setDestinationWallet={setDestinationWallet}
                destinationChain={destinationChain}
                setDestinationChain={setDestinationChain}
                destinationTokenAddr={destinationTokenAddr}
                setDestinationTokenAddr={setDestinationTokenAddr}
                addressOptions={addressOptions}
              />
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
                />
              )}
            </StepperContent>
          </StepperPanel>
        </Stepper>
      </DialogContent>
    </Dialog>
  );
}
