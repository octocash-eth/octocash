import { chains } from "~/data/supported-chains";
import type { LiFiStatusResponse } from "./lifi";

/** Human-readable chain name, with a stable fallback for unknown ids. */
export function chainNameOf(chainId: number): string {
  return chains[chainId as keyof typeof chains]?.name || `Chain ${chainId}`;
}

interface LiFiTransferProgress {
  fromChainId: number;
  toChainId: number;
  status: LiFiStatusResponse;
}

// Advancement rank — lowest wins so the displayed stage reflects the laggard
// across destinations (the wait isn't over until the slowest leg lands).
function rank(substatus?: string): number {
  if (substatus === "WAIT_SOURCE_CONFIRMATIONS") return 0;
  if (substatus === "WAIT_DESTINATION_TRANSACTION") return 2;
  return 1; // PENDING w/ no/unknown substatus, BRIDGE/CHAIN_NOT_AVAILABLE, etc.
}

/**
 * Friendly bridge-stage line for a gas-top-up wait, derived from the
 * least-advanced LI.FI transfer among all destinations.
 */
export function lifiStageMessage(transfers: LiFiTransferProgress[]): string {
  const slowest = transfers.reduce<LiFiTransferProgress | undefined>(
    (acc, t) => (acc === undefined || rank(t.status.substatus) < rank(acc.status.substatus) ? t : acc),
    undefined,
  );
  const sub = slowest?.status.substatus;
  if (sub === "WAIT_SOURCE_CONFIRMATIONS" && slowest) return `Confirming on ${chainNameOf(slowest.fromChainId)}…`;
  if (sub === "WAIT_DESTINATION_TRANSACTION" && slowest) return `Bridging to ${chainNameOf(slowest.toChainId)}…`;
  if (sub === "REFUND_IN_PROGRESS") return "Refund in progress…";
  if (sub === "BRIDGE_NOT_AVAILABLE" || sub === "CHAIN_NOT_AVAILABLE") return "Waiting for bridge…";
  return "Bridging…";
}

/**
 * Friendly line for a CCTP attestation wait. Circle exposes no intermediate
 * substatus, so for a single source we just say we're waiting; for a
 * multi-source consolidation the meaningful signal is how many of the N
 * attestations have landed.
 */
export function attestationStageMessage(received: number, total: number): string {
  if (total <= 1) return "Waiting for Circle attestation…";
  return `Attestations received ${received}/${total}`;
}
