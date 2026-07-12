import { chains } from "~/data/supported-chains";

/** Human-readable chain name, with a stable fallback for unknown ids. */
export function chainNameOf(chainId: number): string {
  return chains[chainId as keyof typeof chains]?.name || `Chain ${chainId}`;
}

interface RefuelProgress {
  fromChainId: number;
  toChainId: number;
  delivered: boolean;
}

/**
 * Friendly stage line for a gas-top-up wait: names the destinations whose
 * refuel hasn't visibly landed yet (delivery is confirmed by the destination
 * wallet's native balance, so "delivered" is ground truth, not a bridge
 * status).
 */
export function refuelStageMessage(refuels: RefuelProgress[]): string {
  const pending = refuels.filter((r) => !r.delivered);
  if (pending.length === 0) {
    return refuels.length > 0 ? "Gas delivered ✓" : "Delivering gas…";
  }
  return `Delivering gas to ${pending.map((r) => chainNameOf(r.toChainId)).join(" + ")}…`;
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

/**
 * Friendly line for an Omnibridge wait. Exit = Gnosis→mainnet signature
 * collection on the AMB; enter = watching for the validators to mint the
 * bridged token (USDC.e or the destination token's twin) on Gnosis
 * (delivery is confirmed by the receiver's balance — ground truth).
 */
export function omnibridgeStageMessage(direction: "exit" | "enter", ready: number, total: number): string {
  if (direction === "exit") {
    if (total <= 1) return "Waiting for Omnibridge signatures…";
    return `Omnibridge messages signed ${ready}/${total}`;
  }
  if (total <= 1) return "Waiting for delivery on Gnosis…";
  return `Omnibridge deliveries received ${ready}/${total}`;
}
