import * as React from "react";
import AddressAvatar from "~/components/address-avatar";
import { ChainIcon } from "~/components/chain-icon";
import { TokenIcon } from "~/components/token-icon";
import { Button } from "~/components/ui/button";
import { InputDecimal } from "~/components/ui/input-decimal";
import { Slider } from "~/components/ui/slider";
import type { WalletData } from "~/components/wallet-table/columns";
import { formatAddress } from "~/lib/utils";

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

  React.useEffect(() => {
    onAmountsChange(amounts);
  }, [amounts, onAmountsChange]);

  const handleSliderChange = (tokenId: string, value: string) => {
    setAmounts((prev) => ({
      ...prev,
      [tokenId]: value,
    }));
  };

  const handleInputChange = (tokenId: string, value: string) => {
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
          const maxAmount = Number.parseFloat(token.amount);
          const amountValue = amounts[token.id] ?? "0";
          const currentAmount = Number.parseFloat(amountValue) || 0;
          const currentUsdValue = maxAmount > 0 ? (currentAmount / maxAmount) * token.amountInUsd : 0;

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
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <AddressAvatar addressOrEns={token.wallet} className="size-3" />
                      <span>{formatAddress(token.wallet)}</span>
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
              <div className="flex items-center gap-3">
                {/* Slider */}
                <Slider
                  min={0}
                  max={maxAmount}
                  step={1 / 10 ** Math.min(token.decimals, 6)}
                  value={[currentAmount]}
                  onValueChange={(values) => handleSliderChange(token.id, values[0].toString())}
                  className="flex-1"
                />
                {/* Amount Input */}
                <InputDecimal
                  min="0"
                  max={maxAmount}
                  decimals={token.decimals}
                  value={amountValue}
                  onValueChange={(value) => handleInputChange(token.id, value)}
                  className="w-28 h-8 text-sm"
                  placeholder="0.00"
                />
                {/* Max Button */}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => handleSliderChange(token.id, token.amount)}
                  className="h-8 px-3 text-xs shrink-0"
                >
                  Max
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
