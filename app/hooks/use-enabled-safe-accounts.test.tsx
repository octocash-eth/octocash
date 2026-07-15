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
const SAFE = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

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
    expect(result.current.safes[0]).toMatchObject({ kind: "safe", address: SAFE, ownerAddress: OWNER });
    expect(result.current.safes[0].deployments[1]).toMatchObject({ controlled: true });
    expect(getSafesByOwner).not.toHaveBeenCalled();
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
