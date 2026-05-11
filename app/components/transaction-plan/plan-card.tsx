import { Check, Circle, ExternalLink, Fuel, Loader2, RefreshCw, RotateCw, X } from "lucide-react";
import { formatUnits } from "viem";
import { AddressDisplayAvatar, AddressDisplayRoot, AddressDisplayText } from "~/components/address";
import { TokenDisplayAmount, TokenDisplayIcon, TokenDisplayRoot, TokenDisplaySymbol } from "~/components/token";
import { Button } from "~/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip";
import { chains } from "~/data/supported-chains";
import type { StallKind } from "~/lib/send-calls";
import { consolidateTokenAmounts, formatUsd } from "~/lib/tokens";
import type { StepGasEstimate, StepResult, TransactionStep } from "~/lib/types";
import { ChainIcon } from "../chain/chain-icon";

interface PlanCardProps {
  step: TransactionStep;
  stepNumber: number;
  result?: StepResult;
  /**
   * When set, the step is currently stalled and the executor reported a
   * recovery action. The action's nature ({@link StallKind}) determines
   * the CTA's label / icon / tooltip; clicking it calls `onStallAction`.
   *
   * Both props move together: the parent only sets them when both are
   * known. They are never undefined for non-executing steps.
   */
  stallKind?: StallKind;
  onStallAction?: () => void;
}

function getExplorerUrl(chainId: number, txHash: string): string {
  const chain = chains[chainId as keyof typeof chains];
  if (!chain?.blockExplorers?.default?.url) return "#";
  return `${chain.blockExplorers.default.url}/tx/${txHash}`;
}

function getActionContent(step: TransactionStep, result?: StepResult): React.ReactNode {
  const chainName = chains[step.chainId as keyof typeof chains]?.name || `Chain ${step.chainId}`;
  const isPast = step.status === "success";
  const isExecuting = step.status === "executing";

  const chainIcon = (chainId: number) => {
    const chainName = chains[chainId as keyof typeof chains]?.name || `Chain ${chainId}`;
    return <ChainIcon chain={chainName} className="size-4 inline-block" />;
  };

  const addressDisplay = (address: string) => (
    <AddressDisplayRoot address={address} className="inline-flex gap-1">
      <AddressDisplayAvatar className="size-3 sm:size-4" title={`Wallet: ${address}`} />
      <AddressDisplayText />
    </AddressDisplayRoot>
  );

  // Group token icon + amount + symbol together with TokenDisplay
  const tokenAmount = (
    amount: bigint,
    chainId: number,
    tokenAddress: string,
    symbol: string,
    unitaryPrice?: number,
  ) => (
    <TokenDisplayRoot tokenAddress={tokenAddress} chainId={chainId} symbol={symbol} className="inline-flex gap-1">
      <span className="inline-flex items-center gap-1">
        <TokenDisplayIcon className="size-4 inline-block" />
        <TokenDisplayAmount amount={amount} unitaryPrice={unitaryPrice} />
        <TokenDisplaySymbol />
      </span>
    </TokenDisplayRoot>
  );

  // Group chain icon + name together
  const chainBadge = (chainId: number, name: string) => (
    <span className="inline-flex items-center gap-1">
      {chainIcon(chainId)} {name}
    </span>
  );

  switch (step.type) {
    case "swap": {
      const outputToken = result?.actualOutput ?? step.outputToken;
      const inputWallets = [...new Set(step.inputTokens.map((t) => t.walletAddress))];

      // Consolidate input tokens by token address to avoid showing duplicates
      const consolidatedInputs = consolidateTokenAmounts(step.inputTokens);

      return (
        <>
          <span className="text-foreground">{isPast ? "Swapped" : isExecuting ? "Swapping" : "Swap"}</span>{" "}
          {consolidatedInputs.map((token, index) => {
            const key = `${token.token}`;
            return (
              <span key={key}>
                {index > 0 && <span className="text-muted-foreground"> + </span>}
                {tokenAmount(token.amount, token.chainId, token.token, token.symbol, token.unitaryPrice)}
              </span>
            );
          })}{" "}
          <span className="text-muted-foreground">→</span>{" "}
          {tokenAmount(
            outputToken.amount,
            outputToken.chainId,
            outputToken.token,
            outputToken.symbol,
            outputToken.unitaryPrice,
          )}{" "}
          <span className="text-muted-foreground">on</span> {chainBadge(step.chainId, chainName)}{" "}
          <span className="text-xs text-muted-foreground/80 inline-flex items-center gap-1">
            (
            {inputWallets.map((wallet) => (
              <span key={wallet}>
                {inputWallets.indexOf(wallet) > 0 && ","}
                {addressDisplay(wallet)}
              </span>
            ))}
            {!inputWallets.includes(outputToken.walletAddress) && <> → {addressDisplay(outputToken.walletAddress)}</>})
          </span>
        </>
      );
    }
    case "bridge": {
      const inputToken = step.inputTokens[0];
      const destChain = step.outputToken.chainId
        ? chains[step.outputToken.chainId as keyof typeof chains]?.name || `Chain ${step.outputToken.chainId}`
        : chainName;
      const destChainId = step.outputToken.chainId || step.chainId;
      // Display aggregated amount for bridge (can have multiple USDC inputs: swap outputs + existing)
      const totalAmount = step.inputTokens.reduce((sum, t) => sum + t.amount, 0n);
      return (
        <>
          <span className="text-foreground">{isPast ? "Bridged" : isExecuting ? "Bridging" : "Bridge"}</span>{" "}
          {tokenAmount(totalAmount, inputToken.chainId, inputToken.token, inputToken.symbol, inputToken.unitaryPrice)}{" "}
          <span className="text-muted-foreground">from</span> {chainBadge(step.chainId, chainName)}{" "}
          <span className="text-muted-foreground">to</span> {chainBadge(destChainId, destChain)}{" "}
          <span className="text-xs text-muted-foreground/80 inline-flex items-center gap-1">
            ({addressDisplay(inputToken.walletAddress)}
            {inputToken.walletAddress !== step.outputToken.walletAddress && (
              <> → {addressDisplay(step.outputToken.walletAddress)}</>
            )}
            )
          </span>
        </>
      );
    }
    case "attestation":
      return (
        <>
          <span className="text-foreground">
            {isPast ? "Waited for" : isExecuting ? "Waiting for" : "Wait for"} attestation
          </span>{" "}
          <span className="text-muted-foreground">on</span> {chainBadge(step.chainId, chainName)}
        </>
      );
    case "claim": {
      const outputToken = result?.actualOutput ?? step.outputToken;
      return (
        <>
          <span className="text-foreground">{isPast ? "Claimed" : isExecuting ? "Claiming" : "Claim"}</span>{" "}
          {tokenAmount(
            outputToken.amount,
            outputToken.chainId,
            outputToken.token,
            outputToken.symbol,
            outputToken.unitaryPrice,
          )}{" "}
          <span className="text-muted-foreground">on</span> {chainBadge(step.chainId, chainName)}{" "}
          <span className="text-xs text-muted-foreground/80 inline-flex items-center gap-1">
            ({addressDisplay(outputToken.walletAddress)})
          </span>
        </>
      );
    }
    case "transfer": {
      const inputToken = step.inputTokens[0];
      const outputToken = step.outputToken;
      const totalAmount = step.inputTokens.reduce((sum, t) => sum + t.amount, 0n);
      return (
        <>
          <span className="text-foreground">{isPast ? "Transferred" : isExecuting ? "Transferring" : "Transfer"}</span>{" "}
          {tokenAmount(totalAmount, inputToken.chainId, inputToken.token, inputToken.symbol, inputToken.unitaryPrice)}{" "}
          <span className="text-muted-foreground">on</span> {chainBadge(step.chainId, chainName)}{" "}
          <span className="text-xs text-muted-foreground/80 inline-flex items-center gap-1">
            ({addressDisplay(inputToken.walletAddress)} → {addressDisplay(outputToken.walletAddress)})
          </span>
        </>
      );
    }
    default:
      return (
        <>
          <span className="text-foreground">Transaction</span> <span className="text-muted-foreground">on</span>{" "}
          {chainBadge(step.chainId, chainName)}
        </>
      );
  }
}

function GasCostTooltip({ gas }: { gas: StepGasEstimate }) {
  const nativeAmount = Number.parseFloat(formatUnits(gas.gasCostWei, 18));
  const gweiPrice = Number.parseFloat(formatUnits(gas.maxFeePerGas, 9));
  const hasUsd = gas.gasCostUsd > 0;

  const ariaLabel = hasUsd
    ? `Estimated gas: ${nativeAmount.toFixed(6)} ${gas.nativeSymbol} (~${formatUsd(gas.gasCostUsd)})`
    : `Estimated gas: ${nativeAmount.toFixed(6)} ${gas.nativeSymbol}`;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex items-center cursor-help" aria-label={ariaLabel} role="img">
          <Fuel className="w-3.5 h-3.5 text-muted-foreground" />
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="space-y-1">
        <div className="font-medium">
          ~{nativeAmount.toFixed(6)} {gas.nativeSymbol}
        </div>
        <div className="text-muted-foreground">{gweiPrice.toFixed(2)} gwei</div>
        {hasUsd && <div className="text-muted-foreground">~{formatUsd(gas.gasCostUsd)}</div>}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Per-{@link StallKind} CTA copy. Centralised so the wording for Resend vs
 * Retry stays consistent across the app and so tests can assert on the
 * text without hard-coding it in multiple places.
 */
const STALL_CTA_COPY: Record<StallKind, { label: string; ariaLabel: string; tooltip: string; icon: typeof RefreshCw }> =
  {
    resend: {
      label: "Resend",
      ariaLabel: "Resend transaction with bumped gas",
      tooltip: "Wallet hasn't broadcast yet — resend with the same nonce and bumped gas.",
      icon: RefreshCw,
    },
    retry: {
      label: "Retry",
      ariaLabel: "Retry transaction with refreshed calldata",
      tooltip: "Original would no longer succeed — re-quote and replace using the same nonce.",
      icon: RotateCw,
    },
  };

export function PlanCard({ step, result, stepNumber, stallKind, onStallAction }: PlanCardProps) {
  const isPending = step.status === "pending";
  const isExecuting = step.status === "executing";
  const isSuccess = step.status === "success";
  const isFailed = step.status === "failed";
  // Show the unified stall CTA only while the step is the active one. The
  // parent only sets `stallKind` + `onStallAction` when the executor reports
  // a stall for THIS step.
  const isStalled = isExecuting && stallKind !== undefined && onStallAction !== undefined;
  const stallCopy = stallKind ? STALL_CTA_COPY[stallKind] : null;

  // NOTE: the per-step in-flight hash audit trail (`step.pendingTx.hashes`)
  // is still recorded by `useConsolidationExecution` and persisted to
  // localStorage on every broadcast — we just don't surface it in the UI.
  // For multi-call steps (e.g. approval + swap, approval + bridge) every
  // sub-tx contributes a hash, which made the disclosure read like multiple
  // "attempts" of the same op even when nothing went wrong.

  return (
    <div className="flex flex-col py-2 px-3 rounded transition-colors hover:bg-muted/60 dark:hover:bg-muted/30">
      <div className="flex items-center justify-between">
        {/* Left side: Status icon + Action text */}
        <div className="flex gap-3 flex-1 min-w-0">
          {/* Status Icon or Step Number */}
          {isPending && stepNumber !== undefined ? (
            <div className="w-5 h-5 flex items-center justify-center shrink-0 bg-primary text-primary-foreground rounded-full">
              <span className="text-xs font-semibold">{stepNumber}</span>
            </div>
          ) : isPending ? (
            <Circle className="w-5 h-5 text-muted-foreground shrink-0" />
          ) : isExecuting ? (
            <Loader2 className="w-5 h-5 text-primary animate-spin shrink-0" />
          ) : isSuccess ? (
            <Check className="w-5 h-5 text-green-500 shrink-0" />
          ) : isFailed ? (
            <X className="w-5 h-5 text-red-500 shrink-0" />
          ) : null}

          {/* Action description */}
          <div className="text-sm text-foreground flex items-center gap-1.5 flex-wrap min-w-0">
            {getActionContent(step, result)}
          </div>
        </div>

        {/* Right side: Gas cost + Transaction link or status */}
        <div className="flex items-center gap-2 shrink-0 ml-4">
          {step.estimatedGas && <GasCostTooltip gas={step.estimatedGas} />}
          {isStalled && stallCopy && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={onStallAction}
                  aria-label={stallCopy.ariaLabel}
                  className="h-7 px-2 text-xs"
                >
                  <stallCopy.icon className="w-3 h-3 mr-1" />
                  {stallCopy.label}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="left" className="max-w-xs">
                {stallCopy.tooltip}
              </TooltipContent>
            </Tooltip>
          )}
          {isSuccess && result?.transactionHash && (
            <a
              href={getExplorerUrl(step.chainId, result.transactionHash)}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-sm text-primary hover:text-primary/80 hover:underline"
            >
              View tx
              <ExternalLink className="w-3 h-3" />
            </a>
          )}
          {isFailed && (
            <span
              className="text-sm font-medium text-destructive"
              title={step.error ? `${step.error.title}. ${step.error.message}` : undefined}
            >
              Failed
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
