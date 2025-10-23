import * as React from "react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
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
    // Allow empty string during typing
    if (value === "") {
      setAmounts((prev) => ({
        ...prev,
        [tokenId]: "",
      }));
      return;
    }

    // Validate that the input is a valid number and within range
    const token = tokens.find((t) => t.id === tokenId);
    if (!token) return;

    const maxAmount = Number.parseFloat(token.amount);
    const numValue = Number.parseFloat(value);

    if (Number.isNaN(numValue)) {
      // Invalid number, keep current value or set to empty
      setAmounts((prev) => ({
        ...prev,
        [tokenId]: "",
      }));
      return;
    }

    // Clamp to valid range
    const clampedValue = Math.min(Math.max(0, numValue), maxAmount);
    setAmounts((prev) => ({
      ...prev,
      [tokenId]: clampedValue.toString(),
    }));
  };

  const handleInputBlur = (tokenId: string) => {
    // Convert empty string to "0" when user leaves the input
    const currentValue = amounts[tokenId];
    if (currentValue === "" || currentValue === undefined) {
      setAmounts((prev) => ({
        ...prev,
        [tokenId]: "0",
      }));
    }
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
                  {token.iconUrl && <img src={token.iconUrl} alt={token.token} className="w-8 h-8 rounded-full" />}
                  <div className="flex flex-col">
                    <span className="font-medium">
                      {token.token} ({token.chain})
                    </span>
                    <span className="text-xs text-muted-foreground">
                      Available:{" "}
                      {Number(token.amount).toLocaleString(undefined, {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 6,
                      })}{" "}
                      {token.token}
                    </span>
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
                <input
                  type="range"
                  min="0"
                  max={maxAmount}
                  step={maxAmount / 1000}
                  value={currentAmount}
                  onChange={(e) => handleSliderChange(token.id, e.target.value)}
                  className="flex-1 h-1.5 bg-muted rounded-lg appearance-none cursor-pointer accent-primary"
                />
                {/* Amount Input */}
                <Input
                  type="number"
                  min="0"
                  max={maxAmount}
                  step="any"
                  value={amountValue}
                  onChange={(e) => handleInputChange(token.id, e.target.value)}
                  onBlur={() => handleInputBlur(token.id)}
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
