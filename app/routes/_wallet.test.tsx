import { render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import WalletLayout from "./_wallet";

// Mock react-router Outlet
vi.mock("react-router", () => ({
  Outlet: () => <div data-testid="outlet">Outlet Content</div>,
}));

// Mock WalletProvider
vi.mock("~/context/wallet-provider", () => ({
  WalletProvider: ({ children }: { children: React.ReactNode }) => <div data-testid="wallet-provider">{children}</div>,
}));

// Mock TokenPriceProvider — its real implementation uses `useQuery`, which
// requires a QueryClientProvider. Here we only care that the layout wires
// the two providers in the correct order.
vi.mock("~/context/token-price-provider", () => ({
  TokenPriceProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="token-price-provider">{children}</div>
  ),
}));

describe("WalletLayout", () => {
  test("renders without crashing", () => {
    render(<WalletLayout />);
    expect(screen.getByTestId("wallet-provider")).toBeInTheDocument();
  });

  test("wraps Outlet with WalletProvider and TokenPriceProvider", () => {
    render(<WalletLayout />);

    const walletProvider = screen.getByTestId("wallet-provider");
    const priceProvider = screen.getByTestId("token-price-provider");
    const outlet = screen.getByTestId("outlet");

    expect(walletProvider).toBeInTheDocument();
    expect(priceProvider).toBeInTheDocument();
    expect(outlet).toBeInTheDocument();
    expect(walletProvider).toContainElement(priceProvider);
    expect(priceProvider).toContainElement(outlet);
  });

  test("renders Outlet component", () => {
    render(<WalletLayout />);
    expect(screen.getByTestId("outlet")).toBeInTheDocument();
  });

  test("has correct component structure", () => {
    const { container } = render(<WalletLayout />);

    const walletProvider = screen.getByTestId("wallet-provider");
    const priceProvider = screen.getByTestId("token-price-provider");
    const outlet = screen.getByTestId("outlet");

    expect(container.firstChild).toBe(walletProvider);
    expect(walletProvider.firstChild).toBe(priceProvider);
    expect(priceProvider.firstChild).toBe(outlet);
  });

  test("renders outlet content", () => {
    render(<WalletLayout />);
    expect(screen.getByText("Outlet Content")).toBeInTheDocument();
  });
});
