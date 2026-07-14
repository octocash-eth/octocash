import type { Address } from "viem";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { getPublicClient } from "~/lib/public-client";
import { detectSmartAccounts } from "./use-smart-accounts";

vi.mock("~/lib/public-client", () => ({
  getPublicClient: vi.fn(),
}));

const SMART = "0x4444444444444444444444444444444444444444" as Address;
const EOA = "0x1111111111111111111111111111111111111111" as Address;
const DELEGATED = "0x2222222222222222222222222222222222222222" as Address;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getPublicClient).mockImplementation(
    (chainId: number) =>
      ({
        getCode: vi.fn(async ({ address }: { address: string }) => {
          if (address.toLowerCase() === SMART.toLowerCase()) {
            // Deployed on mainnet + Base only.
            return chainId === 1 || chainId === 8453 ? "0x608060" : undefined;
          }
          if (address.toLowerCase() === DELEGATED.toLowerCase()) {
            // EIP-7702 delegate everywhere — still an EOA.
            return "0xef0100aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
          }
          return "0x";
        }),
      }) as never,
  );
});

describe("detectSmartAccounts", () => {
  test("classifies non-7702 contract code as smart deployments with per-chain capabilities", async () => {
    const capabilities = vi.fn().mockResolvedValue({
      1: { atomic: { status: "supported" } },
      8453: { atomic: { status: "unsupported" } },
    });

    const accounts = await detectSmartAccounts([SMART, EOA, DELEGATED], capabilities, 42);

    expect(accounts).toHaveLength(1);
    const [smart] = accounts;
    expect(smart).toMatchObject({ kind: "smart", address: SMART, fetchedAt: 42 });
    expect(Object.keys(smart.deployments).map(Number).sort()).toEqual([1, 8453]);
    expect(smart.deployments[1].atomic).toBe("supported");
    expect(smart.deployments[8453].atomic).toBe("unsupported");
    // EOAs and 7702-delegated EOAs get no map entry at all.
    expect(capabilities).toHaveBeenCalledTimes(1);
  });

  test("a wallet without wallet_getCapabilities yields 'unknown' (sequential mode), never hides a deployment", async () => {
    const capabilities = vi.fn().mockRejectedValue(new Error("method not supported"));

    const [smart] = await detectSmartAccounts([SMART], capabilities);

    expect(smart.deployments[1].atomic).toBe("unknown");
    expect(smart.deployments[8453].atomic).toBe("unknown");
  });

  test("chains whose code probe fails are excluded — routing fails closed", async () => {
    vi.mocked(getPublicClient).mockImplementation(
      (chainId: number) =>
        ({
          getCode: vi.fn(async () => {
            if (chainId === 8453) throw new Error("rpc down");
            return chainId === 1 ? "0x608060" : "0x";
          }),
        }) as never,
    );

    const [smart] = await detectSmartAccounts([SMART], async () => null);
    expect(smart.deployments[1]).toBeDefined();
    expect(smart.deployments[8453]).toBeUndefined();
  });

  test("no addresses, no requests", async () => {
    const capabilities = vi.fn();
    expect(await detectSmartAccounts([], capabilities)).toEqual([]);
    expect(capabilities).not.toHaveBeenCalled();
  });
});
