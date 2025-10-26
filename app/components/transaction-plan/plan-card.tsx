import { Check, Circle, ExternalLink, Loader2, X } from "lucide-react";
import { formatUnits } from "viem";
import { chains } from "~/data/supported-chains";
import type { StepResult, TransactionStep } from "~/lib/types";
import { ChainIcon } from "../chain-icon";
import { TokenIcon } from "../token-icon";
import { AddressDisplayAvatar, AddressDisplayRoot, AddressDisplayText } from "../ui/address-display";

interface PlanCardProps {
  step: TransactionStep;
  stepNumber: number;
  result?: StepResult;
}

function truncateAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function formatAmount(amount: bigint, decimals: number = 18): string {
  const value = Number(formatUnits(amount, decimals));
  if (value !== 0 && value < 0.000001) return "<0.000001";
  return value.toLocaleString(undefined, {
    maximumFractionDigits: 6,
  });
}

function getExplorerUrl(chainId: number, txHash: string): string {
  const chain = chains[chainId as keyof typeof chains];
  if (!chain?.blockExplorers?.default?.url) return "#";
  return `${chain.blockExplorers.default.url}/tx/${txHash}`;
}

function getTokenIconUrl(chainId: number, tokenAddress: string): string {
  return `https://assets.octo.cash/token/${chainId}/${tokenAddress}`;
}

function getActionContent(step: TransactionStep, result?: StepResult): React.ReactNode {
  const chainName = chains[step.chainId as keyof typeof chains]?.name || `Chain ${step.chainId}`;
  const isPast = step.status === "success";
  const isExecuting = step.status === "executing";

  let inputAmount = "";
  let outputAmount = "";

  if (step.inputTokens[0].amount > 0n) {
    inputAmount = formatAmount(step.inputTokens[0].amount, step.inputTokens[0].decimals || 18);
  }

  if (isPast && result?.actualOutput) {
    outputAmount = formatAmount(result.actualOutput.amount, result.actualOutput.decimals || 18);
  } else if (step.outputToken.amount > 0n) {
    outputAmount = formatAmount(step.outputToken.amount, step.outputToken.decimals || 18);
  }

  const chainIcon = (chainId: number) => {
    const chainName = chains[chainId as keyof typeof chains]?.name || `Chain ${chainId}`;
    return <ChainIcon chain={chainName} className="size-4 inline-block" />;
  };

  const tokenIcon = (chainId: number, tokenAddress: string, symbol: string) => (
    <TokenIcon token={symbol} iconUrl={getTokenIconUrl(chainId, tokenAddress)} className="size-4 inline-block" />
  );

  const addressDisplay = (address: string) => (
    <AddressDisplayRoot address={address} className="inline-flex gap-1">
      <AddressDisplayAvatar className="size-3 sm:size-4" title={`Wallet: ${address}`} />
      <AddressDisplayText />
    </AddressDisplayRoot>
  );

  // Group token icon + amount + symbol together with popover
  const tokenAmount = (
    amount: string,
    chainId: number,
    tokenAddress: string,
    symbol: string,
    walletAddress: string,
  ) => (
    <span className="inline-flex items-center gap-1" title={`Wallet: ${truncateAddress(walletAddress)}`}>
      {tokenIcon(chainId, tokenAddress, symbol)} {amount} {symbol}
    </span>
  );

  // Group chain icon + name together
  const chainBadge = (chainId: number, name: string) => (
    <span className="inline-flex items-center gap-1">
      {chainIcon(chainId)} {name}
    </span>
  );

  switch (step.type) {
    case "swap": {
      const outputToken = isPast && result?.actualOutput ? result.actualOutput : step.outputToken;
      const inputWallets = [...new Set(step.inputTokens.map((t) => t.walletAddress))];
      return (
        <>
          <span className="text-gray-600">{isPast ? "Swapped" : isExecuting ? "Swapping" : "Swap"}</span>{" "}
          {step.inputTokens.map((inputToken) => {
            const amount = formatAmount(inputToken.amount, inputToken.decimals || 18);
            const key = `${inputToken.token}-${inputToken.chainId}-${inputToken.walletAddress}`;
            return (
              <span key={key}>
                {step.inputTokens.indexOf(inputToken) > 0 && <span className="text-gray-500"> + </span>}
                {tokenAmount(amount, inputToken.chainId, inputToken.token, inputToken.symbol, inputToken.walletAddress)}
              </span>
            );
          })}{" "}
          <span className="text-gray-500">→</span>{" "}
          {tokenAmount(
            outputAmount,
            outputToken.chainId,
            outputToken.token,
            outputToken.symbol,
            outputToken.walletAddress,
          )}{" "}
          <span className="text-gray-500">on</span> {chainBadge(step.chainId, chainName)}{" "}
          <span className="text-gray-400 text-xs inline-flex items-center gap-1">
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
      return (
        <>
          <span className="text-gray-600">{isPast ? "Bridged" : isExecuting ? "Bridging" : "Bridge"}</span>{" "}
          {tokenAmount(inputAmount, inputToken.chainId, inputToken.token, inputToken.symbol, inputToken.walletAddress)}{" "}
          <span className="text-gray-500">from</span> {chainBadge(step.chainId, chainName)}{" "}
          <span className="text-gray-500">to</span> {chainBadge(destChainId, destChain)}{" "}
          <span className="text-gray-400 text-xs inline-flex items-center gap-1">
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
          <span className="text-gray-600">
            {isPast ? "Waited for" : isExecuting ? "Waiting for" : "Wait for"} attestation
          </span>{" "}
          <span className="text-gray-500">on</span> {chainBadge(step.chainId, chainName)}
        </>
      );
    case "claim": {
      const outputToken = isPast && result?.actualOutput ? result.actualOutput : step.outputToken;
      return (
        <>
          <span className="text-gray-600">{isPast ? "Claimed" : isExecuting ? "Claiming" : "Claim"}</span>{" "}
          {tokenAmount(
            outputAmount,
            outputToken.chainId,
            outputToken.token,
            outputToken.symbol,
            outputToken.walletAddress,
          )}{" "}
          <span className="text-gray-500">on</span> {chainBadge(step.chainId, chainName)}{" "}
          <span className="text-gray-400 text-xs inline-flex items-center gap-1">
            ({addressDisplay(outputToken.walletAddress)})
          </span>
        </>
      );
    }
    case "transfer": {
      const inputToken = step.inputTokens[0];
      const outputToken = step.outputToken;
      return (
        <>
          <span className="text-gray-600">{isPast ? "Transferred" : isExecuting ? "Transferring" : "Transfer"}</span>{" "}
          {step.inputTokens.map((inputToken) => {
            const amount = formatAmount(inputToken.amount, inputToken.decimals || 18);
            const key = `${inputToken.token}-${inputToken.chainId}-${inputToken.walletAddress}`;
            return (
              <span key={key}>
                {step.inputTokens.indexOf(inputToken) > 0 && <span className="text-gray-500"> + </span>}
                {tokenAmount(amount, inputToken.chainId, inputToken.token, inputToken.symbol, inputToken.walletAddress)}
              </span>
            );
          })}{" "}
          <span className="text-gray-500">on</span> {chainBadge(step.chainId, chainName)}{" "}
          <span className="text-gray-400 text-xs inline-flex items-center gap-1">
            ({addressDisplay(inputToken.walletAddress)} → {addressDisplay(outputToken.walletAddress)})
          </span>
        </>
      );
    }
    default:
      return (
        <>
          <span className="text-gray-600">Transaction</span> <span className="text-gray-500">on</span>{" "}
          {chainBadge(step.chainId, chainName)}
        </>
      );
  }
}

export function PlanCard({ step, result, stepNumber }: PlanCardProps) {
  const isPending = step.status === "pending";
  const isExecuting = step.status === "executing";
  const isSuccess = step.status === "success";
  const isFailed = step.status === "failed";

  return (
    <div className="flex items-center justify-between py-2 px-3 hover:bg-gray-50 rounded transition-colors">
      {/* Left side: Status icon + Action text */}
      <div className="flex gap-3 flex-1 min-w-0">
        {/* Status Icon or Step Number */}
        {isPending && stepNumber !== undefined ? (
          <div className="w-5 h-5 flex items-center justify-center flex-shrink-0 bg-primary text-primary-foreground rounded-full">
            <span className="text-xs font-semibold">{stepNumber}</span>
          </div>
        ) : isPending ? (
          <Circle className="w-5 h-5 text-gray-400 flex-shrink-0" />
        ) : isExecuting ? (
          <Loader2 className="w-5 h-5 text-primary animate-spin flex-shrink-0" />
        ) : isSuccess ? (
          <Check className="w-5 h-5 text-green-500 flex-shrink-0" />
        ) : isFailed ? (
          <X className="w-5 h-5 text-red-500 flex-shrink-0" />
        ) : null}

        {/* Action description */}
        <div className="text-sm text-gray-700 flex items-center gap-1.5 flex-wrap min-w-0">
          {getActionContent(step, result)}
        </div>
      </div>

      {/* Right side: Transaction link or status */}
      <div className="flex items-center gap-2 flex-shrink-0 ml-4">
        {isSuccess && result?.transactionHash && (
          <a
            href={getExplorerUrl(step.chainId, result.transactionHash)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-sm text-blue-600 hover:text-blue-700 hover:underline"
          >
            View tx
            <ExternalLink className="w-3 h-3" />
          </a>
        )}
        {isFailed && (
          <span
            className="text-sm font-medium text-red-600"
            title={step.error ? `${step.error.title}. ${step.error.message}` : undefined}
          >
            Failed
          </span>
        )}
      </div>
    </div>
  );
}
