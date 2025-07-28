import { useAccount } from "wagmi";

export function useConnectedAddresses() {
  const { addresses, isConnected } = useAccount();
  return isConnected && addresses ? addresses : [];
}
