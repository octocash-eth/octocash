import { Check, Circle, ExternalLink, Fuel, Loader2, X } from "lucide-react";
import type { Address } from "viem";
import { formatUnits } from "viem";
import { AddressDisplayAvatar, AddressDisplayRoot, AddressDisplayText } from "~/components/address";
import { TokenDisplayAmount, TokenDisplayIcon, TokenDisplayRoot, TokenDisplaySymbol } from "~/components/token";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip";
import { useFormatFiat } from "~/context/currency-provider";
import { usePrice } from "~/context/token-price-provider";
import { chains } from "~/data/supported-chains";
import { consolidateTokenAmounts } from "~/lib/tokens";
import type { StepGasEstimate, StepResult, TokenAmount, TransactionStep } from "~/lib/types";
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
 * Renders a token icon + amount + symbol + inline USD label, where the USD
 * value is driven by the live Odos price from {@link usePrice}. The amount
 * text gets re-keyed on every change so its `animate-in fade-in` entrance
 * animation reruns — a small one-shot blink that signals "this number just
 * moved" without committing to a direction or threshold.
 */
function TokenAmountInline({
  amount,
  chainId,
  tokenAddress,
  symbol,
  decimals,
}: {
  amount: bigint;
  chainId: number;
  tokenAddress: Address;
  symbol: string;
  decimals: number;
}) {
  const { price } = usePrice(chainId, tokenAddress);
  const formatFiat = useFormatFiat();

  const usdLabel = price !== undefined ? formatFiat(Number(formatUnits(amount, decimals)) * price) : null;

  return (
    <TokenDisplayRoot
      tokenAddress={tokenAddress}
      chainId={chainId}
      symbol={symbol}
      decimals={decimals}
      className="inline-flex gap-1"
    >
      <span className="inline-flex items-center gap-1">
        <TokenDisplayIcon className="size-4 inline-block" />
        <TokenDisplayAmount
          key={amount.toString()}
          amount={amount}
          unitaryPrice={price}
          className="animate-in fade-in duration-300"
        />
        <TokenDisplaySymbol />
        {usdLabel !== null && <span className="text-xs text-muted-foreground/80 tabular-nums">({usdLabel})</span>}
      </span>
    </TokenDisplayRoot>
  );
}

/**
 * Convenience wrapper so callers can pass a {@link TokenAmount}-shaped object
 * (which always carries `decimals`) instead of spelling each field out at
 * every call site.
 */
function TokenAmountInlineFor({ token, amount }: { token: TokenAmount; amount?: bigint }) {
  return (
    <TokenAmountInline
      amount={amount ?? token.amount}
      chainId={token.chainId}
      tokenAddress={token.token}
      symbol={token.symbol}
      decimals={token.decimals}
    />
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
                <TokenAmountInlineFor token={token} />
              </span>
            );
          })}{" "}
          <span className="text-muted-foreground">→</span> <TokenAmountInlineFor token={outputToken} />{" "}
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
          <TokenAmountInlineFor token={inputToken} amount={totalAmount} />{" "}
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
          <TokenAmountInlineFor token={outputToken} /> <span className="text-muted-foreground">on</span>{" "}
          <ChainBadge chainId={step.chainId} name={chainName} />{" "}
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
          <TokenAmountInlineFor token={inputToken} amount={totalAmount} />{" "}
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
  const formatFiat = useFormatFiat();
  const nativeAmount = Number.parseFloat(formatUnits(gas.gasCostWei, 18));
  const gweiPrice = Number.parseFloat(formatUnits(gas.maxFeePerGas, 9));
  const hasUsd = gas.gasCostUsd > 0;

  const ariaLabel = hasUsd
    ? `Estimated gas: ${nativeAmount.toFixed(6)} ${gas.nativeSymbol} (~${formatFiat(gas.gasCostUsd)})`
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
        {hasUsd && <div className="text-muted-foreground">~{formatFiat(gas.gasCostUsd)}</div>}
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
