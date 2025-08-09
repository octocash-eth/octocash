import { AlertCircle, CheckCircle2 } from "lucide-react";
import * as React from "react";
import type { Account, Chain, HttpTransport, WalletClient } from "viem";
import { getAddress, isAddress, parseUnits } from "viem";
import { useWalletClient } from "wagmi";
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
import { Input } from "~/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import type { WalletData } from "~/components/wallet-table/columns";
import { tokenAddresses } from "~/data/cctp-contracts";
import { supportedChains } from "~/data/supported-chains";
import { useConsolidate } from "~/hooks/use-consolidate";
import { ConsolidationStep, type TokenAmount } from "~/lib/consolidation";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";

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
  const [open, setOpen] = React.useState(false);

  const consolidatedTokens = React.useMemo(() => {
    return Object.entries(rowSelection)
      .filter(([rowId, isSelected]) => isSelected && walletData[parseInt(rowId)])
      .map(([rowId, _isSelected]) => {
        const token = walletData[parseInt(rowId)];
        const amountToConsolidate = consolidateAmounts[rowId] || token.amount;
        return { ...token, amountToConsolidate };
      });
  }, [rowSelection, walletData, consolidateAmounts]);

  const { executeConsolidation, currentStep, error } = useConsolidate();
  const { data: walletClient } = useWalletClient();

  // Calculate estimated USDC amount (with a 0.5% fee)
  React.useEffect(() => {
    const fee = 0.005; // 0.5%
    const estimatedWithFee = totalValueToConsolidate * (1 - fee);
    setEstimatedAmount(estimatedWithFee);
  }, [totalValueToConsolidate]);

  // Available chains for destination
  const availableChains = supportedChains.map((chain) => ({
    name: chain.name,
    chainId: chain.id,
  }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!walletClient) {
      console.error("Wallet not connected");
      return;
    }

    if (!isAddress(destinationWallet)) {
      console.error("Invalid destination wallet address");
      return;
    }

    const sourceTokens = consolidatedTokens.map((token) => ({
      amount: parseUnits(token.amountToConsolidate, token.decimals),
      chainId: Number(availableChains.find((chain) => chain.name === token.chain)?.chainId),
      token: token.tokenAddress,
      walletAddress: token.wallet,
    }));

    const destinationChainId = Number(
      availableChains.find((chain) => chain.chainId === Number(destinationChain))?.chainId,
    );
    const destinationToken: TokenAmount = {
      amount: 0n,
      chainId: destinationChainId,
      token: tokenAddresses[destinationChainId as keyof typeof tokenAddresses],
      walletAddress: getAddress(destinationWallet),
    };

    try {
      await executeConsolidation(
        sourceTokens,
        destinationToken,
        walletClient as WalletClient<HttpTransport, Chain, Account>,
      );
      setOpen(false);
    } catch (error) {
      console.error("Failed to execute transfers:", error);
    }
  };

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
      <DialogContent className="sm:max-w-md">
        <DialogHeader className="pb-4">
          <DialogTitle className="text-xl">
            Consolidate{" "}
            {totalValueToConsolidate.toLocaleString("en-US", {
              style: "currency",
              currency: "USD",
              minimumFractionDigits: 0,
              maximumFractionDigits: 0,
            })}
          </DialogTitle>
          <DialogDescription>
            Convert {selectedRows} selected token{selectedRows !== 1 ? "s" : ""} to USDC and send to a destination
            wallet.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-5">
          {/* Token summary */}
          <div className="space-y-2 mb-2 bg-muted/50 p-3 rounded-md">
            <h4 className="text-sm font-medium mb-2">Tokens to consolidate:</h4>
            <div className="max-h-32 overflow-y-auto space-y-2">
              {Object.entries(rowSelection)
                .filter(([rowId, isSelected]) => isSelected && walletData[parseInt(rowId)])
                .map(([rowId, _isSelected]) => {
                  const token = walletData[parseInt(rowId)];
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
            <Input
              id="destination-wallet"
              placeholder="0x…"
              value={destinationWallet}
              onChange={(e) => setDestinationWallet(e.target.value)}
              required
            />
          </div>

          <div className="space-y-2">
            <label htmlFor="destination-token" className="text-sm font-medium">
              Destination Token
            </label>
            <Input id="destination-token" value="USDC" disabled className="bg-muted" />
          </div>

          <div className="space-y-2">
            <label htmlFor="destination-chain" className="text-sm font-medium">
              Destination Chain
            </label>
            <Select value={destinationChain} onValueChange={setDestinationChain} required>
              <SelectTrigger id="destination-chain" className="w-full">
                <SelectValue placeholder="Select chain" />
              </SelectTrigger>
              <SelectContent>
                {availableChains.map((chain) => (
                  <SelectItem key={chain.chainId} value={chain.chainId.toString()}>
                    {chain.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
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
          {currentStep === ConsolidationStep.SWAPPING && (
            <Alert>
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>Step 1/5</AlertTitle>
              <AlertDescription>Swapping tokens…</AlertDescription>
            </Alert>
          )}
          {currentStep === ConsolidationStep.BURNING && (
            <Alert>
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>Step 2/5</AlertTitle>
              <AlertDescription>Bridging tokens…</AlertDescription>
            </Alert>
          )}
          {currentStep === ConsolidationStep.WAITING_ATTESTATION && (
            <Alert>
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>Step 3/5</AlertTitle>
              <AlertDescription>Waiting for attestation…</AlertDescription>
            </Alert>
          )}
          {currentStep === ConsolidationStep.MINTING && (
            <Alert>
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>Step 4/5</AlertTitle>
              <AlertDescription>Claiming tokens…</AlertDescription>
            </Alert>
          )}
          {currentStep === ConsolidationStep.SWAPPING_BACK && (
            <Alert>
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>Step 5/5</AlertTitle>
              <AlertDescription>Swapping tokens…</AlertDescription>
            </Alert>
          )}
          {currentStep === ConsolidationStep.COMPLETED && (
            <Alert>
              <CheckCircle2 className="h-4 w-4" />
              <AlertTitle>Success</AlertTitle>
              <AlertDescription>Tokens consolidated successfully</AlertDescription>
            </Alert>
          )}
          {currentStep === ConsolidationStep.ERROR && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>Error</AlertTitle>
              <AlertDescription>{error || "Error consolidating tokens"}</AlertDescription>
            </Alert>
          )}

          <DialogFooter className="pt-4 flex flex-col gap-2">
            <Button type="submit" className="w-full py-5 text-base">
              Consolidate
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
