import "@rainbow-me/rainbowkit/styles.css";
import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import type { Chain } from "viem";
import type { Config } from "wagmi";
import { createE2EConfig } from "~/components/mock-wallet";
import { SITE_NAME } from "../data/site";
import { chains, transports } from "../data/supported-chains";

export const WALLETCONNECT_PROJECT_ID = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID ?? "";

if (!WALLETCONNECT_PROJECT_ID && !import.meta.env.VITE_E2E && !import.meta.env.VITEST) {
  console.warn("You need to provide a VITE_WALLETCONNECT_PROJECT_ID env variable");
}

export const WALLETCONNECT_CONFIG: Config =
  import.meta.env.VITE_E2E || import.meta.env.VITEST
    ? createE2EConfig()
    : getDefaultConfig({
        appName: SITE_NAME,
        projectId: WALLETCONNECT_PROJECT_ID || "dummy",
        chains: Object.values(chains) as unknown as readonly [Chain, ...Chain[]],
        transports,
        ssr: true,
      });
