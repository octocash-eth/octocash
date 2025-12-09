import * as React from "react";
import { formatUnits, parseUnits, zeroAddress } from "viem";
import { AddressDisplayAvatar, AddressDisplayRoot, AddressDisplayText } from "~/components/address";
import { ChainIcon } from "~/components/chain/chain-icon";
import type { TokenWithConsolidateAmount } from "~/components/consolidate-tokens-modal";
import {
  TokenAmountSelectorInput,
  TokenAmountSelectorMaxButton,
  TokenAmountSelectorRoot,
  TokenAmountSelectorSlider,
  TokenDisplayIcon,
  TokenDisplayRoot,
  TokenDisplaySymbol,
} from "~/components/token";
import { getGasThresholdForChain } from "~/data/gas-thresholds";
import { formatTokenAmount, formatUsd, getChainName, getTokenAmountInUsd, getTokenId } from "~/lib/tokens";

interface SelectAmountStageProps {
  tokens: TokenWithConsolidateAmount[];
  onAmountsChange: (amounts: Record<string, string>) => void;
}

// Helper function to calculate maximum consolidatable amount
// For native tokens, we need to reserve gas for transactions
function calculateMaxConsolidatableAmount(token: TokenWithConsolidateAmount, requestedAmount?: string): string {
  const isNativeToken = token.token === zeroAddress;
  const fullAmount = formatTokenAmount(token);

  // For ERC-20 tokens, all amount is available (no gas reservation needed)
  if (!isNativeToken) {
    return requestedAmount ?? fullAmount;
  }

  // For native tokens, subtract gas threshold using bigint arithmetic
  const gasThreshold = getGasThresholdForChain(token.chainId);
  const gasReserveWei = parseUnits(gasThreshold, token.decimals);
  const maxAvailableWei = token.amount > gasReserveWei ? token.amount - gasReserveWei : 0n;

  // If a requested amount is provided, return the minimum of requested and available
  if (requestedAmount) {
    const requestedWei = parseUnits(requestedAmount, token.decimals);
    const resultWei = requestedWei < maxAvailableWei ? requestedWei : maxAvailableWei;
    return formatUnits(resultWei, token.decimals);
  }

  return formatUnits(maxAvailableWei, token.decimals);
}

export function SelectAmountStage({ tokens, onAmountsChange }: SelectAmountStageProps) {
  const [amounts, setAmounts] = React.useState<Record<string, string>>(() => {
    // Initialize with amounts from parent (amountToConsolidate) or fall back to max consolidatable amounts
    return tokens.reduce(
      (acc, token) => {
        const tokenId = getTokenId(token);
        acc[tokenId] = calculateMaxConsolidatableAmount(token, token.amountToConsolidate);
        return acc;
      },
      {} as Record<string, string>,
    );
  });

  const onAmountsChangeRef = React.useRef(onAmountsChange);

  React.useEffect(() => {
    onAmountsChangeRef.current = onAmountsChange;
  }, [onAmountsChange]);

  React.useEffect(() => {
    onAmountsChangeRef.current(amounts);
  }, [amounts]);

  const handleAmountChange = (tokenId: string, value: string) => {
    setAmounts((prev) => ({
      ...prev,
      [tokenId]: value,
    }));
  };

  return (
    <div className="space-y-4">
      <div className="text-sm text-muted-foreground mb-4">
        Adjust the amount you want to consolidate for each token. Use the slider or enter a value directly.
      </div>

      <div className="space-y-4 max-h-96 overflow-y-auto pr-2">
        {tokens.map((token) => {
          const tokenId = getTokenId(token);
          const chainName = getChainName(token.chainId);
          const totalUsdValue = getTokenAmountInUsd(token);

          // Calculate max consolidatable amount (respecting gas threshold for native tokens)
          const maxAmount = calculateMaxConsolidatableAmount(token);
          const amountValue = amounts[tokenId] ?? "0";
          const currentUsdValue =
            Number.parseFloat(maxAmount) > 0
              ? ((Number.parseFloat(amountValue) || 0) / Number.parseFloat(maxAmount)) * totalUsdValue
              : 0;

          return (
            <div key={tokenId} className="border rounded-lg p-4 space-y-3">
              {/* Token Header */}
              <div className="flex justify-between items-start">
                <TokenDisplayRoot
                  tokenAddress={token.token}
                  chainId={token.chainId}
                  symbol={token.symbol}
                  className="gap-2"
                >
                  <TokenDisplayIcon className="size-8" />
                  <div className="flex flex-col">
                    <div className="flex items-center gap-1.5">
                      <span className="font-medium">
                        <TokenDisplaySymbol />
                      </span>
                      <span className="text-xs text-muted-foreground flex items-center gap-1">
                        on
                        <ChainIcon chain={chainName} className="size-3" />
                        {chainName}
                      </span>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      <AddressDisplayRoot address={token.walletAddress} className="gap-1.5">
                        <AddressDisplayAvatar className="size-3" />
                        <AddressDisplayText />
                      </AddressDisplayRoot>
                    </div>
                  </div>
                </TokenDisplayRoot>
                <div className="text-right">
                  <div className="font-medium">{formatUsd(currentUsdValue)}</div>
                  <div className="text-xs text-muted-foreground">of {formatUsd(totalUsdValue)}</div>
                  {token.token === zeroAddress && (
                    <div className="text-[10px] text-muted-foreground mt-1">
                      {getGasThresholdForChain(token.chainId)} {token.symbol} reserved for gas
                    </div>
                  )}
                </div>
              </div>

              {/* Slider and Input Controls */}
              <TokenAmountSelectorRoot
                value={amountValue}
                onValueChange={(value) => handleAmountChange(tokenId, value)}
                min="0"
                max={maxAmount}
                decimals={token.decimals}
                className="flex items-center gap-3"
              >
                <TokenAmountSelectorSlider className="flex-1" />
                <TokenAmountSelectorInput className="w-28 h-8 text-sm" placeholder="0.00" />
                <TokenAmountSelectorMaxButton variant="outline" size="sm" className="h-8 px-3 text-xs shrink-0" />
              </TokenAmountSelectorRoot>
            </div>
          );
        })}
      </div>
    </div>
  );
}
