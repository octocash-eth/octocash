import makeBlockie from "ethereum-blockies-base64";
import { useMemo } from "react";
import { isAddress } from "viem";
import { normalize } from "viem/ens";
import { useEnsAddress, useEnsAvatar, useEnsName } from "wagmi";
import { Avatar, AvatarFallback, AvatarImage } from "~/components/ui/avatar";
import { cn } from "~/lib/utils";

function AddressAvatar({
  addressOrEns,
  className,
  title,
}: {
  addressOrEns: string;
  className?: string;
  title?: string | undefined;
}) {
  const isEnsName = addressOrEns.endsWith(".eth");
  const isAddr = isAddress(addressOrEns);

  // If addressOrEns is an address, get the ens name
  const { data: ensName } = useEnsName({
    address: isAddr ? addressOrEns : undefined,
    chainId: 1,
    query: { enabled: !isEnsName && isAddr },
  });

  let normalizedName: string | undefined;
  try {
    normalizedName = isEnsName ? normalize(addressOrEns) : ensName?.toLowerCase();
  } catch (_error) {}

  // If we did not have the address and normalizedName is an ens name, get the ens address
  const { data: ensAddress } = useEnsAddress({
    name: normalizedName,
    chainId: 1,
    query: { enabled: !!normalizedName && !isAddr },
  });

  // If normalizedName is an ens name, get the ens avatar
  const { data: ensAvatar, isLoading } = useEnsAvatar({
    name: normalizedName,
    chainId: 1,
    query: { enabled: !!normalizedName },
  });
  const address = ensAddress ?? addressOrEns;
  const src = useMemo(() => {
    if (isLoading) return undefined;
    if (ensAvatar) return ensAvatar;
    if (!isLoading && isAddress(address)) return makeBlockie(address);
    return undefined;
  }, [ensAvatar, address, isLoading]);

  return (
    <Avatar title={title} className={cn("rounded-sm", className)}>
      <AvatarImage src={src} alt="" />
      <AvatarFallback className="bg-gray-600" />
    </Avatar>
  );
}

export default AddressAvatar;
