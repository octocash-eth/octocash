import React, { useId } from "react";
import { type Address, getAddress, isAddress } from "viem";
import { useAccount } from "wagmi";
import { AddressSelector } from "~/components/address";
import { RailgunPoolWarning } from "~/components/railgun/railgun-pool-warning";
import { formatTokenValue, getDefaultTokenOptions, type TokenData, TokenSelector } from "~/components/token";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import { getRailgunTokenOptions, RAILGUN_SUPPORTED_CHAINS } from "~/data/railgun";
import { supportedChains } from "~/data/supported-chains";
import { isRailgunAddress } from "~/lib/railgun";
import { ChainIcon } from "../chain/chain-icon";

export interface DestinationSelection {
  /** Public 0x address (checksummed) or Railgun 0zk address. */
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

  const isRailgun = isRailgunAddress(value.walletAddress);

  // Available chains for destination — Railgun is only deployed on a subset.
  const availableChains = supportedChains
    .filter((chain) => !isRailgun || RAILGUN_SUPPORTED_CHAINS.includes(chain.id))
    .map((chain) => ({
      name: chain.name,
      chainId: chain.id,
    }));

  const destinationChain = value.chainId ? value.chainId.toString() : "";

  // Memoize token options to avoid creating new array reference on every render
  const tokenOptions = React.useMemo(() => {
    if (!value.chainId) return [];
    if (isRailgun) {
      // Only ERC20s can be shielded (no native ETH), so offer WETH/USDC/WBTC.
      return getRailgunTokenOptions(value.chainId).map((token) => ({
        value: formatTokenValue(value.chainId as number, token.address, token.decimals, token.symbol, token.name),
      }));
    }
    return getDefaultTokenOptions(value.chainId);
  }, [value.chainId, isRailgun]);

  const tokenValue = value.tokenInfo?.address || "";

  const handleWalletChange = (walletAddress: string) => {
    if (isRailgunAddress(walletAddress)) {
      // Drop a previously-selected chain Railgun isn't deployed on.
      const chainSupported = value.chainId !== undefined && RAILGUN_SUPPORTED_CHAINS.includes(value.chainId);
      onChange({
        ...value,
        walletAddress,
        chainId: chainSupported ? value.chainId : undefined,
        tokenInfo: chainSupported ? value.tokenInfo : undefined,
      });
      return;
    }
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

  const selectedChainName = value.chainId
    ? supportedChains.find((chain) => chain.id === value.chainId)?.name
    : undefined;

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
          allowRailgun
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

      {isRailgun && value.chainId && value.tokenInfo && selectedChainName && (
        <RailgunPoolWarning
          chainId={value.chainId}
          token={value.tokenInfo.address}
          symbol={value.tokenInfo.symbol}
          decimals={value.tokenInfo.decimals}
          chainName={selectedChainName}
        />
      )}
    </div>
  );
}
