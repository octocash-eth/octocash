/**
 * Railgun shield-note construction and execution.
 *
 * Shielding moves an ERC20 from a public wallet into the RailgunSmartWallet
 * contract, credited to a private `0zk` address. It is a plain public
 * transaction — no ZK proof and no Railgun engine/merkle-tree sync needed —
 * so instead of pulling in the full @railgun-community/engine (LevelDB,
 * circomlibjs, wasm artifacts, node polyfills), this module ports the few
 * primitives shielding actually requires on top of audited dependencies
 * (@noble/*, poseidon-lite).
 *
 * Byte-for-byte compatibility with the official engine is locked down by
 * unit tests that cross-verify every primitive against
 * @railgun-community/engine (a dev dependency used only in tests). See
 * railgun.test.ts.
 *
 * This module is dynamically imported by the executor so the crypto stays
 * out of the main bundle. Lightweight helpers (address codec, fee math,
 * pool TVL) live in ./railgun.ts.
 */

import { ctr, gcm } from "@noble/ciphers/aes.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256, sha512 } from "@noble/hashes/sha2.js";
import { poseidon2 } from "poseidon-lite";
import {
  type Address,
  bytesToHex,
  type Call,
  encodeFunctionData,
  getAddress,
  type Hex,
  hexToBytes,
  keccak256,
  parseAbi,
} from "viem";
import { RAILGUN_PROXY } from "~/data/railgun";
import { decodeRailgunAddress, getShieldedAmountAfterFee } from "./railgun";
import type { RetryHints, SendCallsFn } from "./send-calls";
import { buildERC20ApprovalCalls } from "./tokens";
import type { TokenAmount } from "./types";

/**
 * Fixed message an EOA signs to derive a `shieldPrivateKey`
 * (keccak256 of the signature). DO NOT MODIFY — matching the Railgun engine's
 * constant keeps sender-side re-derivation compatible with Railgun wallets
 * (recognizing one's own shield events later).
 *
 * Note the key is an EPHEMERAL ENCRYPTION KEY, not an authorization: its
 * public half is posted on-chain with the note, so the recipient decrypts via
 * ECDH(viewingPrivateKey, shieldKey) regardless of who generated it — any
 * 32-byte key works (see {@link randomShieldPrivateKey}).
 */
export function getShieldPrivateKeySignatureMessage(): string {
  return "RAILGUN_SHIELD";
}

const ED25519_ORDER = ed25519.Point.Fn.ORDER;

function bytesToBigInt(bytes: Uint8Array): bigint {
  return BigInt(bytesToHex(bytes));
}

/**
 * Converts an ed25519 private key into its X25519-compatible scalar:
 * sha512 → clamp (little-endian) → reduce mod curve order.
 * Port of engine's `getPrivateScalarFromPrivateKey`.
 */
function getPrivateScalar(privateKey: Uint8Array): bigint {
  if (privateKey.length !== 32) throw new Error("Expected 32-byte private key");
  const head = sha512(privateKey).slice(0, 32);
  head[0] &= 0b11111000;
  head[31] &= 0b01111111;
  head[31] |= 0b01000000;
  const scalar = bytesToBigInt(head.reverse()) % ED25519_ORDER;
  return scalar > 0n ? scalar : ED25519_ORDER;
}

/**
 * ECDH-style shared key between the shield private key and the recipient's
 * viewing public key: sha256(scalarA · pointB). Port of engine's
 * `getSharedSymmetricKey`.
 */
export function getSharedSymmetricKey(privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  const scalar = getPrivateScalar(privateKey);
  const preimage = ed25519.Point.fromBytes(publicKey).multiply(scalar).toBytes();
  return sha256(preimage);
}

/** Note public key: poseidon(masterPublicKey, random). */
export function getNotePublicKey(masterPublicKey: bigint, random16: Uint8Array): bigint {
  if (random16.length !== 16) throw new Error("Note random must be 16 bytes");
  return poseidon2([masterPublicKey, bytesToBigInt(random16)]);
}

/** ShieldRequest struct as accepted by RailgunSmartWallet.shield(). */
export interface ShieldRequest {
  preimage: {
    npk: Hex;
    token: { tokenType: number; tokenAddress: Address; tokenSubID: bigint };
    value: bigint;
  };
  ciphertext: {
    encryptedBundle: readonly [Hex, Hex, Hex];
    shieldKey: Hex;
  };
}

/** Test-only: lets tests pin the random IVs/note-random for determinism. */
export interface ShieldRandomness {
  noteRandom?: Uint8Array;
  gcmIv?: Uint8Array;
  ctrIv?: Uint8Array;
}

const MAX_UINT120 = (1n << 120n) - 1n;

function randomBytes16(): Uint8Array {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

/**
 * Builds the `ShieldRequest` for depositing `amount` of `tokenAddress` to
 * `railgunAddress`. Mirrors engine's `ShieldNoteERC20` + `serialize`:
 *
 * 1. npk = poseidon(masterPublicKey, random)
 * 2. sharedKey = ECDH(shieldPrivateKey, viewingPublicKey)
 * 3. AES-256-GCM(random, sharedKey) — recipient recovers `random` to spend
 * 4. AES-256-CTR(viewingPublicKey, shieldPrivateKey) — sender can recover the
 *    recipient address from the on-chain event
 * 5. shieldKey = ed25519 public key of shieldPrivateKey
 */
export function buildShieldRequest(
  railgunAddress: string,
  tokenAddress: Address,
  amount: bigint,
  shieldPrivateKey: Hex,
  randomness?: ShieldRandomness,
): ShieldRequest {
  if (amount <= 0n) throw new Error("Shield amount must be positive");
  if (amount > MAX_UINT120) throw new Error("Shield amount exceeds uint120");

  const { masterPublicKey, viewingPublicKey } = decodeRailgunAddress(railgunAddress);
  const privKey = hexToBytes(shieldPrivateKey);
  if (privKey.length !== 32) throw new Error("shieldPrivateKey must be 32 bytes");

  const noteRandom = randomness?.noteRandom ?? randomBytes16();
  const npk = getNotePublicKey(masterPublicKey, noteRandom);

  const sharedKey = getSharedSymmetricKey(privKey, viewingPublicKey);

  // AES-256-GCM over the 16-byte note random (16-byte IV, 16-byte tag).
  const gcmIv = randomness?.gcmIv ?? randomBytes16();
  const gcmOut = gcm(sharedKey, gcmIv).encrypt(noteRandom);
  const gcmCiphertext = gcmOut.slice(0, 16);
  const gcmTag = gcmOut.slice(16, 32);

  // AES-256-CTR over the 32-byte viewing public key, keyed by the shield key.
  const ctrIv = randomness?.ctrIv ?? randomBytes16();
  // slice(): noble's ctr cipher mutates the nonce buffer while counting.
  const ctrCiphertext = ctr(privKey, ctrIv.slice()).encrypt(viewingPublicKey);

  const shieldKey = ed25519.getPublicKey(privKey);

  const concat = (...parts: Uint8Array[]): Hex => {
    const total = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let offset = 0;
    for (const p of parts) {
      total.set(p, offset);
      offset += p.length;
    }
    return bytesToHex(total);
  };

  return {
    preimage: {
      npk: `0x${npk.toString(16).padStart(64, "0")}` as Hex,
      token: { tokenType: 0, tokenAddress: getAddress(tokenAddress), tokenSubID: 0n },
      value: amount,
    },
    ciphertext: {
      encryptedBundle: [concat(gcmIv, gcmTag), concat(gcmCiphertext, ctrIv), concat(ctrCiphertext)],
      shieldKey: bytesToHex(shieldKey),
    },
  };
}

// ============================================================================
// Contract interaction
// ============================================================================

export const railgunShieldAbi = parseAbi([
  "function shield(((bytes32 npk, (uint8 tokenType, address tokenAddress, uint256 tokenSubID) token, uint120 value) preimage, (bytes32[3] encryptedBundle, bytes32 shieldKey) ciphertext)[] _shieldRequests)",
]);

/**
 * Minimal signer surface needed to derive the shield private key. Matches
 * viem's WalletClient.
 */
export interface ShieldSigner {
  signMessage(args: { account: Address; message: string }): Promise<Hex>;
}

/**
 * Derives the shield private key from an EOA's deterministic personal_sign —
 * the Railgun SDK convention, letting that EOA re-derive the key later to
 * recognize its own shield events. `account` does NOT have to be the wallet
 * holding the funds: for a Safe depositor the connected owner EOA signs while
 * the Safe sends the shield transaction.
 */
export async function deriveShieldPrivateKey(signer: ShieldSigner, account: Address): Promise<Hex> {
  const signature = await signer.signMessage({ account, message: getShieldPrivateKeySignatureMessage() });
  return keccak256(signature);
}

/**
 * Random ephemeral shield private key, for depositors with no EOA in the
 * session (ERC-4337 wallets: their personal_sign is non-deterministic for
 * passkey signers and costs an extra popup). The recipient is unaffected —
 * the key's public half travels with the note — but the sender cannot
 * re-derive it for self-audit. Per-shield randomness also avoids linking a
 * sender's deposits through a reused on-chain shieldKey.
 */
export function randomShieldPrivateKey(): Hex {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

/**
 * Executes a shield: builds the note from the provided shield private key,
 * then sends `approve` (if needed) + `shield` through the standard sendCalls
 * pipeline (which routes by the holding wallet's account kind — a Safe
 * shields via one MultiSend, a smart wallet via an EIP-5792 bundle).
 *
 * @param input - Consolidated ERC20 (token/amount/chain/wallet) to shield.
 * @param railgunAddress - Recipient `0zk...` address.
 * @param shieldPrivateKey - 32-byte note-encryption key; see
 *   {@link deriveShieldPrivateKey} / {@link randomShieldPrivateKey}.
 * @param sendCalls - prepared sendCalls bound to the holding wallet's step.
 * @returns `[transactionHash, shieldedAmountAfterFee]`
 */
export async function executeRailgunShield(
  input: TokenAmount,
  railgunAddress: string,
  shieldPrivateKey: Hex,
  sendCalls: SendCallsFn,
  retryHints?: RetryHints,
): Promise<[string, bigint]> {
  const { chainId, token, amount, walletAddress } = input;

  const proxy = RAILGUN_PROXY[chainId];
  if (!proxy) throw new Error(`Railgun is not deployed on chain ${chainId}`);

  const decoded = decodeRailgunAddress(railgunAddress);
  if (decoded.chainId !== undefined && decoded.chainId !== chainId) {
    throw new Error(`Railgun address is bound to chain ${decoded.chainId}, cannot shield on chain ${chainId}`);
  }

  const request = buildShieldRequest(railgunAddress, token, amount, shieldPrivateKey);

  const approvalCalls = await buildERC20ApprovalCalls(input, proxy);
  const shieldCall: Call = {
    to: proxy,
    data: encodeFunctionData({
      abi: railgunShieldAbi,
      functionName: "shield",
      args: [
        [
          {
            preimage: request.preimage,
            ciphertext: {
              encryptedBundle: [...request.ciphertext.encryptedBundle] as [Hex, Hex, Hex],
              shieldKey: request.ciphertext.shieldKey,
            },
          },
        ],
      ],
    }),
  };

  const [transactionHash] = await sendCalls(
    "shield",
    chainId,
    walletAddress,
    [...approvalCalls, shieldCall],
    "atomic-steps",
    retryHints,
  );

  return [transactionHash, getShieldedAmountAfterFee(amount)];
}
