import type { Call } from "viem";
import { describe, expect, test, vi } from "vitest";
import { MULTI_SEND_CALL_ONLY, multiSendCallOnlyFor, safeAppQueueUrl } from "~/data/safe-contracts";
import {
  approvedHashSignature,
  buildSafeTx,
  encodeExecTransaction,
  encodeMultiSendTransactions,
  hashSafeTx,
  isOwnerOf,
  signSafeTx,
} from "./safe";

// Golden vector: a real executed multiSend transaction of mainnet Safe
// 0x8CF6…D1D1 (v1.3.0) at nonce 66, fetched from the Safe Transaction Service:
// https://api.safe.global/tx-service/eth/api/v1/multisig-transactions/0x10e5a5fd6fce284b5c52adeb98830fd78ef8e26eeba363ce8d49aa0d62556f86/
const GOLDEN_SAFE = "0x8CF60B289f8d31F737049B590b5E4285Ff0Bd1D1" as const;
const GOLDEN_SAFE_TX_HASH = "0x10e5a5fd6fce284b5c52adeb98830fd78ef8e26eeba363ce8d49aa0d62556f86";
const GOLDEN_NONCE = 66;
const GOLDEN_INNER_CALLS: Call[] = [
  {
    to: "0xe5139Fc0FB8eae81e30d8a85C22E88c6757120f2",
    value: 0n,
    data: "0x7cb64759f9bd9a1fc90c93361fd13b7fd6fa4ee486eb4a94c95c5b0b5f6655f153ee061b",
  },
  {
    to: "0x5aFE3855358E112B5647B952709E6165e1c1eEEe",
    value: 0n,
    data: "0xa9059cbb000000000000000000000000e5139fc0fb8eae81e30d8a85c22e88c6757120f200000000000000000000000000000000000000000000494cff0c255652071ecc",
  },
];
const GOLDEN_PACKED_TRANSACTIONS =
  "0x00e5139fc0fb8eae81e30d8a85c22e88c6757120f2000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000247cb64759f9bd9a1fc90c93361fd13b7fd6fa4ee486eb4a94c95c5b0b5f6655f153ee061b005afe3855358e112b5647b952709e6165e1c1eeee00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000044a9059cbb000000000000000000000000e5139fc0fb8eae81e30d8a85c22e88c6757120f200000000000000000000000000000000000000000000494cff0c255652071ecc";

const OWNER_LOW = "0x1111111111111111111111111111111111111111" as const;
const OWNER_HIGH = "0x2222222222222222222222222222222222222222" as const;

describe("encodeMultiSendTransactions", () => {
  test("reproduces the packed bytes of a real multiSend transaction", () => {
    expect(encodeMultiSendTransactions(GOLDEN_INNER_CALLS)).toBe(GOLDEN_PACKED_TRANSACTIONS);
  });

  test("treats missing data/value as empty/zero", () => {
    const packed = encodeMultiSendTransactions([{ to: OWNER_LOW, value: 5n }]);
    // 0x + op(1) + to(20) + value(32) + dataLength(32) bytes, no data
    expect(packed).toBe(`0x00${OWNER_LOW.slice(2)}${5n.toString(16).padStart(64, "0")}${"0".repeat(64)}`.toLowerCase());
  });
});

describe("buildSafeTx + hashSafeTx", () => {
  test("reproduces the safeTxHash of a real executed Safe transaction", () => {
    const tx = buildSafeTx(GOLDEN_INNER_CALLS, GOLDEN_NONCE, "1.3.0");
    expect(tx.to).toBe(MULTI_SEND_CALL_ONLY["1.3.0"]);
    expect(tx.operation).toBe(1);
    expect(hashSafeTx(1, GOLDEN_SAFE, tx)).toBe(GOLDEN_SAFE_TX_HASH);
  });

  test("a single call is sent directly, without MultiSend", () => {
    const tx = buildSafeTx([{ to: OWNER_LOW, value: 7n, data: "0xabcdef" }], 3, "1.4.1");
    expect(tx).toMatchObject({ to: OWNER_LOW, value: 7n, data: "0xabcdef", operation: 0, nonce: 3 });
  });

  test("hash changes with chainId and nonce", () => {
    const tx = buildSafeTx(GOLDEN_INNER_CALLS, GOLDEN_NONCE, "1.3.0");
    expect(hashSafeTx(100, GOLDEN_SAFE, tx)).not.toBe(GOLDEN_SAFE_TX_HASH);
    expect(hashSafeTx(1, GOLDEN_SAFE, { ...tx, nonce: 67 })).not.toBe(GOLDEN_SAFE_TX_HASH);
  });

  test("rejects empty call lists", () => {
    expect(() => buildSafeTx([], 0, "1.3.0")).toThrow(/at least one call/);
  });
});

describe("approvedHashSignature", () => {
  test("encodes r = padded owner, s = 0, v = 1", () => {
    const signature = approvedHashSignature(OWNER_LOW);
    expect(signature).toBe(`0x${"0".repeat(24)}${OWNER_LOW.slice(2)}${"0".repeat(64)}01`);
    expect((signature.length - 2) / 2).toBe(65);
  });
});

describe("signSafeTx", () => {
  test("requests the signature from the explicit owner, not the client's active account", async () => {
    const signTypedData = vi.fn().mockResolvedValue("0x5170");
    const client = { account: { address: OWNER_HIGH }, signTypedData } as never;
    const tx = buildSafeTx([{ to: OWNER_LOW, value: 0n, data: "0x" }], 0, "1.4.1");

    await signSafeTx(client, 10, GOLDEN_SAFE, tx, OWNER_LOW);

    expect(signTypedData).toHaveBeenCalledTimes(1);
    expect(signTypedData.mock.calls[0][0]).toMatchObject({ account: OWNER_LOW, primaryType: "SafeTx" });
  });
});

describe("encodeExecTransaction", () => {
  test("sorts signatures by owner address ascending", () => {
    const tx = buildSafeTx([{ to: OWNER_LOW, value: 0n, data: "0x" }], 0, "1.3.0");
    const outOfOrder = encodeExecTransaction(tx, [
      { owner: OWNER_HIGH, signature: approvedHashSignature(OWNER_HIGH) },
      { owner: OWNER_LOW, signature: approvedHashSignature(OWNER_LOW) },
    ]);
    const inOrder = encodeExecTransaction(tx, [
      { owner: OWNER_LOW, signature: approvedHashSignature(OWNER_LOW) },
      { owner: OWNER_HIGH, signature: approvedHashSignature(OWNER_HIGH) },
    ]);
    expect(outOfOrder).toBe(inOrder);
    // The lower owner's approved-hash r-value must appear before the higher one's.
    expect(inOrder.indexOf(OWNER_LOW.slice(2))).toBeLessThan(inOrder.indexOf(OWNER_HIGH.slice(2)));
  });
});

describe("multiSendCallOnlyFor", () => {
  test("maps versions to canonical deployments", () => {
    expect(multiSendCallOnlyFor("1.3.0")).toBe(MULTI_SEND_CALL_ONLY["1.3.0"]);
    expect(multiSendCallOnlyFor("1.3.0+L2")).toBe(MULTI_SEND_CALL_ONLY["1.3.0"]);
    expect(multiSendCallOnlyFor("1.4.1")).toBe(MULTI_SEND_CALL_ONLY["1.4.1"]);
    expect(multiSendCallOnlyFor("1.5.0")).toBe(MULTI_SEND_CALL_ONLY["1.4.1"]);
  });

  test("rejects Safes below 1.3.0", () => {
    expect(() => multiSendCallOnlyFor("1.1.1")).toThrow(/Unsupported Safe version/);
    expect(() => multiSendCallOnlyFor("0.9.0")).toThrow(/Unsupported Safe version/);
  });
});

describe("isOwnerOf", () => {
  test("is case-insensitive", () => {
    expect(isOwnerOf({ owners: [OWNER_LOW] }, OWNER_LOW.toUpperCase().replace("0X", "0x") as never)).toBe(true);
    expect(isOwnerOf({ owners: [OWNER_LOW] }, OWNER_HIGH)).toBe(false);
  });
});

describe("safeAppQueueUrl", () => {
  test("uses EIP-3770 shortNames (matic for Polygon, not the tx-service slug)", () => {
    expect(safeAppQueueUrl(137, GOLDEN_SAFE)).toBe(
      `https://app.safe.global/transactions/queue?safe=matic:${GOLDEN_SAFE}`,
    );
    expect(safeAppQueueUrl(999999, GOLDEN_SAFE)).toBeUndefined();
  });
});
