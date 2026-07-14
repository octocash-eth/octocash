import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  getSafeInfo,
  getSafesByOwner,
  getSafeTx,
  getSafeTxsAtNonce,
  hasSafeTransactionService,
  proposeSafeTx,
} from "./safe-transaction-service";

const SAFE = "0x8CF60B289f8d31F737049B590b5E4285Ff0Bd1D1" as const;
const OWNER = "0x1111111111111111111111111111111111111111" as const;
const HASH = "0x10e5a5fd6fce284b5c52adeb98830fd78ef8e26eeba363ce8d49aa0d62556f86" as const;

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

const json = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

beforeEach(() => {
  fetchMock.mockReset();
});

describe("hasSafeTransactionService", () => {
  test("covers all 8 supported chains, rejects unknown ones", () => {
    for (const chainId of [1, 10, 42161, 8453, 137, 130, 59144, 100]) {
      expect(hasSafeTransactionService(chainId)).toBe(true);
    }
    expect(hasSafeTransactionService(56)).toBe(false);
  });
});

describe("getSafesByOwner", () => {
  test("hits the per-chain host and unwraps the safes array", async () => {
    fetchMock.mockResolvedValueOnce(json({ safes: [SAFE] }));
    expect(await getSafesByOwner(100, OWNER)).toEqual([SAFE]);
    expect(fetchMock.mock.calls[0][0]).toBe(`https://api.safe.global/tx-service/gno/api/v1/owners/${OWNER}/safes/`);
  });

  test("Polygon uses the pol slug (not matic)", async () => {
    fetchMock.mockResolvedValueOnce(json({ safes: [] }));
    await getSafesByOwner(137, OWNER);
    expect(fetchMock.mock.calls[0][0]).toContain("/tx-service/pol/");
  });

  test("throws a chain error for unsupported chains without fetching", async () => {
    await expect(getSafesByOwner(56, OWNER)).rejects.toThrow(/No Safe Transaction Service/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("getSafeInfo", () => {
  test("normalizes string nonces and null versions", async () => {
    fetchMock.mockResolvedValueOnce(json({ address: SAFE, owners: [OWNER], threshold: 2, nonce: "67", version: null }));
    expect(await getSafeInfo(1, SAFE)).toEqual({
      address: SAFE,
      owners: [OWNER],
      threshold: 2,
      nonce: 67,
      version: "unknown",
    });
  });

  test("404 means not deployed there — returns null, not an error", async () => {
    fetchMock.mockResolvedValueOnce(json({ detail: "Not found" }, 404));
    expect(await getSafeInfo(1, SAFE)).toBeNull();
  });

  test("5xx surfaces as a retryable ExternalAPIError", async () => {
    fetchMock.mockResolvedValueOnce(json({}, 503));
    await expect(getSafeInfo(1, SAFE)).rejects.toThrow(/ExternalAPIError/);
  });
});

describe("proposeSafeTx", () => {
  const payload = {
    to: SAFE,
    value: "0",
    data: "0x" as const,
    operation: 0 as const,
    safeTxGas: "0",
    baseGas: "0",
    gasPrice: "0",
    gasToken: "0x0000000000000000000000000000000000000000" as const,
    refundReceiver: "0x0000000000000000000000000000000000000000" as const,
    nonce: 66,
    contractTransactionHash: HASH,
    sender: OWNER,
    signature: "0xdeadbeef" as const,
  };

  test("POSTs the payload to the propose endpoint", async () => {
    fetchMock.mockResolvedValueOnce(json({}, 201));
    await proposeSafeTx(1, SAFE, payload);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://api.safe.global/tx-service/eth/api/v1/safes/${SAFE}/multisig-transactions/`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toMatchObject({ contractTransactionHash: HASH, nonce: 66 });
  });

  test("a duplicate proposal (same safeTxHash already on the service) counts as success", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 422,
      text: async () => '{"nonFieldErrors":["Tx with safe-tx-hash ... already exists"]}',
    });
    await expect(proposeSafeTx(1, SAFE, payload)).resolves.toBeUndefined();
  });

  test("other rejections throw a SafeServiceError", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 422, text: async () => "Invalid signature" });
    await expect(proposeSafeTx(1, SAFE, payload)).rejects.toThrow(/SafeServiceError.*Invalid signature/);
  });
});

describe("getSafeTx / getSafeTxsAtNonce", () => {
  test("normalizes confirmations and nonce", async () => {
    fetchMock.mockResolvedValueOnce(
      json({
        safeTxHash: HASH,
        nonce: "66",
        isExecuted: true,
        isSuccessful: true,
        transactionHash: "0x9e7e",
        confirmations: null,
        confirmationsRequired: 3,
      }),
    );
    const tx = await getSafeTx(1, HASH);
    expect(tx).toMatchObject({ nonce: 66, confirmations: [], isExecuted: true });
  });

  test("getSafeTxsAtNonce queries by nonce and unwraps results", async () => {
    fetchMock.mockResolvedValueOnce(json({ results: [{ safeTxHash: HASH, nonce: 66, confirmations: null }] }));
    const txs = await getSafeTxsAtNonce(1, SAFE, 66);
    expect(fetchMock.mock.calls[0][0]).toContain(`/v1/safes/${SAFE}/multisig-transactions/?nonce=66`);
    expect(txs).toHaveLength(1);
    expect(txs[0].confirmations).toEqual([]);
  });
});
