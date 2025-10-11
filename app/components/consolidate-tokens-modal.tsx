import * as React from "react";
import { useId } from "react";
import { getAddress, isAddress, parseUnits } from "viem";
import { useAccount, useWalletClient } from "wagmi";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "~/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import type { WalletData } from "~/components/wallet-table/columns";
import { supportedChains } from "~/data/supported-chains";
import { USDC } from "~/data/token-contracts";
import type { ConsolidationState, DestinationToken, SourceToken } from "~/lib/types";
import AddressAvatar from "./address-avatar";
import { Combobox } from "./combobox";
import { formatTokenValue, parseTokenValue, TokenSelector } from "./token-selector";
import { TransactionPlanExecutor } from "./transaction-plan";

interface ConsolidateTokensModalProps {
  walletData: WalletData[];
  rowSelection?: Record<string, boolean>;
  selectedRows?: number;
  consolidateAmounts?: Record<string, string>;
  totalValueToConsolidate?: number;
}

export function ConsolidateTokensModal({
  walletData,
  rowSelection = {},
  selectedRows = 0,
  consolidateAmounts = {},
  totalValueToConsolidate = 0,
}: ConsolidateTokensModalProps) {
  const [destinationWallet, setDestinationWallet] = React.useState("");
  const [destinationChain, setDestinationChain] = React.useState("");
  const [estimatedAmount, setEstimatedAmount] = React.useState(0);
  const [destinationTokenAddr, setDestinationTokenAddr] = React.useState("");
  const [open, setOpen] = React.useState(false);
  const [showPlan, setShowPlan] = React.useState(false);
  const [planId, setPlanId] = React.useState("");
  const _destinationChainId = useId();

  const consolidatedTokens = React.useMemo(() => {
    return Object.entries(rowSelection)
      .filter(([rowId, isSelected]) => isSelected && walletData[parseInt(rowId, 10)])
      .map(([rowId, _isSelected]) => {
        const token = walletData[parseInt(rowId, 10)];
        const amountToConsolidate = consolidateAmounts[rowId] || token.amount;
        return { ...token, amountToConsolidate };
      });
  }, [rowSelection, walletData, consolidateAmounts]);

  const { data: walletClient } = useWalletClient();
  const { addresses } = useAccount();

  // Available chains for destination
  const availableChains = supportedChains.map((chain) => ({
    name: chain.name,
    chainId: chain.id,
  }));

  const destinationChainId = Number(
    availableChains.find((chain) => chain.chainId === Number(destinationChain))?.chainId,
  );

  const addressOptions = React.useMemo(
    () => (addresses ?? []).map((address) => ({ value: address, label: address })),
    [addresses],
  );

  // Derive sourceTokens from consolidatedTokens and other state
  const sourceTokens = React.useMemo<SourceToken[]>(() => {
    if (!showPlan) return [];

    return consolidatedTokens.map((token) => ({
      amount: parseUnits(token.amountToConsolidate, token.decimals),
      chainId: Number(availableChains.find((chain) => chain.name === token.chain)?.chainId),
      token: token.tokenAddress,
      walletAddress: token.wallet,
      symbol: token.token,
      decimals: token.decimals,
    }));
  }, [showPlan, consolidatedTokens, availableChains]);

  // Derive destinationToken from form state
  const destinationToken = React.useMemo<DestinationToken | null>(() => {
    if (!showPlan || !isAddress(destinationWallet) || !addresses) return null;

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
  }, [showPlan, destinationWallet, destinationTokenAddr, addresses]);

  // Calculate estimated USDC amount (with a 0.5% fee)
  React.useEffect(() => {
    const fee = 0.005; // 0.5%
    const estimatedWithFee = totalValueToConsolidate * (1 - fee);
    setEstimatedAmount(estimatedWithFee);
  }, [totalValueToConsolidate]);

  React.useEffect(() => {
    if (destinationChainId) {
      const usdcAddress = USDC[destinationChainId as keyof typeof USDC];
      setDestinationTokenAddr(formatTokenValue(destinationChainId, usdcAddress, 6, "USDC"));
    }
  }, [destinationChainId]);

  // Reset showPlan when modal is closed
  React.useEffect(() => {
    setShowPlan(false);
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    if (!walletClient || !addresses) {
      console.error("Wallet not connected");
      return;
    }

    if (!isAddress(destinationWallet)) {
      console.error("Invalid destination wallet address");
      return;
    }

    const tokenInfo = parseTokenValue(destinationTokenAddr);

    if (!tokenInfo) {
      console.error("Invalid destination token selected");
      return;
    }

    // Generate a unique plan ID upfront
    const newPlanId = `consolidation-${Date.now()}`;
    setPlanId(newPlanId);
    setShowPlan(true);
  };

  const handleComplete = React.useCallback((completedState: ConsolidationState) => {
    console.log("[Modal] handleComplete called with status:", completedState.status);
    // Close modal on successful completion after a delay
    if (completedState.status === "completed") {
      setTimeout(() => {
        setOpen(false);
        setShowPlan(false);
      }, 2000); // Give user time to see success
    }
  }, []);

  const handleBack = React.useCallback(() => {
    setShowPlan(false);
  }, []);

  // Put in suspicious components
  React.useEffect(() => {
    console.log("MOUNT", "ConsolidateTokensModal");
    return () => console.log("UNMOUNT", "ConsolidateTokensModal");
  }, []);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          size="lg"
          className={`text-lg font-semibold py-6 px-8 transition-all duration-200 ${selectedRows > 0 ? "min-w-[240px]" : ""}`}
          disabled={selectedRows === 0}
        >
          {selectedRows === 0 ? (
            "Consolidate Tokens"
          ) : (
            <>
              Consolidate{" "}
              <span className="font-bold text-white">
                {totalValueToConsolidate.toLocaleString("en-US", {
                  style: "currency",
                  currency: "USD",
                  minimumFractionDigits: 0,
                  maximumFractionDigits: 0,
                })}
              </span>
            </>
          )}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-5xl">
        <DialogHeader className="pb-4">
          <DialogTitle className="text-xl">
            {showPlan ? "Review Consolidation Plan" : "Consolidate"}{" "}
            {totalValueToConsolidate.toLocaleString("en-US", {
              style: "currency",
              currency: "USD",
              minimumFractionDigits: 0,
              maximumFractionDigits: 0,
            })}
          </DialogTitle>
          <DialogDescription>
            {showPlan
              ? "Review the transaction steps before confirming"
              : `Convert ${selectedRows} selected token${selectedRows !== 1 ? "s" : ""} to USDC and send to a destination wallet.`}
          </DialogDescription>
        </DialogHeader>

        {!showPlan && (
          <form onSubmit={handleSubmit} className="space-y-5">
            {/* Token summary */}
            <div className="space-y-2 mb-2 bg-muted/50 p-3 rounded-md">
              <h4 className="text-sm font-medium mb-2">Tokens to consolidate:</h4>
              <div className="max-h-32 overflow-y-auto space-y-2">
                {Object.entries(rowSelection)
                  .filter(([rowId, isSelected]) => isSelected && walletData[parseInt(rowId, 10)])
                  .map(([rowId, _isSelected]) => {
                    const token = walletData[parseInt(rowId, 10)];
                    const amountToConsolidate = consolidateAmounts[rowId] || token.amount;
                    const proportion = Number(amountToConsolidate) / Number(token.amount);
                    const valueToConsolidate = token.amountInUsd * proportion;
                    const percentageConsolidateed = Math.round(proportion * 100);

                    return (
                      <div key={rowId} className="flex justify-between text-xs">
                        <div className="flex flex-col">
                          <span>
                            {Number(amountToConsolidate).toLocaleString(undefined, {
                              minimumFractionDigits: 2,
                              maximumFractionDigits: 6,
                            })}{" "}
                            {token.token} ({token.chain})
                          </span>
                          {percentageConsolidateed < 100 && (
                            <span className="text-xs text-muted-foreground">
                              {percentageConsolidateed}% of total balance
                            </span>
                          )}
                        </div>
                        <span className="font-medium">
                          {valueToConsolidate.toLocaleString("en-US", {
                            style: "currency",
                            currency: "USD",
                            minimumFractionDigits: 2,
                            maximumFractionDigits: 2,
                          })}
                        </span>
                      </div>
                    );
                  })}
              </div>
            </div>

            <div className="space-y-2">
              <label htmlFor="destination-wallet" className="text-sm font-medium">
                Destination Wallet
              </label>
              <Combobox
                labelFunction={(address: string) => (
                  <div className="flex items-center gap-2">
                    <AddressAvatar addressOrEns={address} size={16} />
                    {address}
                  </div>
                )}
                placeholder="0x..."
                searchPlaceholder="Select or paste an address"
                options={addressOptions}
                value={destinationWallet}
                onValueChange={setDestinationWallet}
                isValidOption={(value) => [isAddress(value), `"${value}" is not an Ethereum address`]}
              />
            </div>

            <div className="space-y-2">
              <label htmlFor="destination-chain" className="text-sm font-medium">
                Destination Chain
              </label>
              <Select value={destinationChain} onValueChange={setDestinationChain} required>
                <SelectTrigger id={_destinationChainId} className="w-full">
                  <SelectValue placeholder="Select chain" />
                </SelectTrigger>
                <SelectContent>
                  {availableChains.map((chain) => (
                    <SelectItem key={chain.chainId} value={chain.chainId.toString()}>
                      <div className="flex items-center gap-2">
                        <img
                          src={`/chain-icons/${chain.name.toLowerCase().replace(/\s+/g, "-")}.svg`}
                          alt={`${chain.name} icon`}
                          className="w-4 h-4 rounded-full"
                        />
                        {chain.name}
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <label htmlFor="destination-token" className="text-sm font-medium">
                Destination Token
              </label>
              <TokenSelector
                chainId={destinationChainId}
                value={destinationTokenAddr}
                onChange={setDestinationTokenAddr}
                disabled={!destinationChainId}
              />
            </div>

            <div className="space-y-2 pt-3 border-t">
              <div className="flex justify-between mt-3">
                <span className="text-sm font-medium">Estimated USDC</span>
                <span className="text-sm font-semibold text-green-600">
                  {estimatedAmount.toLocaleString("en-US", {
                    style: "currency",
                    currency: "USD",
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}
                </span>
              </div>
              <div className="text-xs text-muted-foreground">Includes a 0.5% conversion fee</div>
            </div>

            <DialogFooter className="pt-4 flex flex-col gap-2">
              <Button type="submit" className="w-full py-5 text-base">
                Generate Plan
              </Button>
            </DialogFooter>
          </form>
        )}

        {showPlan && planId && destinationToken && (
          <TransactionPlanExecutor
            key={planId}
            planId={planId}
            sourceTokens={sourceTokens}
            destinationToken={destinationToken}
            onComplete={handleComplete}
            onBack={handleBack}
            showActions={true}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
