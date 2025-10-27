import React, { useId } from "react";
import type { Address } from "viem";
import { useAccount } from "wagmi";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import { supportedChains } from "~/data/supported-chains";
import { AddressSelector } from "../address-selector";
import { ChainIcon } from "../chain-icon";
import { getDefaultTokenOptions, TokenSelector } from "../token-selector";

interface SelectDestinationStageProps {
  destinationWallet: string;
  setDestinationWallet: (value: string) => void;
  destinationChain: string;
  setDestinationChain: (value: string) => void;
  destinationTokenAddr: string;
  setDestinationTokenAddr: (value: string) => void;
}

export function SelectDestinationStage({
  destinationWallet,
  setDestinationWallet,
  destinationChain,
  setDestinationChain,
  destinationTokenAddr,
  setDestinationTokenAddr,
}: SelectDestinationStageProps) {
  const _destinationChainId = useId();
  const { addresses = [] as Address[] } = useAccount();

  // Available chains for destination
  const availableChains = supportedChains.map((chain) => ({
    name: chain.name,
    chainId: chain.id,
  }));

  const destinationChainId = Number(
    availableChains.find((chain) => chain.chainId === Number(destinationChain))?.chainId,
  );

  // Memoize token options to avoid creating new array reference on every render
  const tokenOptions = React.useMemo(() => getDefaultTokenOptions(destinationChainId), [destinationChainId]);

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <label htmlFor="destination-wallet" className="text-sm font-medium">
          Destination Wallet
        </label>
        <AddressSelector
          options={addresses.map((address) => ({ value: address, label: address }))}
          value={destinationWallet}
          onChange={setDestinationWallet}
          chainId={destinationChainId}
        />
      </div>

      <div className="space-y-2">
        <label htmlFor={_destinationChainId} className="text-sm font-medium">
          Destination Chain
        </label>
        <Select value={destinationChain} onValueChange={setDestinationChain} required>
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
          chainId={destinationChainId}
          value={destinationTokenAddr}
          onChange={setDestinationTokenAddr}
          disabled={!destinationChainId}
          options={tokenOptions}
        />
      </div>
    </div>
  );
}
