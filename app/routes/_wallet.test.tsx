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

describe("WalletLayout", () => {
  test("renders without crashing", () => {
    render(<WalletLayout />);
    expect(screen.getByTestId("wallet-provider")).toBeInTheDocument();
  });

  test("wraps Outlet with WalletProvider", () => {
    render(<WalletLayout />);

    const provider = screen.getByTestId("wallet-provider");
    const outlet = screen.getByTestId("outlet");

    expect(provider).toBeInTheDocument();
    expect(outlet).toBeInTheDocument();
    expect(provider).toContainElement(outlet);
  });

  test("renders Outlet component", () => {
    render(<WalletLayout />);
    expect(screen.getByTestId("outlet")).toBeInTheDocument();
  });

  test("has correct component structure", () => {
    const { container } = render(<WalletLayout />);

    // Should have WalletProvider wrapping Outlet
    const provider = screen.getByTestId("wallet-provider");
    const outlet = screen.getByTestId("outlet");

    expect(container.firstChild).toBe(provider);
    expect(provider.firstChild).toBe(outlet);
  });

  test("renders outlet content", () => {
    render(<WalletLayout />);
    expect(screen.getByText("Outlet Content")).toBeInTheDocument();
  });
});
