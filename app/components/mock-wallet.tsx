import { mock as mockConnector } from "@wagmi/core";
import { useEffect } from "react";
import { http } from "viem";
import { mainnet } from "viem/chains";
import type { Config } from "wagmi";
import { createConfig, useConnect } from "wagmi";

export function createE2EConfig(): Config {
  const mock = mockConnector({
    // Vitalik's address for predictable ENS display in demos
    accounts: ["0xd8da6bf26964af9d7eed9e03e53415d37aa96045"],
  });

  return createConfig({
    chains: [mainnet],
    transports: { [mainnet.id]: http() },
    connectors: [mock],
    ssr: false,
  });
}

export function E2EAutoConnect() {
  const { connectors, connect, status } = useConnect();
  useEffect(() => {
    if (!import.meta.env.VITE_E2E) return;
    if (status !== "idle") return;
    const mock = connectors.find((c) => c.id === "mock");
    if (mock) connect({ connector: mock });
  }, [connectors, status, connect]);
  return null;
}
