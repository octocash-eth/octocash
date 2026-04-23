import { type Chain, http } from "viem";
import type { Config } from "wagmi";
import { createConfig } from "wagmi";
import { injected, walletConnect } from "wagmi/connectors";
import { createE2EConfig } from "~/components/mock-wallet";
import { SITE_LOGO, SITE_NAME, SITE_URL } from "../data/site";
import { chains, transports } from "../data/supported-chains";

export const WALLETCONNECT_PROJECT_ID = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID ?? "";
export const HAS_WALLETCONNECT_PROJECT_ID = WALLETCONNECT_PROJECT_ID.length > 0;

if (!HAS_WALLETCONNECT_PROJECT_ID && !import.meta.env.VITE_E2E && !import.meta.env.VITEST) {
  console.warn("WalletConnect is disabled because VITE_WALLETCONNECT_PROJECT_ID is missing.");
}

const walletChains = Object.values(chains) as unknown as readonly [Chain, ...Chain[]];
const walletTransports = Object.fromEntries(
  walletChains.map((chain) => [chain.id, transports?.[chain.id as keyof NonNullable<typeof transports>] ?? http()]),
) as Record<(typeof walletChains)[number]["id"], ReturnType<typeof http>>;

export const WALLETCONNECT_CONFIG: Config =
  import.meta.env.VITE_E2E || import.meta.env.VITEST
    ? createE2EConfig()
    : createConfig({
        chains: walletChains,
        connectors: [
          injected(),
          ...(HAS_WALLETCONNECT_PROJECT_ID
            ? [
                walletConnect({
                  projectId: WALLETCONNECT_PROJECT_ID,
                  metadata: {
                    name: SITE_NAME,
                    description: SITE_NAME,
                    url: SITE_URL,
                    icons: [SITE_LOGO],
                  },
                  showQrModal: false,
                }),
              ]
            : []),
        ],
        transports: walletTransports,
        ssr: true,
      });
