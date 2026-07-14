import type { Address, Hex } from "viem";
import { SAFE_TX_SERVICE_SLUG } from "~/data/safe-contracts";

/**
 * Hand-rolled client for the Safe Transaction Service REST API. The service is
 * deployed per network on `api.safe.global/tx-service/{slug}`; reads work
 * anonymously, and `VITE_SAFE_API_KEY` is attached when set to lift rate
 * limits. Chains without a hosted service (none of ours today) simply report
 * "no deployments" — callers must fail closed and never route a Safe through
 * a chain the service couldn't verify.
 */

export interface SafeInfo {
  address: Address;
  owners: Address[];
  threshold: number;
  nonce: number;
  version: string;
}

export interface SafeServiceConfirmation {
  owner: Address;
  signature: Hex;
  signatureType: string;
}

export interface SafeServiceTx {
  safeTxHash: Hex;
  nonce: number;
  to: Address;
  value: string;
  data: Hex | null;
  operation: 0 | 1;
  isExecuted: boolean;
  isSuccessful: boolean | null;
  /** On-chain execution tx hash, populated once someone executes the proposal. */
  transactionHash: Hex | null;
  confirmations: SafeServiceConfirmation[];
  confirmationsRequired: number;
}

/** Payload for proposing a multisig transaction, mirroring the POST body. */
export interface ProposeSafeTxPayload {
  to: Address;
  value: string;
  data: Hex;
  operation: 0 | 1;
  safeTxGas: string;
  baseGas: string;
  gasPrice: string;
  gasToken: Address;
  refundReceiver: Address;
  nonce: number;
  /** The safeTxHash — the service recomputes and rejects mismatches. */
  contractTransactionHash: Hex;
  /** Proposing owner (must have signed). */
  sender: Address;
  signature: Hex;
  origin?: string;
}

export function hasSafeTransactionService(chainId: number): boolean {
  return SAFE_TX_SERVICE_SLUG[chainId] !== undefined;
}

function serviceBase(chainId: number): string {
  const slug = SAFE_TX_SERVICE_SLUG[chainId];
  if (!slug) {
    throw new Error(`SafeServiceError: No Safe Transaction Service for chain ${chainId}`);
  }
  return `https://api.safe.global/tx-service/${slug}/api`;
}

function requestHeaders(json = false): HeadersInit {
  const headers: Record<string, string> = {};
  if (json) headers["Content-Type"] = "application/json";
  const apiKey = import.meta.env.VITE_SAFE_API_KEY;
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}

async function getJson<T>(url: string): Promise<T | null> {
  const response = await fetch(url, { headers: requestHeaders() });
  if (response.status === 404) return null;
  if (!response.ok) {
    // "ExternalAPIError:" prefix maps to the retryable EXTERNAL_API_ERROR code.
    throw new Error(`ExternalAPIError: Safe Transaction Service returned ${response.status} for ${url}`);
  }
  return (await response.json()) as T;
}

/** Addresses of Safes on `chainId` that list `owner` among their owners. */
export async function getSafesByOwner(chainId: number, owner: Address): Promise<Address[]> {
  const result = await getJson<{ safes: Address[] }>(`${serviceBase(chainId)}/v1/owners/${owner}/safes/`);
  return result?.safes ?? [];
}

/**
 * Current on-service state of a Safe on `chainId`, or null when the service
 * doesn't know the address there (not deployed, or not yet indexed).
 */
export async function getSafeInfo(chainId: number, safe: Address): Promise<SafeInfo | null> {
  const result = await getJson<{
    address: Address;
    owners: Address[];
    threshold: number;
    nonce: number | string;
    version: string | null;
  }>(`${serviceBase(chainId)}/v1/safes/${safe}/`);
  if (!result) return null;
  return {
    address: result.address,
    owners: result.owners,
    threshold: result.threshold,
    // The service returns nonce as a string on some deployments.
    nonce: Number(result.nonce),
    version: result.version ?? "unknown",
  };
}

/**
 * Proposes a multisig transaction so co-signers see it in their Safe queue.
 * Idempotent in practice: re-proposing the same payload yields the same
 * safeTxHash, and the service's "already exists" rejection is treated as
 * success so a crash between POST and local persistence is harmless.
 */
export async function proposeSafeTx(chainId: number, safe: Address, payload: ProposeSafeTxPayload): Promise<void> {
  const url = `${serviceBase(chainId)}/v1/safes/${safe}/multisig-transactions/`;
  const response = await fetch(url, {
    method: "POST",
    headers: requestHeaders(true),
    body: JSON.stringify(payload),
  });
  if (response.ok) return;

  const body = await response.text().catch(() => "");
  // 422 with a "already exists"/"duplicated" style message means the exact
  // proposal (same safeTxHash) is already on the service.
  if (response.status === 422 && /exist|duplicate/i.test(body)) return;
  throw new Error(`SafeServiceError: Proposing Safe transaction failed (${response.status}): ${body.slice(0, 300)}`);
}

/** Fetches a proposed/executed multisig transaction by its safeTxHash. */
export async function getSafeTx(chainId: number, safeTxHash: Hex): Promise<SafeServiceTx | null> {
  const result = await getJson<
    Omit<SafeServiceTx, "nonce" | "confirmations"> & {
      nonce: number | string;
      confirmations: SafeServiceConfirmation[] | null;
    }
  >(`${serviceBase(chainId)}/v1/multisig-transactions/${safeTxHash}/`);
  if (!result) return null;
  return { ...result, nonce: Number(result.nonce), confirmations: result.confirmations ?? [] };
}

/**
 * All proposals sitting at one Safe nonce — used to detect a rejection tx or a
 * competing proposal that will consume (or has consumed) our nonce.
 */
export async function getSafeTxsAtNonce(chainId: number, safe: Address, nonce: number): Promise<SafeServiceTx[]> {
  const result = await getJson<{
    results: (Omit<SafeServiceTx, "nonce" | "confirmations"> & {
      nonce: number | string;
      confirmations: SafeServiceConfirmation[] | null;
    })[];
  }>(`${serviceBase(chainId)}/v1/safes/${safe}/multisig-transactions/?nonce=${nonce}`);
  return (result?.results ?? []).map((r) => ({
    ...r,
    nonce: Number(r.nonce),
    confirmations: r.confirmations ?? [],
  }));
}

/**
 * Best-effort removal of a superseded proposal from co-signers' queues (e.g.
 * after re-proposing with fresh swap calldata at the same nonce). Requires an
 * EIP-712 DeleteRequest signature from the proposer; failures are swallowed —
 * the replacement proposal is what matters, a stale queue entry is cosmetic.
 */
export async function deleteSafeProposal(
  chainId: number,
  safeTxHash: Hex,
  signDeleteRequest: (safeTxHash: Hex, totp: number) => Promise<Hex>,
): Promise<boolean> {
  try {
    const totp = Math.floor(Date.now() / 3600 / 1000);
    const signature = await signDeleteRequest(safeTxHash, totp);
    const response = await fetch(`${serviceBase(chainId)}/v1/multisig-transactions/${safeTxHash}/`, {
      method: "DELETE",
      headers: requestHeaders(true),
      body: JSON.stringify({ safeTxHash, signature }),
    });
    return response.ok;
  } catch {
    return false;
  }
}
