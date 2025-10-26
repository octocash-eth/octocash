import * as React from "react";
import { ChainIcon } from "~/components/chain-icon";
import { TokenIcon } from "~/components/token-icon";
import { AddressDisplayAvatar, AddressDisplayRoot, AddressDisplayText } from "~/components/ui/address-display";
import {
  TokenAmountSelectorInput,
  TokenAmountSelectorMaxButton,
  TokenAmountSelectorRoot,
  TokenAmountSelectorSlider,
} from "~/components/ui/token-amount-selector";
import type { WalletData } from "~/components/wallet-table/columns";

interface TokenWithAmount extends WalletData {
  amountToConsolidate: string;
}

interface SelectAmountStageProps {
  tokens: TokenWithAmount[];
  onAmountsChange: (amounts: Record<string, string>) => void;
}

export function SelectAmountStage({ tokens, onAmountsChange }: SelectAmountStageProps) {
  const [amounts, setAmounts] = React.useState<Record<string, string>>(() => {
    // Initialize with amounts from parent (amountToConsolidate) or fall back to full amounts
    return tokens.reduce(
      (acc, token) => {
        acc[token.id] = token.amountToConsolidate || token.amount;
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
          const maxAmount = token.amount;
          const amountValue = amounts[token.id] ?? "0";
          const currentUsdValue =
            Number.parseFloat(maxAmount) > 0
              ? ((Number.parseFloat(amountValue) || 0) / Number.parseFloat(maxAmount)) * token.amountInUsd
              : 0;

          return (
            <div key={token.id} className="border rounded-lg p-4 space-y-3">
              {/* Token Header */}
              <div className="flex justify-between items-start">
                <div className="flex items-center gap-2">
                  <TokenIcon token={token.token} iconUrl={token.iconUrl} className="size-8" />
                  <div className="flex flex-col">
                    <div className="flex items-center gap-1.5">
                      <span className="font-medium">{token.token}</span>
                      <span className="text-xs text-muted-foreground flex items-center gap-1">
                        on
                        <ChainIcon chain={token.chain} className="size-3" />
                        {token.chain}
                      </span>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      <AddressDisplayRoot address={token.wallet} className="gap-1.5">
                        <AddressDisplayAvatar className="size-3" />
                        <AddressDisplayText />
                      </AddressDisplayRoot>
                    </div>
                  </div>
                </div>
                <div className="text-right">
                  <div className="font-medium">
                    {currentUsdValue.toLocaleString("en-US", {
                      style: "currency",
                      currency: "USD",
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    of{" "}
                    {token.amountInUsd.toLocaleString("en-US", {
                      style: "currency",
                      currency: "USD",
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}
                  </div>
                </div>
              </div>

              {/* Slider and Input Controls */}
              <TokenAmountSelectorRoot
                value={amountValue}
                onValueChange={(value) => handleAmountChange(token.id, value)}
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
