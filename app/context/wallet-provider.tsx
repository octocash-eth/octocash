import { type AvatarComponent, darkTheme, lightTheme, RainbowKitProvider } from "@rainbow-me/rainbowkit";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type PropsWithChildren, useEffect, useState } from "react";
import colors from "tailwindcss/colors";
import { type State, WagmiProvider } from "wagmi";
import { AddressAvatar } from "~/components/address";
import { E2EAutoConnect } from "~/components/mock-wallet";
import { useTheme } from "~/components/theme";
import { WALLETCONNECT_CONFIG } from "../utils/wallet";

interface Props extends PropsWithChildren {
  initialState?: State;
}

const queryClient = new QueryClient();

const CustomAvatar: AvatarComponent = ({ address }: { address: string }) => {
  return <AddressAvatar addressOrEns={address} className="size-4" />;
};

function RainbowKitThemeWrapper({ children }: PropsWithChildren) {
  const { resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  // Only apply theme after first client render to avoid hydration mismatch
  useEffect(() => {
    setMounted(true);
  }, []);

  // In test environment, skip RainbowKit to avoid lingering timers
  if (import.meta.env.VITEST) {
    return <>{children}</>;
  }

  // Use light theme as default for SSR and first render
  const themeToUse = !mounted ? "light" : resolvedTheme;

  const theme =
    themeToUse === "dark"
      ? darkTheme({
          accentColor: colors.pink[500],
          accentColorForeground: colors.white,
          borderRadius: "small",
          fontStack: "system",
          overlayBlur: "small",
        })
      : lightTheme({
          accentColor: colors.pink[500],
          accentColorForeground: colors.white,
          borderRadius: "small",
          fontStack: "system",
          overlayBlur: "small",
        });
  theme.fonts.body = "var(--font-sans)";

  return (
    <RainbowKitProvider modalSize="compact" avatar={CustomAvatar} theme={theme}>
      {children}
    </RainbowKitProvider>
  );
}

export function WalletProvider(props: Props) {
  return (
    <WagmiProvider config={WALLETCONNECT_CONFIG} initialState={props.initialState}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitThemeWrapper>
          <E2EAutoConnect />
          {props.children}
        </RainbowKitThemeWrapper>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
