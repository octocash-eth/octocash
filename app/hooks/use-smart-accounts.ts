import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import type { Address } from "viem";
import { useWalletClient } from "wagmi";
import { chains } from "~/data/supported-chains";
import {
  type AtomicStatus,
  EIP7702_DELEGATION_PREFIX,
  type SmartAccount,
  type SmartChainDeployment,
} from "~/lib/accounts";
import { getPublicClient } from "~/lib/public-client";
import { useConnectedAddresses } from "./use-connected-addresses";

const SUPPORTED_CHAIN_IDS = Object.keys(chains).map(Number);

/** Per-chain capabilities as returned by wallet_getCapabilities (EIP-5792). */
export type CapabilitiesByChain = Record<number, { atomic?: { status: string } } | undefined>;

/**
 * Detects ERC-4337-style smart wallets among the CONNECTED addresses — unlike
 * Safe discovery there is nothing to look up (the account is the connection
 * itself): an address with non-7702 contract code on a chain is a smart
 * account deployment there. Capabilities (EIP-5792 atomic batching) come from
 * one `wallet_getCapabilities` round-trip; wallets that don't implement it
 * (or refuse for a non-active address) yield "unknown" ⇒ sequential sends.
 * Chains whose code probe fails are excluded — routing fails closed on
 * unverified chains, same doctrine as Safe discovery.
 */
export async function detectSmartAccounts(
  addresses: readonly Address[],
  fetchCapabilities: (address: Address) => Promise<CapabilitiesByChain | null>,
  now = Date.now(),
): Promise<SmartAccount[]> {
  if (addresses.length === 0) return [];

  const detected = await Promise.all(
    addresses.map(async (address): Promise<SmartAccount | null> => {
      const probes = await Promise.allSettled(
        SUPPORTED_CHAIN_IDS.map(async (chainId) => ({
          chainId,
          code: await getPublicClient(chainId).getCode({ address }),
        })),
      );

      const deployedChainIds: number[] = [];
      for (const probe of probes) {
        if (probe.status !== "fulfilled") continue;
        const { chainId, code } = probe.value;
        const hasCode = code !== undefined && code !== "0x";
        // 7702-delegated EOAs stay EOAs: same address everywhere, original
        // key signs — never classified as smart accounts.
        if (hasCode && !code.toLowerCase().startsWith(EIP7702_DELEGATION_PREFIX)) {
          deployedChainIds.push(chainId);
        }
      }
      if (deployedChainIds.length === 0) return null; // plain EOA — no map entry

      const capabilities = await fetchCapabilities(address).catch(() => null);
      const deployments: Record<number, SmartChainDeployment> = {};
      for (const chainId of deployedChainIds) {
        const status = capabilities?.[chainId]?.atomic?.status;
        const atomic: AtomicStatus =
          status === "supported" || status === "ready" || status === "unsupported" ? status : "unknown";
        deployments[chainId] = { chainId, atomic };
      }

      return { kind: "smart", address, deployments, fetchedAt: now };
    }),
  );

  return detected.filter((account): account is SmartAccount => account !== null);
}

export function useSmartAccounts(): { smartAccounts: SmartAccount[]; isLoading: boolean } {
  const addresses = useConnectedAddresses();
  const { data: walletClient } = useWalletClient();

  const addressesKey = useMemo(
    () =>
      Array.from(addresses)
        .map((address) => address.toLowerCase())
        .sort()
        .join(","),
    [addresses],
  );
  const connectorId = walletClient?.transport?.name ?? walletClient?.key ?? "";

  const query = useQuery({
    queryKey: ["smart-accounts", addressesKey, connectorId],
    queryFn: () =>
      detectSmartAccounts(addresses, async (address) => {
        if (!walletClient) return null;
        // wallet_getCapabilities is optional (EIP-5792); absence or refusal
        // just means no atomic batching — never let it hide a deployment.
        const capabilities = await walletClient.getCapabilities({ account: address });
        return capabilities as CapabilitiesByChain;
      }),
    enabled: addresses.length > 0 && walletClient !== undefined,
    staleTime: 60_000,
  });

  return { smartAccounts: query.data ?? [], isLoading: query.isLoading };
}
