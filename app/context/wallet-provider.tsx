import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PropsWithChildren } from "react";
import { type State, WagmiProvider } from "wagmi";
import { E2EAutoConnect } from "~/components/mock-wallet";
import { WALLETCONNECT_CONFIG } from "../utils/wallet";

interface Props extends PropsWithChildren {
  initialState?: State;
}

const queryClient = new QueryClient();

export function WalletProvider(props: Props) {
  return (
    <WagmiProvider config={WALLETCONNECT_CONFIG} initialState={props.initialState}>
      <QueryClientProvider client={queryClient}>
        <E2EAutoConnect />
        {props.children}
      </QueryClientProvider>
    </WagmiProvider>
  );
}
