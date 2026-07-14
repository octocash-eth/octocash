import type { Address } from "viem";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { getSafeInfo, getSafesByOwner } from "~/lib/api/safe-transaction-service";
import { discoverOwnedSafes } from "./use-owned-safes";

vi.mock("~/lib/api/safe-transaction-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/api/safe-transaction-service")>()),
  getSafesByOwner: vi.fn(),
  getSafeInfo: vi.fn(),
}));

const OWNER = "0x1111111111111111111111111111111111111111" as Address;
const STRANGER = "0x9999999999999999999999999999999999999999" as Address;
const SAFE = "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa" as Address;

beforeEach(() => {
  vi.mocked(getSafesByOwner).mockReset();
  vi.mocked(getSafeInfo).mockReset();
});

describe("discoverOwnedSafes", () => {
  test("dedupes across chains and probes every chain, flagging uncontrolled deployments", async () => {
    // The owner's Safe shows up in the by-owner query on mainnet and Base.
    vi.mocked(getSafesByOwner).mockImplementation(async (chainId) => (chainId === 1 || chainId === 8453 ? [SAFE] : []));
    // Deployments: mainnet + Base controlled; Gnosis is a replayed deployment
    // with a different owner set (never surfaced by getSafesByOwner there).
    vi.mocked(getSafeInfo).mockImplementation(async (chainId) => {
      if (chainId === 1 || chainId === 8453) {
        return { address: SAFE, owners: [OWNER], threshold: 1, nonce: 4, version: "1.4.1" };
      }
      if (chainId === 100) {
        return { address: SAFE, owners: [STRANGER], threshold: 2, nonce: 0, version: "1.3.0" };
      }
      return null;
    });

    const safes = await discoverOwnedSafes([OWNER], 123);

    expect(safes).toHaveLength(1);
    const [safe] = safes;
    expect(safe).toMatchObject({ kind: "safe", address: SAFE, ownerAddress: OWNER, fetchedAt: 123 });
    expect(
      Object.keys(safe.deployments)
        .map(Number)
        .sort((a, b) => a - b),
    ).toEqual([1, 100, 8453]);
    expect(safe.deployments[1]).toMatchObject({ controlled: true, threshold: 1, version: "1.4.1" });
    expect(safe.deployments[100]).toMatchObject({ controlled: false, threshold: 2, owners: [STRANGER] });
  });

  test("a chain whose service errors is excluded from deployments (fail closed)", async () => {
    vi.mocked(getSafesByOwner).mockImplementation(async (chainId) => {
      if (chainId === 10) throw new Error("ExternalAPIError: 503");
      return chainId === 1 ? [SAFE] : [];
    });
    vi.mocked(getSafeInfo).mockImplementation(async (chainId) => {
      if (chainId === 10) throw new Error("ExternalAPIError: 503");
      if (chainId === 1) return { address: SAFE, owners: [OWNER], threshold: 1, nonce: 0, version: "1.4.1" };
      return null;
    });

    const [safe] = await discoverOwnedSafes([OWNER]);
    expect(safe.deployments[10]).toBeUndefined();
    expect(safe.deployments[1]).toBeDefined();
  });

  test("no owners, no requests", async () => {
    expect(await discoverOwnedSafes([])).toEqual([]);
    expect(getSafesByOwner).not.toHaveBeenCalled();
  });
});
