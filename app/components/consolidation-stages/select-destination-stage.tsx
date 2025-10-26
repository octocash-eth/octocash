import { useId } from "react";
import { isAddress } from "viem";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import { supportedChains } from "~/data/supported-chains";
import { ChainIcon } from "../chain-icon";
import { Combobox } from "../combobox";
import { TokenSelector } from "../token-selector";
import { AddressDisplayAvatar, AddressDisplayRoot, AddressDisplayText } from "../ui/address-display";

interface SelectDestinationStageProps {
  destinationWallet: string;
  setDestinationWallet: (value: string) => void;
  destinationChain: string;
  setDestinationChain: (value: string) => void;
  destinationTokenAddr: string;
  setDestinationTokenAddr: (value: string) => void;
  addressOptions: Array<{ value: string; label: string }>;
}

export function SelectDestinationStage({
  destinationWallet,
  setDestinationWallet,
  destinationChain,
  setDestinationChain,
  destinationTokenAddr,
  setDestinationTokenAddr,
  addressOptions,
}: SelectDestinationStageProps) {
  const _destinationChainId = useId();

  // Available chains for destination
  const availableChains = supportedChains.map((chain) => ({
    name: chain.name,
    chainId: chain.id,
  }));

  const destinationChainId = Number(
    availableChains.find((chain) => chain.chainId === Number(destinationChain))?.chainId,
  );

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <label htmlFor="destination-wallet" className="text-sm font-medium">
          Destination Wallet
        </label>
        <Combobox
          labelFunction={(address: string) => (
            <AddressDisplayRoot address={address}>
              <AddressDisplayAvatar className="size-4" />
              <AddressDisplayText />
            </AddressDisplayRoot>
          )}
          placeholder="0x..."
          searchPlaceholder="Select or paste an address"
          options={addressOptions}
          value={destinationWallet}
          onValueChange={setDestinationWallet}
          isValidOption={(value) => [isAddress(value), `"${value}" is not an Ethereum address`]}
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
        />
      </div>
    </div>
  );
}
