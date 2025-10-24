import { type AvatarComponent, lightTheme, RainbowKitProvider } from "@rainbow-me/rainbowkit";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PropsWithChildren } from "react";
import colors from "tailwindcss/colors";
import { type State, WagmiProvider } from "wagmi";
import { E2EAutoConnect } from "~/components/mock-wallet";
import AddressAvatar from "../components/address-avatar";
import { WALLETCONNECT_CONFIG } from "../utils/wallet";

interface Props extends PropsWithChildren {
  initialState?: State;
}

const queryClient = new QueryClient();

const CustomAvatar: AvatarComponent = ({ address }: { address: string }) => {
  return <AddressAvatar addressOrEns={address} className="size-4" />;
};

export function WalletProvider(props: Props) {
  return (
    <WagmiProvider config={WALLETCONNECT_CONFIG} initialState={props.initialState}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider
          modalSize="compact"
          avatar={CustomAvatar}
          theme={lightTheme({
            accentColor: colors.red[600],
            accentColorForeground: colors.amber[900],
            borderRadius: "small",
            fontStack: "system",
            overlayBlur: "small",
          })}
        >
          <E2EAutoConnect />
          {props.children}
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
