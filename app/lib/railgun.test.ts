// @vitest-environment node
// (the engine's wasm/Buffer-heavy crypto trips over jsdom's foreign realm)

/**
 * Railgun unit tests.
 *
 * The shield path in railgun-shield.ts is a from-scratch port of the handful
 * of @railgun-community/engine primitives shielding needs (0zk codec, note
 * public key, ECDH shared key, AES-GCM/CTR bundle). These tests cross-verify
 * every primitive against the official engine (a dev-only dependency) so any
 * byte-level incompatibility fails CI.
 */

import { createRequire } from "node:module";
import path from "node:path";
import { ctr, gcm } from "@noble/ciphers/aes.js";
import type {
  ByteUtils as ByteUtilsType,
  RailgunEngine as RailgunEngineType,
  ShieldNoteERC20 as ShieldNoteERC20Type,
  ShieldNote as ShieldNoteType,
} from "@railgun-community/engine";
import { bytesToHex, hexToBytes, isAddress, parseUnits } from "viem";
import { beforeAll, describe, expect, test } from "vitest";
import {
  BPS_DENOMINATOR,
  getRailgunTokenOptions,
  LOW_PRIVACY_TVL_USD,
  RAILGUN_PROXY,
  RAILGUN_SHIELD_FEE_BPS,
  RAILGUN_SUPPORTED_CHAINS,
} from "~/data/railgun";
import { chains } from "~/data/supported-chains";
import { decodeRailgunAddress, getShieldedAmountAfterFee, isRailgunAddress, truncateRailgunAddress } from "./railgun";
import {
  buildShieldRequest,
  deriveShieldPrivateKey,
  getNotePublicKey,
  getSharedSymmetricKey,
  getShieldPrivateKeySignatureMessage,
  randomShieldPrivateKey,
} from "./railgun-shield";

// ============================================================================
// Engine loading (CJS package; keys-utils is not re-exported from the root,
// so it is loaded by file path)
// ============================================================================

let RailgunEngine: typeof RailgunEngineType;
let ShieldNoteERC20: typeof ShieldNoteERC20Type;
let ShieldNote: typeof ShieldNoteType;
let ByteUtils: typeof ByteUtilsType;
let engineKeysUtils: {
  getPublicViewingKey(privateKey: Uint8Array): Promise<Uint8Array>;
  getSharedSymmetricKey(
    privateKeyPairA: Uint8Array,
    blindedPublicKeyPairB: Uint8Array,
  ): Promise<Uint8Array | undefined>;
};

beforeAll(async () => {
  const engine = await import("@railgun-community/engine");
  ({ RailgunEngine, ShieldNoteERC20, ShieldNote, ByteUtils } = engine);
  // Poseidon is wasm-backed; make sure it is initialized before hashing.
  await (engine as unknown as { initPoseidonPromise?: Promise<void> }).initPoseidonPromise;

  const require_ = createRequire(import.meta.url);
  const engineDir = path.dirname(require_.resolve("@railgun-community/engine"));
  engineKeysUtils = require_(path.join(engineDir, "utils/keys-utils.js"));
});

// ============================================================================
// Deterministic fixtures
// ============================================================================

const MASTER_PUBLIC_KEY = 0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdefn;
const VIEWING_PRIVATE_KEY = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const SHIELD_PRIVATE_KEY = Uint8Array.from({ length: 32 }, (_, i) => 255 - i);
const NOTE_RANDOM = Uint8Array.from({ length: 16 }, (_, i) => i + 1);
const NOTE_RANDOM_HEX = bytesToHex(NOTE_RANDOM).slice(2);
const WETH_MAINNET = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" as const;

async function makeAddresses() {
  const viewingPublicKey = await engineKeysUtils.getPublicViewingKey(VIEWING_PRIVATE_KEY);
  return {
    viewingPublicKey,
    mainnetAddress: RailgunEngine.encodeAddress({
      masterPublicKey: MASTER_PUBLIC_KEY,
      viewingPublicKey,
      chain: { type: 0, id: 1 },
    }),
    allChainsAddress: RailgunEngine.encodeAddress({
      masterPublicKey: MASTER_PUBLIC_KEY,
      viewingPublicKey,
    }),
  };
}

// ============================================================================
// 0zk address codec
// ============================================================================

describe("decodeRailgunAddress", () => {
  test("decodes a chain-bound address encoded by the engine", async () => {
    const { viewingPublicKey, mainnetAddress } = await makeAddresses();

    const decoded = decodeRailgunAddress(mainnetAddress);
    expect(decoded.masterPublicKey).toBe(MASTER_PUBLIC_KEY);
    expect(bytesToHex(decoded.viewingPublicKey)).toBe(bytesToHex(viewingPublicKey));
    expect(decoded.chainId).toBe(1);
  });

  test("decodes an all-chains address as chainId undefined", async () => {
    const { allChainsAddress } = await makeAddresses();
    const decoded = decodeRailgunAddress(allChainsAddress);
    expect(decoded.masterPublicKey).toBe(MASTER_PUBLIC_KEY);
    expect(decoded.chainId).toBeUndefined();
  });

  test("throws on malformed input", async () => {
    const { mainnetAddress } = await makeAddresses();
    // Corrupt the bech32m checksum (flip the final character).
    const corrupted = mainnetAddress.slice(0, -1) + (mainnetAddress.endsWith("w") ? "q" : "w");
    expect(() => decodeRailgunAddress(corrupted)).toThrow();
    expect(() => decodeRailgunAddress("0zk1notanaddress")).toThrow();
    expect(() => decodeRailgunAddress("")).toThrow();
  });
});

describe("isRailgunAddress", () => {
  test("accepts engine-encoded addresses", async () => {
    const { mainnetAddress, allChainsAddress } = await makeAddresses();
    expect(isRailgunAddress(mainnetAddress)).toBe(true);
    expect(isRailgunAddress(allChainsAddress)).toBe(true);
  });

  test("rejects non-railgun values", async () => {
    const { mainnetAddress } = await makeAddresses();
    expect(isRailgunAddress(undefined)).toBe(false);
    expect(isRailgunAddress(null)).toBe(false);
    expect(isRailgunAddress("")).toBe(false);
    expect(isRailgunAddress("0x1234567890123456789012345678901234567890")).toBe(false);
    expect(isRailgunAddress("vitalik.eth")).toBe(false);
    expect(isRailgunAddress(mainnetAddress.slice(0, -1))).toBe(false);
  });
});

describe("truncateRailgunAddress", () => {
  test("keeps prefix and suffix", async () => {
    const { mainnetAddress } = await makeAddresses();
    const truncated = truncateRailgunAddress(mainnetAddress);
    expect(truncated.startsWith(mainnetAddress.slice(0, 9))).toBe(true);
    expect(truncated.endsWith(mainnetAddress.slice(-4))).toBe(true);
    expect(truncated.length).toBeLessThan(20);
  });
});

// ============================================================================
// Fee math
// ============================================================================

describe("getShieldedAmountAfterFee", () => {
  test("applies the 0.25% protocol fee", () => {
    expect(RAILGUN_SHIELD_FEE_BPS).toBe(25n);
    expect(getShieldedAmountAfterFee(10_000n)).toBe(9_975n);
    expect(getShieldedAmountAfterFee(parseUnits("1", 18))).toBe(parseUnits("0.9975", 18));
    expect(getShieldedAmountAfterFee(1_000_000n)).toBe(997_500n);
  });

  test("rounds the fee down (in the user's favor)", () => {
    // 399 * 25 / 10000 = 0.9975 → fee 0
    expect(getShieldedAmountAfterFee(399n)).toBe(399n);
    expect(getShieldedAmountAfterFee(400n)).toBe(399n);
  });
});

// ============================================================================
// Config sanity
// ============================================================================

describe("railgun config", () => {
  test("supported chains are a subset of app chains and have proxies", () => {
    const appChainIds = Object.keys(chains).map(Number);
    for (const chainId of RAILGUN_SUPPORTED_CHAINS) {
      expect(appChainIds).toContain(chainId);
      expect(RAILGUN_PROXY[chainId]).toMatch(/^0x[0-9a-fA-F]{40}$/);
    }
  });

  test("proxy addresses carry a valid EIP-55 checksum (viem rejects bad ones at call time)", () => {
    for (const [chainId, proxy] of Object.entries(RAILGUN_PROXY)) {
      expect(isAddress(proxy, { strict: true }), `RAILGUN_PROXY[${chainId}] = ${proxy}`).toBe(true);
    }
  });

  test("recommended tokens are WETH/USDC/WBTC on supported chains, none elsewhere", () => {
    for (const chainId of RAILGUN_SUPPORTED_CHAINS) {
      const symbols = getRailgunTokenOptions(chainId).map((t) => t.symbol);
      expect(symbols).toEqual(["WETH", "USDC", "WBTC"]);
    }
    expect(getRailgunTokenOptions(8453)).toEqual([]); // Base: no Railgun
  });

  test("low-privacy threshold is $1M", () => {
    expect(LOW_PRIVACY_TVL_USD).toBe(1_000_000);
    expect(BPS_DENOMINATOR).toBe(10_000n);
  });
});

// ============================================================================
// Shield private key sourcing
// ============================================================================

describe("shield private key sourcing", () => {
  test("deriveShieldPrivateKey = keccak256 of the RAILGUN_SHIELD signature (SDK convention)", async () => {
    const account = "0x1111111111111111111111111111111111111111" as const;
    const signer = {
      signMessage: async ({ message }: { account: `0x${string}`; message: string }) => {
        expect(message).toBe(getShieldPrivateKeySignatureMessage());
        return "0xdeadbeef" as const;
      },
    };
    const key = await deriveShieldPrivateKey(signer, account);
    // keccak256("0xdeadbeef")
    expect(key).toBe("0xd4fd4e189132273036449fc9e11198c739161b4c0116a9a2dccdfa1c492006f1");
  });

  test("randomShieldPrivateKey yields distinct 32-byte keys usable by buildShieldRequest", () => {
    const a = randomShieldPrivateKey();
    const b = randomShieldPrivateKey();
    expect(a).toMatch(/^0x[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });
});

// ============================================================================
// Shield request construction (cross-verified against the engine)
// ============================================================================

describe("buildShieldRequest", () => {
  test("signature message matches the engine constant", () => {
    expect(getShieldPrivateKeySignatureMessage()).toBe(ShieldNote.getShieldPrivateKeySignatureMessage());
  });

  test("note public key matches the engine", () => {
    const engineNpk = ShieldNote.getNotePublicKey(MASTER_PUBLIC_KEY, NOTE_RANDOM_HEX);
    expect(getNotePublicKey(MASTER_PUBLIC_KEY, NOTE_RANDOM)).toBe(engineNpk);
  });

  test("ECDH shared key matches the engine", async () => {
    const { viewingPublicKey } = await makeAddresses();
    const engineShared = await engineKeysUtils.getSharedSymmetricKey(SHIELD_PRIVATE_KEY, viewingPublicKey);
    expect(engineShared).toBeDefined();
    expect(bytesToHex(getSharedSymmetricKey(SHIELD_PRIVATE_KEY, viewingPublicKey))).toBe(
      bytesToHex(engineShared as Uint8Array),
    );
  });

  test("produces a request the engine can decrypt, matching its own serialization", async () => {
    const { viewingPublicKey, mainnetAddress } = await makeAddresses();
    const value = parseUnits("1", 18);

    const ours = buildShieldRequest(mainnetAddress, WETH_MAINNET, value, bytesToHex(SHIELD_PRIVATE_KEY), {
      noteRandom: NOTE_RANDOM,
    });

    const engineNote = new ShieldNoteERC20(MASTER_PUBLIC_KEY, NOTE_RANDOM_HEX, value, WETH_MAINNET);
    const engineRequest = await engineNote.serialize(SHIELD_PRIVATE_KEY, viewingPublicKey);

    // Deterministic fields must match byte-for-byte.
    expect(ours.preimage.npk).toBe(engineRequest.preimage.npk);
    expect(ours.preimage.token.tokenAddress.toLowerCase()).toBe(
      (engineRequest.preimage.token.tokenAddress as string).toLowerCase(),
    );
    expect(ours.preimage.token.tokenType).toBe(0);
    expect(ours.preimage.value).toBe(value);
    expect(ours.ciphertext.shieldKey).toBe(engineRequest.ciphertext.shieldKey);

    // The encrypted bundle uses random IVs, so cross-verify by decryption:
    // the ENGINE must recover the note random from OUR bundle.
    const sharedKey = getSharedSymmetricKey(SHIELD_PRIVATE_KEY, viewingPublicKey);
    const decryptedRandom = ShieldNote.decryptRandom(
      [...ours.ciphertext.encryptedBundle] as [string, string, string],
      sharedKey,
    );
    expect(ByteUtils.hexlify(decryptedRandom)).toBe(NOTE_RANDOM_HEX);
  });

  test("decrypts the engine's bundle with our primitives (GCM + CTR)", async () => {
    const { viewingPublicKey } = await makeAddresses();
    const value = parseUnits("0.5", 18);

    const engineNote = new ShieldNoteERC20(MASTER_PUBLIC_KEY, NOTE_RANDOM_HEX, value, WETH_MAINNET);
    const engineRequest = await engineNote.serialize(SHIELD_PRIVATE_KEY, viewingPublicKey);
    const [bundle0, bundle1, bundle2] = engineRequest.ciphertext.encryptedBundle.map((b) =>
      hexToBytes(b as `0x${string}`),
    );

    // bundle0 = gcmIv(16) ‖ gcmTag(16); bundle1 = gcmCiphertext(16) ‖ ctrIv(16);
    // bundle2 = ctrCiphertext(32)
    const sharedKey = getSharedSymmetricKey(SHIELD_PRIVATE_KEY, viewingPublicKey);
    const gcmPayload = new Uint8Array([...bundle1.slice(0, 16), ...bundle0.slice(16, 32)]);
    const recoveredRandom = gcm(sharedKey, bundle0.slice(0, 16)).decrypt(gcmPayload);
    expect(bytesToHex(recoveredRandom).slice(2)).toBe(NOTE_RANDOM_HEX);

    const recoveredViewingKey = ctr(SHIELD_PRIVATE_KEY, bundle1.slice(16, 32)).decrypt(bundle2);
    expect(bytesToHex(recoveredViewingKey)).toBe(bytesToHex(viewingPublicKey));
  });

  test("rejects invalid amounts and keys", async () => {
    const { mainnetAddress } = await makeAddresses();
    const key = bytesToHex(SHIELD_PRIVATE_KEY);
    expect(() => buildShieldRequest(mainnetAddress, WETH_MAINNET, 0n, key)).toThrow(/positive/);
    expect(() => buildShieldRequest(mainnetAddress, WETH_MAINNET, -1n, key)).toThrow(/positive/);
    expect(() => buildShieldRequest(mainnetAddress, WETH_MAINNET, 1n << 120n, key)).toThrow(/uint120/);
    expect(() => buildShieldRequest(mainnetAddress, WETH_MAINNET, 1n, "0x1234")).toThrow(/32 bytes/);
  });
});
