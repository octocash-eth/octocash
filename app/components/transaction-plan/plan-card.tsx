import { Check, Circle, ExternalLink, Forward, Fuel, Loader2, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { Address } from "viem";
import { formatUnits, zeroAddress } from "viem";
import { AddressDisplayAvatar, AddressDisplayRoot, AddressDisplayText } from "~/components/address";
import { TokenDisplayAmount, TokenDisplayIcon, TokenDisplayRoot, TokenDisplaySymbol } from "~/components/token";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip";
import { useFormatFiat } from "~/context/currency-provider";
import { usePrice } from "~/context/token-price-provider";
import { safeAppQueueUrl } from "~/data/safe-contracts";
import { chains } from "~/data/supported-chains";
import type { StepLiveProgress } from "~/hooks/use-consolidation-execution";
import { consolidateTokenAmounts } from "~/lib/tokens";
import type { StepGasEstimate, StepResult, TokenAmount, TransactionStep } from "~/lib/types";
import { formatAddress } from "~/lib/utils";
import { ChainIcon } from "../chain/chain-icon";

interface PlanCardProps {
  step: TransactionStep;
  stepNumber: number;
  result?: StepResult;
  /** Transient, step-type-agnostic wait feedback for this step (display-only). */
  progress?: StepLiveProgress;
}

/** mm:ss elapsed since `startedAt`, ticking once a second. */
function ElapsedTimer({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);
  const total = Math.max(0, Math.floor((now - startedAt) / 1000));
  const mm = Math.floor(total / 60);
  const ss = String(total % 60).padStart(2, "0");
  return (
    <span className="tabular-nums">
      {mm}:{ss}
    </span>
  );
}

/**
 * Generic muted status, rendered inline next to the action text of any
 * executing wait step (gas-top-up bridge, CCTP attestation, …): the
 * hook-computed stage + live timer + optional note. Intentionally
 * step-type-agnostic — all stage/note copy is decided upstream (see
 * app/lib/step-progress.ts), so this stays a dumb renderer.
 */
function StepProgressLine({ progress }: { progress: StepLiveProgress }) {
  return (
    <span className="text-xs text-muted-foreground inline-flex items-center gap-1.5">
      <span>{progress.stage}</span>
      <span className="text-muted-foreground/50">·</span>
      <ElapsedTimer startedAt={progress.startedAt} />
      {progress.note && <span className="text-green-600 dark:text-green-500">· {progress.note}</span>}
    </span>
  );
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
 * value is driven by the live Delora price from {@link usePrice}. The amount
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
          price={price}
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
    case "crosschain-swap": {
      const outputToken = result?.actualOutput ?? step.outputToken;
      const destChainId = step.outputToken.chainId;
      const destChainName = chains[destChainId as keyof typeof chains]?.name || `Chain ${destChainId}`;
      const inputWallets = [...new Set(step.inputTokens.map((t) => t.walletAddress))];
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
          <span className="text-muted-foreground">on</span> <ChainBadge chainId={step.chainId} name={chainName} />{" "}
          <span className="text-muted-foreground">→</span> <TokenAmountInlineFor token={outputToken} />{" "}
          <span className="text-muted-foreground">on</span> <ChainBadge chainId={destChainId} name={destChainName} />{" "}
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
    // A gnosis-bridge renders exactly like a CCTP bridge: source/destination
    // chains and wallets are read from the step itself.
    case "gnosis-bridge":
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
    case "gnosis-wait":
      return (
        <>
          <span className="text-foreground">
            {isPast ? "Waited for" : isExecuting ? "Waiting for" : "Wait for"} the Omnibridge
          </span>{" "}
          <span className="text-muted-foreground">on</span> <ChainBadge chainId={step.chainId} name={chainName} />
        </>
      );
    case "crosschain-wait":
      return (
        <>
          <span className="text-foreground">
            {isPast ? "Waited for" : isExecuting ? "Waiting for" : "Wait for"} delivery
          </span>{" "}
          <span className="text-muted-foreground">on</span> <ChainBadge chainId={step.chainId} name={chainName} />
        </>
      );
    case "gnosis-claim":
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
    case "shield": {
      const inputToken = step.inputTokens[0];
      const outputToken = result?.actualOutput ?? step.outputToken;
      const totalAmount = step.inputTokens.reduce((sum, t) => sum + t.amount, 0n);
      return (
        <>
          <span className="text-foreground">{isPast ? "Shielded" : isExecuting ? "Shielding" : "Shield"}</span>{" "}
          <TokenAmountInlineFor token={inputToken} amount={totalAmount} />{" "}
          <span className="text-muted-foreground">→</span> <TokenAmountInlineFor token={outputToken} />{" "}
          <span className="text-muted-foreground">into</span>{" "}
          <span className="inline-flex items-center gap-1">
            <img src="/other-icons/railgun.svg" alt="Railgun" className="size-3 inline-block" /> Railgun
          </span>{" "}
          <span className="text-muted-foreground">on</span> <ChainBadge chainId={step.chainId} name={chainName} />{" "}
          <span className="text-xs text-muted-foreground/80 inline-flex items-center gap-1">
            (<AddressInline address={inputToken.walletAddress} /> →{" "}
            {step.railgunAddress ? <AddressInline address={step.railgunAddress} /> : "Railgun"})
          </span>
        </>
      );
    }
    case "gas-topup": {
      const inputToken = step.inputTokens[0];
      const destinations = step.gasTopUpDestinations ?? [];
      const destChainIds = [...new Set(destinations.map((d) => d.chainId))];
      const destAddresses = [...new Set(destinations.map((d) => d.address))];
      return (
        <>
          <span className="text-foreground">
            {isPast ? "Topped up gas with" : isExecuting ? "Topping up gas with" : "Top up gas with"}
          </span>{" "}
          <TokenAmountInlineFor token={inputToken} /> <span className="text-muted-foreground">from</span>{" "}
          <ChainBadge chainId={step.chainId} name={chainName} /> <span className="text-muted-foreground">→</span>{" "}
          {destChainIds.map((cId, i) => {
            const cName = chains[cId as keyof typeof chains]?.name || `Chain ${cId}`;
            return (
              <span key={cId}>
                {i > 0 && <span className="text-muted-foreground"> + </span>}
                <ChainBadge chainId={cId} name={cName} />
              </span>
            );
          })}{" "}
          <span className="text-xs text-muted-foreground/80 inline-flex items-center gap-1">
            (
            {destAddresses.length === 1 && destAddresses[0].toLowerCase() === inputToken.walletAddress.toLowerCase() ? (
              <AddressInline address={inputToken.walletAddress} />
            ) : (
              <>
                <AddressInline address={inputToken.walletAddress} /> →{" "}
                {destAddresses.map((addr, i) => (
                  <span key={addr}>
                    {i > 0 && " + "}
                    <AddressInline address={addr} />
                  </span>
                ))}
              </>
            )}
            )
          </span>
        </>
      );
    }
    case "gas-topup-wait": {
      const destinations = step.gasTopUpDestinations ?? [];
      const destChainIds = [...new Set(destinations.map((d) => d.chainId))];
      return (
        <>
          <span className="text-foreground">
            {isPast ? "Gas delivered on" : isExecuting ? "Waiting for gas on" : "Wait for gas on"}
          </span>{" "}
          {destChainIds.map((cId, i) => {
            const cName = chains[cId as keyof typeof chains]?.name || `Chain ${cId}`;
            return (
              <span key={cId}>
                {i > 0 && <span className="text-muted-foreground"> + </span>}
                <ChainBadge chainId={cId} name={cName} />
              </span>
            );
          })}
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

function GasCostDisplay({ gas, chainId }: { gas: StepGasEstimate; chainId: number }) {
  const formatFiat = useFormatFiat();
  const { price: nativePrice } = usePrice(chainId, zeroAddress);
  const nativeAmount = Number.parseFloat(formatUnits(gas.gasCostWei, 18));
  const gweiPrice = Number.parseFloat(formatUnits(gas.maxFeePerGas, 9));
  const gasCostUsd = nativePrice !== undefined ? nativeAmount * nativePrice : undefined;
  const hasUsd = gasCostUsd !== undefined && gasCostUsd > 0;

  const networkFee = `~${nativeAmount.toFixed(6)} ${gas.nativeSymbol}`;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground tabular-nums cursor-help">
          <Fuel className="w-3.5 h-3.5" />
          <span>{hasUsd ? formatFiat(gasCostUsd) : networkFee}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">
        <dl className="grid grid-cols-[auto_auto] gap-x-4 gap-y-1 tabular-nums">
          <dt className="text-muted-foreground">Gas price</dt>
          <dd className="text-right">{gweiPrice.toFixed(2)} gwei</dd>
          <dt className="text-muted-foreground">Network fee</dt>
          <dd className="text-right">{networkFee}</dd>
          {hasUsd && (
            <>
              <dt className="text-muted-foreground">Fiat estimate</dt>
              <dd className="text-right">{formatFiat(gasCostUsd)}</dd>
            </>
          )}
        </dl>
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Marks a step that executes through a smart-account path. Safe steps show
 * the N-of-M requirement and, while live, a deep link into the Safe queue so
 * co-signers can be pointed at the pending proposal; ERC-4337 smart-wallet
 * steps get a plain badge (they sign synchronously in the connected wallet).
 */
function SafeExecutionBadge({ step, showQueueLink }: { step: TransactionStep; showQueueLink: boolean }) {
  const execution = step.execution;
  if (!execution) return null;

  if (execution.via === "smart") {
    return (
      <span
        className="rounded-full border border-border bg-muted/50 px-1.5 py-px text-xs text-muted-foreground"
        title={
          execution.atomic
            ? "Executes as one atomic batch in your smart wallet"
            : "Executes call-by-call in your smart wallet"
        }
      >
        Smart wallet
      </span>
    );
  }

  const queueUrl = safeAppQueueUrl(step.chainId, execution.safeAddress);
  const separateExecutor =
    execution.executorAddress && execution.executorAddress.toLowerCase() !== execution.ownerAddress.toLowerCase()
      ? execution.executorAddress
      : undefined;
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
      <span
        className="rounded-full border border-border bg-muted/50 px-1.5 py-px"
        title={
          `Executes as a Safe transaction (${execution.threshold} signature${execution.threshold > 1 ? "s" : ""} required)` +
          (separateExecutor ? `, submitted and gas paid by ${separateExecutor}` : "")
        }
      >
        Safe {execution.threshold > 1 ? `${execution.threshold}✕` : ""}
      </span>
      {separateExecutor && <span className="text-muted-foreground/70">via {formatAddress(separateExecutor)}</span>}
      {showQueueLink && execution.threshold > 1 && queueUrl && (
        <a
          href={queueUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-0.5 text-primary hover:text-primary/80 hover:underline"
        >
          Safe queue
          <ExternalLink className="w-3 h-3" />
        </a>
      )}
    </span>
  );
}

export function PlanCard({ step, result, stepNumber, progress }: PlanCardProps) {
  const isPending = step.status === "pending";
  const isExecuting = step.status === "executing";
  const isSuccess = step.status === "success";
  const isFailed = step.status === "failed";
  const isSkipped = step.status === "skipped";

  return (
    <div className="flex items-center justify-between py-1.5 px-2 sm:py-2 sm:px-3 rounded transition-colors hover:bg-muted/60 dark:hover:bg-muted/30">
      {/* Left side: Status icon + Action text */}
      <div className="flex gap-2 sm:gap-3 flex-1 min-w-0">
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
        ) : isSkipped ? (
          <Forward className="w-5 h-5 text-muted-foreground shrink-0" />
        ) : null}

        {/* Action description + inline transient wait status */}
        <div className="text-xs sm:text-sm text-foreground flex items-center gap-1.5 flex-wrap min-w-0">
          <ActionContent step={step} result={result} />
          {step.execution && <SafeExecutionBadge step={step} showQueueLink={isExecuting || isFailed} />}
          {isExecuting && progress && <StepProgressLine progress={progress} />}
        </div>
      </div>

      {/* Right side: Gas cost + Transaction link or status */}
      <div className="flex items-center gap-2 shrink-0 ml-2 sm:ml-4">
        {step.estimatedGas && !isFailed && !(isSuccess && result?.transactionHash) && (
          <GasCostDisplay gas={step.estimatedGas} chainId={step.chainId} />
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
        {isSkipped && (
          <span className="text-sm font-medium text-muted-foreground" title={result?.skipReason}>
            Skipped
          </span>
        )}
      </div>
    </div>
  );
}
