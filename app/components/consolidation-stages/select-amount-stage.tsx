import * as React from "react";
import { formatUnits, parseUnits, zeroAddress } from "viem";
import { ChainIcon } from "~/components/chain-icon";
import { AddressDisplayAvatar, AddressDisplayRoot, AddressDisplayText } from "~/components/ui/address-display";
import {
  TokenAmountSelectorInput,
  TokenAmountSelectorMaxButton,
  TokenAmountSelectorRoot,
  TokenAmountSelectorSlider,
} from "~/components/ui/token-amount-selector";
import { TokenDisplayIcon, TokenDisplayRoot, TokenDisplaySymbol } from "~/components/ui/token-display";
import type { WalletData } from "~/components/wallet-table/columns";
import { getGasThresholdForChain } from "~/data/gas-thresholds";

interface TokenWithAmount extends WalletData {
  amountToConsolidate: string;
}

interface SelectAmountStageProps {
  tokens: TokenWithAmount[];
  onAmountsChange: (amounts: Record<string, string>) => void;
}

// Map chain name to ID
// TODO: This is a workaround, ideally WalletData should extend TokenAmount
const chainMap: Record<string, number> = {
  Ethereum: 1,
  "OP Mainnet": 10,
  "Arbitrum One": 42161,
  Base: 8453,
  Polygon: 137,
  "Linea Mainnet": 59144,
  Unichain: 1301,
};

// Helper function to calculate maximum consolidatable amount
// For native tokens, we need to reserve gas for transactions
function calculateMaxConsolidatableAmount(token: TokenWithAmount, chainId: number, requestedAmount?: string): string {
  const isNativeToken = token.tokenAddress === zeroAddress;

  // For ERC-20 tokens, all amount is available (no gas reservation needed)
  if (!isNativeToken) {
    return requestedAmount ?? token.amount;
  }

  // For native tokens, subtract gas threshold using bigint arithmetic
  const gasThreshold = getGasThresholdForChain(chainId);
  const totalAmountWei = parseUnits(token.amount, token.decimals);
  const gasReserveWei = parseUnits(gasThreshold, token.decimals);
  const maxAvailableWei = totalAmountWei > gasReserveWei ? totalAmountWei - gasReserveWei : 0n;

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
        const chainId = chainMap[token.chain] || 1;
        acc[token.id] = calculateMaxConsolidatableAmount(token, chainId, token.amountToConsolidate);
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
          const chainId = chainMap[token.chain] || 1;

          // Calculate max consolidatable amount (respecting gas threshold for native tokens)
          const maxAmount = calculateMaxConsolidatableAmount(token, chainId);
          const amountValue = amounts[token.id] ?? "0";
          const currentUsdValue =
            Number.parseFloat(maxAmount) > 0
              ? ((Number.parseFloat(amountValue) || 0) / Number.parseFloat(maxAmount)) * token.amountInUsd
              : 0;

          return (
            <div key={token.id} className="border rounded-lg p-4 space-y-3">
              {/* Token Header */}
              <div className="flex justify-between items-start">
                <TokenDisplayRoot
                  tokenAddress={token.tokenAddress}
                  chainId={chainId}
                  symbol={token.token}
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
                </TokenDisplayRoot>
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
                  {token.tokenAddress === zeroAddress && (
                    <div className="text-[10px] text-muted-foreground mt-1">
                      {getGasThresholdForChain(chainId)} {token.token} reserved for gas
                    </div>
                  )}
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
