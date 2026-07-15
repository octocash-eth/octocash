import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import type { Address } from "viem";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { getSafeInfo, getSafesByOwner } from "~/lib/api/safe-transaction-service";
import { useConnectedAddresses } from "./use-connected-addresses";
import { useEnabledSafeAccounts } from "./use-enabled-safe-accounts";

vi.mock("~/lib/api/safe-transaction-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/api/safe-transaction-service")>()),
  getSafesByOwner: vi.fn(),
  getSafeInfo: vi.fn(),
}));

vi.mock("./use-connected-addresses", () => ({
  useConnectedAddresses: vi.fn(),
}));

const OWNER = "0x1111111111111111111111111111111111111111" as Address;
// Stored lowercase in localStorage; its EIP-55 form differs in casing.
const SAFE = "0x6b3cffbfbeba292b1e588da438d5d172ee89387d";
const SAFE_CHECKSUMMED = "0x6b3CffBfBeba292b1E588DA438d5D172Ee89387D";

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  vi.mocked(getSafesByOwner).mockReset();
  vi.mocked(getSafeInfo).mockReset();
  vi.mocked(useConnectedAddresses).mockReturnValue([OWNER]);
});

describe("useEnabledSafeAccounts", () => {
  test("hydrates enabled addresses into SafeAccounts without running owner discovery", async () => {
    vi.mocked(getSafeInfo).mockImplementation(async (chainId) =>
      chainId === 1 ? { address: SAFE as Address, owners: [OWNER], threshold: 1, nonce: 0, version: "1.4.1" } : null,
    );

    const { result } = renderHook(() => useEnabledSafeAccounts([SAFE]), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.safes).toHaveLength(1);
    expect(result.current.safes[0]).toMatchObject({ kind: "safe", ownerAddress: OWNER });
    expect(result.current.safes[0].deployments[1]).toMatchObject({ controlled: true });
    expect(getSafesByOwner).not.toHaveBeenCalled();
  });

  test("re-checksums the stored lowercase address before probing — the service 422s on lowercase", async () => {
    vi.mocked(getSafeInfo).mockResolvedValue(null);

    const { result } = renderHook(() => useEnabledSafeAccounts([SAFE]), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(getSafeInfo).toHaveBeenCalled();
    for (const [, probed] of vi.mocked(getSafeInfo).mock.calls) {
      expect(probed).toBe(SAFE_CHECKSUMMED);
    }
    expect(result.current.safes[0].address).toBe(SAFE_CHECKSUMMED);
  });

  test("garbage localStorage entries are dropped, valid ones still hydrate", async () => {
    vi.mocked(getSafeInfo).mockImplementation(async (chainId) =>
      chainId === 1 ? { address: SAFE as Address, owners: [OWNER], threshold: 1, nonce: 0, version: "1.4.1" } : null,
    );

    const { result } = renderHook(() => useEnabledSafeAccounts(["not-an-address", SAFE]), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.safes).toHaveLength(1);
    expect(result.current.safes[0].address).toBe(SAFE_CHECKSUMMED);
  });

  test("no enabled safes, no requests", () => {
    const { result } = renderHook(() => useEnabledSafeAccounts([]), { wrapper });

    expect(result.current.safes).toEqual([]);
    expect(result.current.isLoading).toBe(false);
    expect(getSafeInfo).not.toHaveBeenCalled();
  });

  test("no connected wallets, no requests even with enabled safes persisted", () => {
    vi.mocked(useConnectedAddresses).mockReturnValue([]);

    const { result } = renderHook(() => useEnabledSafeAccounts([SAFE]), { wrapper });

    expect(result.current.safes).toEqual([]);
    expect(getSafeInfo).not.toHaveBeenCalled();
  });
});
