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

// Mock SupportWidget — its real implementation portals to <body> and pulls in
// heavy deps; the layout test only cares about the provider wiring.
vi.mock("~/components/site/support-widget", () => ({
  SupportWidget: () => <div data-testid="support-widget" />,
}));

// Mock TokenPriceProvider — its real implementation uses `useQuery`, which
// requires a QueryClientProvider. Here we only care that the layout wires
// the providers in the correct order.
vi.mock("~/context/token-price-provider", () => ({
  TokenPriceProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="token-price-provider">{children}</div>
  ),
}));

// Mock CurrencyProvider for the same reason — its real implementation calls
// `useQuery` for the CoinGecko exchange rates.
vi.mock("~/context/currency-provider", () => ({
  CurrencyProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="currency-provider">{children}</div>
  ),
}));

describe("WalletLayout", () => {
  test("renders without crashing", () => {
    render(<WalletLayout />);
    expect(screen.getByTestId("wallet-provider")).toBeInTheDocument();
  });

  test("wraps Outlet with WalletProvider, TokenPriceProvider, and CurrencyProvider", () => {
    render(<WalletLayout />);

    const walletProvider = screen.getByTestId("wallet-provider");
    const priceProvider = screen.getByTestId("token-price-provider");
    const currencyProvider = screen.getByTestId("currency-provider");
    const outlet = screen.getByTestId("outlet");

    expect(walletProvider).toBeInTheDocument();
    expect(priceProvider).toBeInTheDocument();
    expect(currencyProvider).toBeInTheDocument();
    expect(outlet).toBeInTheDocument();
    expect(walletProvider).toContainElement(priceProvider);
    expect(priceProvider).toContainElement(currencyProvider);
    expect(currencyProvider).toContainElement(outlet);
  });

  test("renders Outlet component", () => {
    render(<WalletLayout />);
    expect(screen.getByTestId("outlet")).toBeInTheDocument();
  });

  test("has correct component structure", () => {
    const { container } = render(<WalletLayout />);

    const walletProvider = screen.getByTestId("wallet-provider");
    const priceProvider = screen.getByTestId("token-price-provider");
    const currencyProvider = screen.getByTestId("currency-provider");
    const outlet = screen.getByTestId("outlet");

    expect(container.firstChild).toBe(walletProvider);
    expect(walletProvider.firstChild).toBe(priceProvider);
    expect(priceProvider.firstChild).toBe(currencyProvider);
    expect(currencyProvider.firstChild).toBe(outlet);
  });

  test("renders outlet content", () => {
    render(<WalletLayout />);
    expect(screen.getByText("Outlet Content")).toBeInTheDocument();
  });
});
