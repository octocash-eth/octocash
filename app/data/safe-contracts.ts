import type { Address } from "viem";
import { arbitrum, base, gnosis, linea, mainnet, optimism, polygon, unichain } from "viem/chains";

/**
 * Canonical MultiSendCallOnly deployments, keyed by Safe contract version.
 * Unlike plain MultiSend, the CallOnly variant rejects inner delegatecalls, so
 * a batched consolidation step can never be tricked into executing arbitrary
 * code in the Safe's context. Both addresses are the deterministic deployments
 * used on every chain we support.
 *
 * See https://github.com/safe-global/safe-deployments.
 */
export const MULTI_SEND_CALL_ONLY: Record<string, Address> = {
  "1.3.0": "0x40A2aCCbd92BCA938b02010E17A5b8929b49130D",
  "1.4.1": "0x9641d764fc13c8B624c04430C7356C1C7C8102e2",
};

/**
 * Resolves the MultiSendCallOnly address for a Safe contract version string
 * (e.g. "1.3.0", "1.4.1", or a "1.4.1+L2" style suffix). Versions at or above
 * 1.4.1 use the 1.4.1 deployment; 1.3.x uses the 1.3.0 one. Older Safes
 * (<1.3.0) are unsupported (their EIP-712 domain also differs).
 */
export function multiSendCallOnlyFor(safeVersion: string): Address {
  const [major = 0, minor = 0, patch = 0] = safeVersion
    .split("+")[0]
    .split(".")
    .map((p) => Number.parseInt(p, 10));
  if (major !== 1 || minor < 3) {
    throw new Error(`Unsupported Safe version ${safeVersion}: only Safe >=1.3.0 is supported`);
  }
  if (minor > 4 || (minor === 4 && patch >= 1)) {
    return MULTI_SEND_CALL_ONLY["1.4.1"];
  }
  return MULTI_SEND_CALL_ONLY["1.3.0"];
}

/**
 * Safe Transaction Service identifiers on the consolidated
 * `api.safe.global/tx-service/{slug}` hosts, per the Config Service
 * (https://safe-config.safe.global/api/v1/chains/). All 8 supported chains
 * have a hosted service. Note Polygon's service slug is "pol" while its Safe
 * app shortName is still "matic" — two separate maps below.
 */
export const SAFE_TX_SERVICE_SLUG: Record<number, string> = {
  [mainnet.id]: "eth",
  [optimism.id]: "oeth",
  [arbitrum.id]: "arb1",
  [base.id]: "base",
  [polygon.id]: "pol",
  [unichain.id]: "unichain",
  [linea.id]: "linea",
  [gnosis.id]: "gno",
};

/** EIP-3770 shortNames used by app.safe.global URLs (`{shortName}:{address}`). */
const SAFE_APP_SHORT_NAME: Record<number, string> = {
  [mainnet.id]: "eth",
  [optimism.id]: "oeth",
  [arbitrum.id]: "arb1",
  [base.id]: "base",
  [polygon.id]: "matic",
  [unichain.id]: "unichain",
  [linea.id]: "linea",
  [gnosis.id]: "gno",
};

/** Deep link into the Safe{Wallet} transaction queue for a Safe on a chain. */
export function safeAppQueueUrl(chainId: number, safe: Address): string | undefined {
  const shortName = SAFE_APP_SHORT_NAME[chainId];
  if (!shortName) return undefined;
  return `https://app.safe.global/transactions/queue?safe=${shortName}:${safe}`;
}
