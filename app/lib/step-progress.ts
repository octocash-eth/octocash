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

/**
 * Friendly line for a cross-chain swap delivery wait: Delora's adapter mints
 * or transfers the output on the destination chain, and delivery is confirmed
 * by the receiver's token balance — ground truth, no provider status API.
 */
export function crosschainStageMessage(chainId: number, ready: number, total: number): string {
  if (total <= 1) return `Waiting for delivery on ${chainNameOf(chainId)}…`;
  return `Deliveries received ${ready}/${total}`;
}

/**
 * Friendly line for the Safe submission lifecycle. The confirmations phase is
 * the long-lived one — it names how many co-signers have approved so the user
 * knows who they're waiting on (the plan pauses recoverable if it outlasts
 * the in-step wait budget).
 */
export function safeStageMessage(
  phase: "signing" | "proposed" | "confirmations" | "executing",
  confirmed: number,
  threshold: number,
): string {
  switch (phase) {
    case "signing":
      return "Sign the Safe transaction in your wallet…";
    case "proposed":
      return `Proposed to the Safe — awaiting co-signers ${confirmed}/${threshold}`;
    case "confirmations":
      return `Awaiting Safe co-signers ${confirmed}/${threshold}`;
    case "executing":
      return threshold > 1 ? "Threshold met — executing Safe transaction…" : "Executing Safe transaction…";
  }
}

/**
 * Friendly line for the ERC-4337 smart-wallet (EIP-5792) submission: one
 * approval popup in the wallet, then bundler inclusion. Sequential mode names
 * the sub-call position.
 */
export function smartStageMessage(phase: "sending" | "confirming", call?: { index: number; total: number }): string {
  const suffix = call && call.total > 1 ? ` (${call.index + 1}/${call.total})` : "";
  return phase === "sending"
    ? `Approve the batch in your smart wallet…${suffix}`
    : `Waiting for the wallet to confirm…${suffix}`;
}
