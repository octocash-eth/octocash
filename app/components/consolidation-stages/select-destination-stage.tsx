import React, { useId } from "react";
import { type Address, getAddress, isAddress } from "viem";
import { useAccount } from "wagmi";
import { AddressSelector } from "~/components/address";
import { getDefaultTokenOptions, type TokenData, TokenSelector } from "~/components/token";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import { supportedChains } from "~/data/supported-chains";
import { ChainIcon } from "../chain/chain-icon";

export interface DestinationSelection {
  walletAddress?: Address;
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

  const tokenValue = value.tokenInfo?.address || "";

  const handleWalletChange = (walletAddress: string) => {
    onChange({ ...value, walletAddress: isAddress(walletAddress) ? getAddress(walletAddress) : undefined });
  };

  const handleChainChange = (chainId: string) => {
    onChange({ ...value, chainId: Number(chainId), tokenInfo: undefined });
  };

  const handleTokenChange = (tokenData: TokenData) => {
    // Extract only the fields we need
    const tokenInfo = {
      address: tokenData.address,
      decimals: tokenData.decimals,
      symbol: tokenData.symbol,
    };
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
