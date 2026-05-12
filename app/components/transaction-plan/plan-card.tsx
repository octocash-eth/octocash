import { Check, Circle, ExternalLink, Fuel, Loader2, X } from "lucide-react";
import type { Address } from "viem";
import { formatUnits } from "viem";
import { AddressDisplayAvatar, AddressDisplayRoot, AddressDisplayText } from "~/components/address";
import { TokenDisplayAmount, TokenDisplayIcon, TokenDisplayRoot, TokenDisplaySymbol } from "~/components/token";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip";
import { usePrice } from "~/context/token-price-provider";
import { chains } from "~/data/supported-chains";
import { useAmountDelta } from "~/hooks/use-amount-delta";
import { consolidateTokenAmounts, formatUsd } from "~/lib/tokens";
import type { StepGasEstimate, StepResult, TransactionStep } from "~/lib/types";
import { cn } from "~/lib/utils";
import { ChainIcon } from "../chain/chain-icon";

interface PlanCardProps {
  step: TransactionStep;
  stepNumber: number;
  result?: StepResult;
}

function getExplorerUrl(chainId: number, txHash: string): string {
  const chain = chains[chainId as keyof typeof chains];
  if (!chain?.blockExplorers?.default?.url) return "#";
  return `${chain.blockExplorers.default.url}/tx/${txHash}`;
}

/**
 * Inline badge that briefly shows the percentage change in a swap step's
 * output amount whenever it gets re-quoted. Renders only while the delta is
 * active (~1s), fading in/out via the `swap-delta-fade` animation. Threshold
 * is 0.5% to avoid flicker from sub-percent Odos jitter.
 */
function SwapOutputDelta({ amount }: { amount: bigint }) {
  const delta = useAmountDelta(amount);
  if (!delta) return null;

  return (
    <span
      aria-live="polite"
      className={cn(
        "inline-flex items-center text-xs font-medium ml-0.5 animate-in fade-in zoom-in-95 duration-200",
        delta.sign === "up" ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400",
      )}
    >
      ({delta.sign === "up" ? "▲" : "▼"} {delta.percent.toFixed(1)}%)
    </span>
  );
}

function ChainIconInline({ chainId }: { chainId: number }) {
  const chainName = chains[chainId as keyof typeof chains]?.name || `Chain ${chainId}`;
  return <ChainIcon chain={chainName} className="size-4 inline-block" />;
}

function ChainBadge({ chainId, name }: { chainId: number; name: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <ChainIconInline chainId={chainId} /> {name}
    </span>
  );
}

function AddressInline({ address }: { address: string }) {
  return (
    <AddressDisplayRoot address={address} className="inline-flex gap-1">
      <AddressDisplayAvatar className="size-3 sm:size-4" title={`Wallet: ${address}`} />
      <AddressDisplayText />
    </AddressDisplayRoot>
  );
}

/**
 * Renders a token icon + amount + symbol, with the USD-equivalent tooltip
 * driven by the live Odos price from {@link usePrice}. This used to be a
 * plain helper that received `unitaryPrice` from the step's TokenAmount, but
 * that was Zerion's price; we now ignore it entirely.
 */
function TokenAmountInline({
  amount,
  chainId,
  tokenAddress,
  symbol,
}: {
  amount: bigint;
  chainId: number;
  tokenAddress: Address;
  symbol: string;
}) {
  const { price } = usePrice(chainId, tokenAddress);
  return (
    <TokenDisplayRoot tokenAddress={tokenAddress} chainId={chainId} symbol={symbol} className="inline-flex gap-1">
      <span className="inline-flex items-center gap-1">
        <TokenDisplayIcon className="size-4 inline-block" />
        <TokenDisplayAmount amount={amount} unitaryPrice={price} />
        <TokenDisplaySymbol />
      </span>
    </TokenDisplayRoot>
  );
}

function ActionContent({ step, result }: { step: TransactionStep; result?: StepResult }) {
  const chainName = chains[step.chainId as keyof typeof chains]?.name || `Chain ${step.chainId}`;
  const isPast = step.status === "success";
  const isExecuting = step.status === "executing";

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
                <TokenAmountInline
                  amount={token.amount}
                  chainId={token.chainId}
                  tokenAddress={token.token}
                  symbol={token.symbol}
                />
              </span>
            );
          })}{" "}
          <span className="text-muted-foreground">→</span>{" "}
          <TokenAmountInline
            amount={outputToken.amount}
            chainId={outputToken.chainId}
            tokenAddress={outputToken.token}
            symbol={outputToken.symbol}
          />{" "}
          <SwapOutputDelta amount={outputToken.amount} />
          <span className="text-muted-foreground">on</span> <ChainBadge chainId={step.chainId} name={chainName} />{" "}
          <span className="text-xs text-muted-foreground/80 inline-flex items-center gap-1">
            (
            {inputWallets.map((wallet) => (
              <span key={wallet}>
                {inputWallets.indexOf(wallet) > 0 && ","}
                <AddressInline address={wallet} />
              </span>
            ))}
            {!inputWallets.includes(outputToken.walletAddress) && (
              <>
                {" → "}
                <AddressInline address={outputToken.walletAddress} />
              </>
            )}
            )
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
          <TokenAmountInline
            amount={totalAmount}
            chainId={inputToken.chainId}
            tokenAddress={inputToken.token}
            symbol={inputToken.symbol}
          />{" "}
          <span className="text-muted-foreground">from</span> <ChainBadge chainId={step.chainId} name={chainName} />{" "}
          <span className="text-muted-foreground">to</span> <ChainBadge chainId={destChainId} name={destChain} />{" "}
          <span className="text-xs text-muted-foreground/80 inline-flex items-center gap-1">
            (<AddressInline address={inputToken.walletAddress} />
            {inputToken.walletAddress !== step.outputToken.walletAddress && (
              <>
                {" → "}
                <AddressInline address={step.outputToken.walletAddress} />
              </>
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
          <span className="text-muted-foreground">on</span> <ChainBadge chainId={step.chainId} name={chainName} />
        </>
      );
    case "claim": {
      const outputToken = result?.actualOutput ?? step.outputToken;
      return (
        <>
          <span className="text-foreground">{isPast ? "Claimed" : isExecuting ? "Claiming" : "Claim"}</span>{" "}
          <TokenAmountInline
            amount={outputToken.amount}
            chainId={outputToken.chainId}
            tokenAddress={outputToken.token}
            symbol={outputToken.symbol}
          />{" "}
          <span className="text-muted-foreground">on</span> <ChainBadge chainId={step.chainId} name={chainName} />{" "}
          <span className="text-xs text-muted-foreground/80 inline-flex items-center gap-1">
            (<AddressInline address={outputToken.walletAddress} />)
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
          <TokenAmountInline
            amount={totalAmount}
            chainId={inputToken.chainId}
            tokenAddress={inputToken.token}
            symbol={inputToken.symbol}
          />{" "}
          <span className="text-muted-foreground">on</span> <ChainBadge chainId={step.chainId} name={chainName} />{" "}
          <span className="text-xs text-muted-foreground/80 inline-flex items-center gap-1">
            (<AddressInline address={inputToken.walletAddress} /> →{" "}
            <AddressInline address={outputToken.walletAddress} />)
          </span>
        </>
      );
    }
    default:
      return (
        <>
          <span className="text-foreground">Transaction</span> <span className="text-muted-foreground">on</span>{" "}
          <ChainBadge chainId={step.chainId} name={chainName} />
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

export function PlanCard({ step, result, stepNumber }: PlanCardProps) {
  const isPending = step.status === "pending";
  const isExecuting = step.status === "executing";
  const isSuccess = step.status === "success";
  const isFailed = step.status === "failed";

  return (
    <div className="flex items-center justify-between py-2 px-3 rounded transition-colors hover:bg-muted/60 dark:hover:bg-muted/30">
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
          <ActionContent step={step} result={result} />
        </div>
      </div>

      {/* Right side: Gas cost + Transaction link or status */}
      <div className="flex items-center gap-2 shrink-0 ml-4">
        {step.estimatedGas && <GasCostTooltip gas={step.estimatedGas} />}
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
  );
}
