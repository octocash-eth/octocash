import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement, ReactNode } from "react";
import type { Address } from "viem";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { useConnectedAddresses } from "~/hooks/use-connected-addresses";
import { getSafeInfo, getSafesByOwner } from "~/lib/api/safe-transaction-service";
import { ConnectSafesDialog } from "./connect-safes-dialog";

vi.mock("~/lib/api/safe-transaction-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/api/safe-transaction-service")>()),
  getSafesByOwner: vi.fn(),
  getSafeInfo: vi.fn(),
}));

vi.mock("~/hooks/use-connected-addresses", () => ({
  useConnectedAddresses: vi.fn(),
}));

vi.mock("~/hooks/use-smart-accounts", () => ({
  useSmartAccounts: () => ({ smartAccounts: [] }),
}));

vi.mock("~/components/site/gated-connect-button", () => ({
  GatedConnectButton: () => (
    <button data-testid="gated-connect-button" type="button">
      Connect Wallet
    </button>
  ),
}));

vi.mock("~/components/address/address-display", () => ({
  AddressDisplayRoot: ({ address, children }: { address: string; children: ReactNode }) => (
    <div data-testid="address-display-root" data-address={address}>
      {children}
    </div>
  ),
  AddressDisplayAvatar: () => <div data-testid="address-display-avatar" />,
  AddressDisplayText: () => <span data-testid="address-display-text" />,
  AddressDisplayCopy: () => (
    <button data-testid="address-display-copy" type="button">
      Copy
    </button>
  ),
}));

const OWNER_A = "0x1111111111111111111111111111111111111111" as Address;
const OWNER_B = "0x2222222222222222222222222222222222222222" as Address;
const SHARED_SAFE = "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa" as Address;

// Fresh client per render — no query cache or retry noise between tests.
function renderDialog(ui: ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(ui, {
    wrapper: ({ children }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
  });
}

beforeEach(() => {
  localStorage.clear();
  vi.mocked(getSafesByOwner).mockReset();
  vi.mocked(getSafeInfo).mockReset();
  vi.mocked(useConnectedAddresses).mockReturnValue([OWNER_A, OWNER_B]);
});

function mockSharedSafe() {
  // Both owners co-own the same Safe, deployed on mainnet only.
  vi.mocked(getSafesByOwner).mockImplementation(async (chainId) => (chainId === 1 ? [SHARED_SAFE] : []));
  vi.mocked(getSafeInfo).mockImplementation(async (chainId) =>
    chainId === 1
      ? { address: SHARED_SAFE, owners: [OWNER_A, OWNER_B], threshold: 2, nonce: 0, version: "1.4.1" }
      : null,
  );
}

describe("ConnectSafesDialog", () => {
  test("asks to connect a wallet first when nothing is connected", () => {
    vi.mocked(useConnectedAddresses).mockReturnValue([]);

    renderDialog(<ConnectSafesDialog open onOpenChange={vi.fn()} />);

    expect(screen.getByText("Connect your wallet first")).toBeInTheDocument();
    expect(screen.getByTestId("gated-connect-button")).toBeInTheDocument();
    expect(getSafesByOwner).not.toHaveBeenCalled();
  });

  test("lists each connected wallet without scanning any chains until expanded", () => {
    mockSharedSafe();

    renderDialog(<ConnectSafesDialog open onOpenChange={vi.fn()} />);

    const roots = screen.getAllByTestId("address-display-root");
    expect(roots.map((root) => root.getAttribute("data-address"))).toEqual([OWNER_A, OWNER_B]);
    expect(getSafesByOwner).not.toHaveBeenCalled();
  });

  test("expanding a wallet scans only that owner and lists its safes", async () => {
    mockSharedSafe();
    const user = userEvent.setup();

    renderDialog(<ConnectSafesDialog open onOpenChange={vi.fn()} />);

    await user.click(screen.getAllByRole("button", { expanded: false })[0]);

    await waitFor(() => {
      expect(screen.getByRole("checkbox", { name: `Use Safe ${SHARED_SAFE} as a funding source` })).toBeInTheDocument();
    });
    const scannedOwners = vi.mocked(getSafesByOwner).mock.calls.map(([, owner]) => owner);
    expect(scannedOwners.length).toBeGreaterThan(0);
    expect(new Set(scannedOwners)).toEqual(new Set([OWNER_A]));
  });

  test("a shared safe toggled under one owner shows checked under the other", async () => {
    mockSharedSafe();
    const user = userEvent.setup();

    renderDialog(<ConnectSafesDialog open onOpenChange={vi.fn()} />);

    // Expand both owners' sections.
    const triggers = screen.getAllByRole("button", { expanded: false });
    await user.click(triggers[0]);
    await user.click(triggers[1]);

    await waitFor(() => {
      expect(screen.getAllByRole("checkbox", { name: `Use Safe ${SHARED_SAFE} as a funding source` })).toHaveLength(2);
    });

    const [first, second] = screen.getAllByRole("checkbox", { name: `Use Safe ${SHARED_SAFE} as a funding source` });
    expect(first).not.toBeChecked();
    expect(second).not.toBeChecked();

    await user.click(first);

    expect(first).toBeChecked();
    expect(second).toBeChecked();

    await user.click(second);

    expect(first).not.toBeChecked();
    expect(second).not.toBeChecked();
  });

  test("a failed scan shows an error with retry, never 'no safes'", async () => {
    vi.mocked(getSafesByOwner).mockRejectedValue(new Error("ExternalAPIError: 429"));
    const user = userEvent.setup();

    renderDialog(<ConnectSafesDialog open onOpenChange={vi.fn()} />);

    await user.click(screen.getAllByRole("button", { expanded: false })[0]);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    });
    expect(screen.queryByText("No Safes found for this address.")).not.toBeInTheDocument();
  });

  test("an owner with no safes says so", async () => {
    vi.mocked(getSafesByOwner).mockResolvedValue([]);
    const user = userEvent.setup();

    renderDialog(<ConnectSafesDialog open onOpenChange={vi.fn()} />);

    await user.click(screen.getAllByRole("button", { expanded: false })[0]);

    await waitFor(() => {
      expect(screen.getByText("No Safes found for this address.")).toBeInTheDocument();
    });
  });
});
