import { screen } from "@testing-library/react";
import { renderWithWallet as render } from "test/test-helpers";
import type { Address } from "viem";
import { describe, expect, test, vi } from "vitest";
import Dashboard, { meta } from "./route";

// Mock hooks
const mockUseConnectedAddresses = vi.fn();

vi.mock("~/hooks/use-connected-addresses", () => ({
  useConnectedAddresses: () => mockUseConnectedAddresses(),
}));

// Mock react-router
vi.mock("react-router", () => ({
  useLocation: () => ({ pathname: "/wallet/dashboard" }),
}));

// Mock components
vi.mock("~/components/site", () => ({
  SiteHeader: () => <header data-testid="site-header">Site Header</header>,
  GatedConnectButton: () => (
    <button data-testid="gated-connect-button" type="button">
      Connect Wallet
    </button>
  ),
}));

vi.mock("~/components/wallet-table", () => ({
  WalletTable: ({ connectedAddresses }: { connectedAddresses: Address[] }) => (
    <div data-testid="wallet-table">Wallet Table - {connectedAddresses.length} address(es)</div>
  ),
}));

// Mock UI components
vi.mock("~/components/ui/empty", () => ({
  Empty: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div data-testid="empty" className={className}>
      {children}
    </div>
  ),
  EmptyContent: ({ children }: { children: React.ReactNode }) => <div data-testid="empty-content">{children}</div>,
  EmptyDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  EmptyHeader: ({ children }: { children: React.ReactNode }) => <div data-testid="empty-header">{children}</div>,
  EmptyMedia: ({ children, variant }: { children: React.ReactNode; variant?: string }) => (
    <div data-testid="empty-media" data-variant={variant}>
      {children}
    </div>
  ),
  EmptyTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

// Mock icons
vi.mock("lucide-react", () => ({
  Wallet: () => <span data-testid="wallet-icon">👛</span>,
}));

// Mock meta utilities
vi.mock("~/utils/meta", () => ({
  generateMeta: vi.fn(() => [
    { title: "Dashboard" },
    { name: "description", content: "View and manage your tokens across multiple chains" },
    { name: "robots", content: "noindex" },
  ]),
}));

describe("Dashboard route - meta function", () => {
  test("returns meta tags with noIndex", () => {
    const result = meta();

    expect(result).toEqual([
      { title: "Dashboard" },
      { name: "description", content: "View and manage your tokens across multiple chains" },
      { name: "robots", content: "noindex" },
    ]);
  });
});

describe("Dashboard component - Empty state", () => {
  test("renders without crashing when no addresses connected", () => {
    mockUseConnectedAddresses.mockReturnValue([]);

    render(<Dashboard />);

    expect(screen.getByTestId("site-header")).toBeInTheDocument();
  });

  test("shows empty state when no addresses connected", () => {
    mockUseConnectedAddresses.mockReturnValue([]);

    render(<Dashboard />);

    expect(screen.getByText("Connect Your Wallet")).toBeInTheDocument();
    expect(
      screen.getByText("Connect your wallet to view and consolidate your tokens across multiple chains."),
    ).toBeInTheDocument();
    expect(screen.getByTestId("wallet-icon")).toBeInTheDocument();
  });

  test("empty state shows gated connect button", () => {
    mockUseConnectedAddresses.mockReturnValue([]);

    render(<Dashboard />);

    expect(screen.getByTestId("gated-connect-button")).toBeInTheDocument();
  });

  test("does not show wallet table when no addresses connected", () => {
    mockUseConnectedAddresses.mockReturnValue([]);

    render(<Dashboard />);

    expect(screen.queryByTestId("wallet-table")).not.toBeInTheDocument();
  });

  test("empty state has correct styling classes", () => {
    mockUseConnectedAddresses.mockReturnValue([]);

    render(<Dashboard />);

    const emptyContainer = screen.getByTestId("empty");
    expect(emptyContainer).toHaveClass("max-w-md");
  });

  test("empty media uses icon variant", () => {
    mockUseConnectedAddresses.mockReturnValue([]);

    render(<Dashboard />);

    const emptyMedia = screen.getByTestId("empty-media");
    expect(emptyMedia).toHaveAttribute("data-variant", "icon");
  });
});

describe("Dashboard component - With connected addresses", () => {
  const mockAddresses: Address[] = [
    "0x1234567890123456789012345678901234567890",
    "0x0987654321098765432109876543210987654321",
  ];

  test("renders wallet table when addresses are connected", () => {
    mockUseConnectedAddresses.mockReturnValue(mockAddresses);

    render(<Dashboard />);

    expect(screen.getByTestId("wallet-table")).toBeInTheDocument();
    expect(screen.getByText(/2 address\(es\)/)).toBeInTheDocument();
  });

  test("does not show empty state when addresses are connected", () => {
    mockUseConnectedAddresses.mockReturnValue(mockAddresses);

    render(<Dashboard />);

    expect(screen.queryByText("Connect Your Wallet")).not.toBeInTheDocument();
    expect(screen.queryByTestId("gated-connect-button")).not.toBeInTheDocument();
  });

  test("passes connected addresses to wallet table", () => {
    mockUseConnectedAddresses.mockReturnValue(mockAddresses);

    render(<Dashboard />);

    const walletTable = screen.getByTestId("wallet-table");
    expect(walletTable).toHaveTextContent("Wallet Table - 2 address(es)");
  });

  test("renders with single connected address", () => {
    const singleAddress: Address[] = ["0x1234567890123456789012345678901234567890"];
    mockUseConnectedAddresses.mockReturnValue(singleAddress);

    render(<Dashboard />);

    expect(screen.getByTestId("wallet-table")).toBeInTheDocument();
    expect(screen.getByText(/1 address\(es\)/)).toBeInTheDocument();
  });

  test("renders with multiple connected addresses", () => {
    const multipleAddresses: Address[] = [
      "0x1234567890123456789012345678901234567890",
      "0x0987654321098765432109876543210987654321",
      "0xabcdef0123456789abcdef0123456789abcdef01",
    ];
    mockUseConnectedAddresses.mockReturnValue(multipleAddresses);

    render(<Dashboard />);

    expect(screen.getByTestId("wallet-table")).toBeInTheDocument();
    expect(screen.getByText(/3 address\(es\)/)).toBeInTheDocument();
  });
});

describe("Dashboard component - Layout", () => {
  test("has correct background styling", () => {
    mockUseConnectedAddresses.mockReturnValue([]);

    const { container } = render(<Dashboard />);

    // Find the main div (it's wrapped by WalletProvider)
    const mainDiv = container.querySelector(".flex.flex-col.min-h-svh") as HTMLElement;
    expect(mainDiv).toBeInTheDocument();
    expect(mainDiv).toHaveClass("flex", "flex-col", "min-h-svh");
    expect(mainDiv).toHaveClass("bg-linear-to-br", "from-background", "to-accent/10");
  });

  test("site header is always rendered", () => {
    mockUseConnectedAddresses.mockReturnValue([]);

    render(<Dashboard />);

    expect(screen.getByTestId("site-header")).toBeInTheDocument();
  });

  test("wallet table container has correct max width when addresses connected", () => {
    const mockAddresses: Address[] = ["0x1234567890123456789012345678901234567890"];
    mockUseConnectedAddresses.mockReturnValue(mockAddresses);

    const { container } = render(<Dashboard />);

    const maxWidthDiv = container.querySelector(".max-w-7xl");
    expect(maxWidthDiv).toBeInTheDocument();
    expect(maxWidthDiv).toHaveClass("mx-auto");
  });

  test("empty state is centered when no addresses", () => {
    mockUseConnectedAddresses.mockReturnValue([]);

    const { container } = render(<Dashboard />);

    const centeringDiv = container.querySelector(".flex-1.flex.items-center.justify-center");
    expect(centeringDiv).toBeInTheDocument();
  });
});

describe("Dashboard component - State transitions", () => {
  test("switches from empty state to wallet table when addresses are connected", () => {
    mockUseConnectedAddresses.mockReturnValue([]);

    const { rerender } = render(<Dashboard />);

    // Initially empty
    expect(screen.getByText("Connect Your Wallet")).toBeInTheDocument();
    expect(screen.queryByTestId("wallet-table")).not.toBeInTheDocument();

    // Connect addresses
    const mockAddresses: Address[] = ["0x1234567890123456789012345678901234567890"];
    mockUseConnectedAddresses.mockReturnValue(mockAddresses);
    rerender(<Dashboard />);

    // Now shows wallet table
    expect(screen.queryByText("Connect Your Wallet")).not.toBeInTheDocument();
    expect(screen.getByTestId("wallet-table")).toBeInTheDocument();
  });

  test("switches from wallet table to empty state when addresses are disconnected", () => {
    const mockAddresses: Address[] = ["0x1234567890123456789012345678901234567890"];
    mockUseConnectedAddresses.mockReturnValue(mockAddresses);

    const { rerender } = render(<Dashboard />);

    // Initially shows wallet table
    expect(screen.getByTestId("wallet-table")).toBeInTheDocument();
    expect(screen.queryByText("Connect Your Wallet")).not.toBeInTheDocument();

    // Disconnect addresses
    mockUseConnectedAddresses.mockReturnValue([]);
    rerender(<Dashboard />);

    // Now shows empty state
    expect(screen.getByText("Connect Your Wallet")).toBeInTheDocument();
    expect(screen.queryByTestId("wallet-table")).not.toBeInTheDocument();
  });
});

describe("Dashboard component - Edge cases", () => {
  test("handles empty array of addresses", () => {
    mockUseConnectedAddresses.mockReturnValue([]);

    render(<Dashboard />);

    expect(screen.getByText("Connect Your Wallet")).toBeInTheDocument();
  });

  test("renders correctly with very long address array", () => {
    const manyAddresses: Address[] = Array.from(
      { length: 50 },
      (_, i) => `0x${i.toString().padStart(40, "0")}` as Address,
    );
    mockUseConnectedAddresses.mockReturnValue(manyAddresses);

    render(<Dashboard />);

    expect(screen.getByTestId("wallet-table")).toBeInTheDocument();
    expect(screen.getByText(/50 address\(es\)/)).toBeInTheDocument();
  });
});
