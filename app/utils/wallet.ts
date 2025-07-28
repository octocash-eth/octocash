import "@rainbow-me/rainbowkit/styles.css";
import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import { createPublicClient, type Chain } from "viem";
import { type Config, createConfig, http } from "wagmi";
import { mainnet, avalanche, optimism, arbitrum, base, polygon, unichain, linea } from "wagmi/chains";
import { SITE_NAME } from "../data/site";

export const WALLETCONNECT_PROJECT_ID = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID ?? "";

if (!WALLETCONNECT_PROJECT_ID) {
  console.warn("You need to provide a VITE_WALLETCONNECT_PROJECT_ID env variable");
}

export const WALLETCONNECT_CONFIG: Config = getDefaultConfig({
  appName: SITE_NAME,
  projectId: WALLETCONNECT_PROJECT_ID || "dummy",
  chains: [mainnet, avalanche, optimism, arbitrum, base, polygon, linea],
  ssr: false,
});

export const mainnetConfig = createConfig({
  chains: [mainnet],
  transports: {
    [mainnet.id]: http(),
  },
});

export const publicClient = createPublicClient({
  chain: mainnet,
  transport: http(),
}); // Use this to get ENS addresses
