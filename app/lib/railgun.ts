/**
 * Light Railgun helpers: 0zk address codec, shield fee math, and pool-TVL
 * reads. Safe to import statically (UI + planning) — no crypto dependencies
 * beyond bech32m. The shield-note construction and execution live in
 * ./railgun-shield.ts, which is dynamically imported at execution time.
 */

import { bech32m } from "@scure/base";
import { type Address, bytesToHex, erc20Abi } from "viem";
import { BPS_DENOMINATOR, RAILGUN_PROXY, RAILGUN_SHIELD_FEE_BPS } from "~/data/railgun";
import { getPublicClient, retryOnRateLimit } from "./public-client";

// ============================================================================
// 0zk address codec (bech32m, prefix "0zk", 73-byte payload)
// ============================================================================

const RAILGUN_ADDRESS_PREFIX = "0zk";
const RAILGUN_ADDRESS_LENGTH_LIMIT = 127;
const RAILGUN_ADDRESS_VERSION = 1;
/** Payload: version(1) ‖ masterPublicKey(32) ‖ networkID(8) ‖ viewingPublicKey(32). */
const RAILGUN_ADDRESS_BYTES = 73;
/** networkID is XORed with "railgun" (7 bytes) purely to make addresses prettier. */
const NETWORK_ID_XOR_MASK = new TextEncoder().encode("railgun");
const ALL_CHAINS_NETWORK_ID_HEX = "ffffffffffffffff";

export interface RailgunAddressData {
  masterPublicKey: bigint;
  /** 32-byte ed25519 viewing public key. */
  viewingPublicKey: Uint8Array;
  /** EVM chain the address is bound to, or undefined for all-chains addresses. */
  chainId?: number;
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  return BigInt(bytesToHex(bytes));
}

function xorNetworkId(networkId: Uint8Array): Uint8Array {
  const out = new Uint8Array(networkId);
  for (let i = 0; i < Math.min(out.length, NETWORK_ID_XOR_MASK.length); i++) {
    out[i] ^= NETWORK_ID_XOR_MASK[i];
  }
  return out;
}

/**
 * Decodes a Railgun `0zk...` address into its key material.
 * @throws on any malformed input (bad prefix, checksum, version, length).
 */
export function decodeRailgunAddress(address: string): RailgunAddressData {
  const decoded = bech32m.decode(address as `${string}1${string}`, RAILGUN_ADDRESS_LENGTH_LIMIT);
  if (decoded.prefix !== RAILGUN_ADDRESS_PREFIX) {
    throw new Error("Invalid Railgun address prefix");
  }
  const data = bech32m.fromWords(decoded.words);
  if (data.length !== RAILGUN_ADDRESS_BYTES) {
    throw new Error("Invalid Railgun address length");
  }
  if (data[0] !== RAILGUN_ADDRESS_VERSION) {
    throw new Error("Unsupported Railgun address version");
  }

  const masterPublicKey = bytesToBigInt(data.slice(1, 33));
  const networkId = xorNetworkId(data.slice(33, 41));
  const viewingPublicKey = data.slice(41, 73);

  const networkIdHex = bytesToHex(networkId).slice(2);
  let chainId: number | undefined;
  if (networkIdHex !== ALL_CHAINS_NETWORK_ID_HEX) {
    const chainType = Number.parseInt(networkIdHex.slice(0, 2), 16);
    if (chainType !== 0) {
      throw new Error("Unsupported Railgun chain type");
    }
    chainId = Number.parseInt(networkIdHex.slice(2), 16);
  }

  return { masterPublicKey, viewingPublicKey, chainId };
}

/** True when `value` is a well-formed Railgun `0zk...` address. */
export function isRailgunAddress(value: string | undefined | null): value is string {
  if (!value?.startsWith(RAILGUN_ADDRESS_PREFIX)) return false;
  try {
    decodeRailgunAddress(value);
    return true;
  } catch {
    return false;
  }
}

/** "0zk1qyqjx…wj8" style truncation for display. */
export function truncateRailgunAddress(address: string): string {
  if (address.length <= 16) return address;
  return `${address.slice(0, 9)}…${address.slice(-4)}`;
}

// ============================================================================
// Fees and pool TVL
// ============================================================================

/** Net amount credited to the 0zk address after the 0.25% protocol fee. */
export function getShieldedAmountAfterFee(amount: bigint): bigint {
  return amount - (amount * RAILGUN_SHIELD_FEE_BPS) / BPS_DENOMINATOR;
}

/**
 * Total of `token` held by the RailgunSmartWallet proxy on `chainId` — the
 * shielded pool's TVL in token units. Used for the low-privacy-pool warning.
 */
export async function getRailgunPoolBalance(chainId: number, token: Address): Promise<bigint> {
  const proxy = RAILGUN_PROXY[chainId];
  if (!proxy) throw new Error(`Railgun is not deployed on chain ${chainId}`);
  const client = getPublicClient(chainId);
  return retryOnRateLimit(() =>
    client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [proxy] }),
  );
}
