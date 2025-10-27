import React, { useId } from "react";
import { type Address, isAddressEqual } from "viem";
import { useAccount } from "wagmi";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import { supportedChains } from "~/data/supported-chains";
import { AddressSelector } from "../address-selector";
import { ChainIcon } from "../chain-icon";
import { getDefaultTokenOptions, parseTokenValue, TokenSelector } from "../token-selector";

export interface DestinationSelection {
  walletAddress?: string;
  chainId?: number;
  tokenInfo?: {
    address: Address;
    decimals: number;
    symbol: string;
  };
}

interface SelectDestinationStageProps {
  value: DestinationSelection;
  onChange: (value: DestinationSelection) => void;
}

export function SelectDestinationStage({ value, onChange }: SelectDestinationStageProps) {
  const _destinationChainId = useId();
  const { addresses = [] as Address[] } = useAccount();

  // Available chains for destination
  const availableChains = supportedChains.map((chain) => ({
    name: chain.name,
    chainId: chain.id,
  }));

  const destinationChain = value.chainId ? value.chainId.toString() : "";

  // Memoize token options to avoid creating new array reference on every render
  const tokenOptions = React.useMemo(
    () => (value.chainId ? getDefaultTokenOptions(value.chainId) : []),
    [value.chainId],
  );

  // Memoize the formatted token value for the selector
  const tokenValue = React.useMemo(() => {
    if (!value.tokenInfo || !value.chainId) return "";
    const { address } = value.tokenInfo;
    // Check if this matches one of the default options
    const matchingOption = tokenOptions.find((opt) => {
      const parsed = parseTokenValue(opt.value);
      return parsed && isAddressEqual(parsed.address, address);
    });
    // If found, use the full formatted value; otherwise create a minimal one
    return matchingOption?.value || address;
  }, [value.tokenInfo, value.chainId, tokenOptions]);

  const handleWalletChange = (walletAddress: string) => {
    onChange({ ...value, walletAddress });
  };

  const handleChainChange = (chainId: string) => {
    onChange({ ...value, chainId: Number(chainId), tokenInfo: undefined });
  };

  const handleTokenChange = (token: string) => {
    const tokenInfo = parseTokenValue(token);
    onChange({ ...value, tokenInfo });
  };

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <label htmlFor="destination-wallet" className="text-sm font-medium">
          Destination Wallet
        </label>
        <AddressSelector
          options={addresses.map((address) => ({ value: address, label: address }))}
          value={value.walletAddress ?? ""}
          onChange={handleWalletChange}
          chainId={value.chainId}
        />
      </div>

      <div className="space-y-2">
        <label htmlFor={_destinationChainId} className="text-sm font-medium">
          Destination Chain
        </label>
        <Select value={destinationChain} onValueChange={handleChainChange} required>
          <SelectTrigger id={_destinationChainId} className="w-full">
            <SelectValue placeholder="Select chain" />
          </SelectTrigger>
          <SelectContent>
            {availableChains.map((chain) => (
              <SelectItem key={chain.chainId} value={chain.chainId.toString()}>
                <div className="flex items-center gap-2">
                  <ChainIcon chain={chain.name} className="size-4" />
                  {chain.name}
                </div>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <label htmlFor="destination-token" className="text-sm font-medium">
          Destination Token
        </label>
        <TokenSelector
          chainId={value.chainId ?? 1}
          value={tokenValue}
          onChange={handleTokenChange}
          disabled={!value.chainId}
          options={tokenOptions}
        />
      </div>
    </div>
  );
}
