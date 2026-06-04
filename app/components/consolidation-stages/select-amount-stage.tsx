import * as React from "react";
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
import { useFormatFiat } from "~/context/currency-provider";
import { usePriceMap, useRegisterPrices } from "~/context/token-price-provider";
import { formatTokenAmount, getChainName, getTokenId } from "~/lib/tokens";

interface SelectAmountStageProps {
  tokens: TokenWithConsolidateAmount[];
  onAmountsChange: (amounts: Record<string, string>) => void;
}

// Full balance is selectable for all tokens (gas costs are estimated during planning)
function calculateMaxConsolidatableAmount(token: TokenWithConsolidateAmount, requestedAmount?: string): string {
  const fullAmount = formatTokenAmount(token);
  return requestedAmount ?? fullAmount;
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

  // Make sure the shared price context is tracking every token visible here.
  // Native coins (zeroAddress) are handled by `fetchOdosPrices`, which
  // substitutes Odos's `0xeeee…ee` sentinel only at request time and maps
  // the response back to `zeroAddress` before storing.
  useRegisterPrices(tokens);
  const { priceFor } = usePriceMap();
  const formatFiat = useFormatFiat();

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
    <div className="space-y-3 sm:space-y-4">
      <div className="text-xs sm:text-sm text-muted-foreground mb-3 sm:mb-4">
        Adjust the amount you want to consolidate for each token. Use the slider or enter a value directly.
      </div>

      <div className="space-y-3 sm:space-y-4 max-h-[min(24rem,calc(100dvh-19rem))] overflow-y-auto pr-2">
        {tokens.map((token) => {
          const tokenId = getTokenId(token);
          const chainName = getChainName(token.chainId);
          const price = priceFor(token) ?? 0;

          // Calculate max consolidatable amount (respecting gas threshold for native tokens)
          const maxAmount = calculateMaxConsolidatableAmount(token);
          const amountValue = amounts[tokenId] ?? "0";
          const totalUsdValue = Number(formatTokenAmount(token)) * price;
          const currentUsdValue = (Number.parseFloat(amountValue) || 0) * price;

          return (
            <div key={tokenId} className="border rounded-lg p-3 sm:p-4 space-y-3">
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
                  <div className="font-medium">{formatFiat(currentUsdValue)}</div>
                  <div className="text-xs text-muted-foreground">of {formatFiat(totalUsdValue)}</div>
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
