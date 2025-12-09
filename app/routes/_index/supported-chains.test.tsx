import { render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { supportedChains } from "~/data/supported-chains";
import { SupportedChains } from "./supported-chains";

// Mock ChainIcon component
vi.mock("~/components/chain/chain-icon", () => ({
  ChainIcon: ({ chain, className }: { chain: string; className?: string }) => (
    <div data-testid={`chain-icon-${chain.toLowerCase().replace(/\s+/g, "-")}`} className={className}>
      {chain}
    </div>
  ),
}));

describe("SupportedChains", () => {
  test("renders without crashing", () => {
    const { container } = render(<SupportedChains />);
    expect(container.querySelector(".w-full")).toBeInTheDocument();
  });

  test("renders all supported chains", () => {
    render(<SupportedChains />);

    // Verify each chain from the data is rendered
    supportedChains.forEach((chain) => {
      const chainIcon = screen.getByTestId(`chain-icon-${chain.name.toLowerCase().replace(/\s+/g, "-")}`);
      expect(chainIcon).toBeInTheDocument();
    });
  });

  test("renders correct number of chain containers", () => {
    const { container } = render(<SupportedChains />);

    // Count divs with the specific chain container styling
    const chainContainers = container.querySelectorAll(".size-14.rounded-full.bg-background.shadow-2xl");
    expect(chainContainers).toHaveLength(supportedChains.length);
  });

  test("each chain has a title attribute with chain name", () => {
    const { container } = render(<SupportedChains />);

    supportedChains.forEach((chain) => {
      const chainContainer = container.querySelector(`[title="${chain.name}"]`);
      expect(chainContainer).toBeInTheDocument();
    });
  });

  test("ChainIcon receives correct chain name prop", () => {
    render(<SupportedChains />);

    supportedChains.forEach((chain) => {
      const chainIcon = screen.getByTestId(`chain-icon-${chain.name.toLowerCase().replace(/\s+/g, "-")}`);
      expect(chainIcon).toHaveTextContent(chain.name);
    });
  });

  test("ChainIcon receives correct className prop", () => {
    render(<SupportedChains />);

    supportedChains.forEach((chain) => {
      const chainIcon = screen.getByTestId(`chain-icon-${chain.name.toLowerCase().replace(/\s+/g, "-")}`);
      expect(chainIcon).toHaveClass("size-12");
    });
  });

  test("has correct container structure", () => {
    const { container } = render(<SupportedChains />);

    // Check outer container
    const outerContainer = container.querySelector(".w-full");
    expect(outerContainer).toBeInTheDocument();

    // Check flex wrapper
    const flexWrapper = container.querySelector(".flex.flex-wrap");
    expect(flexWrapper).toBeInTheDocument();
  });

  test("applies responsive gap classes", () => {
    const { container } = render(<SupportedChains />);

    const flexWrapper = container.querySelector(".gap-3.md\\:gap-4");
    expect(flexWrapper).toBeInTheDocument();
  });

  test("chain containers have proper styling classes", () => {
    const { container } = render(<SupportedChains />);

    const chainContainers = container.querySelectorAll(".size-14");

    chainContainers.forEach((chainContainer) => {
      expect(chainContainer).toHaveClass("rounded-full");
      expect(chainContainer).toHaveClass("bg-background");
      expect(chainContainer).toHaveClass("shadow-2xl");
      expect(chainContainer).toHaveClass("flex");
      expect(chainContainer).toHaveClass("items-center");
      expect(chainContainer).toHaveClass("justify-center");
    });
  });

  test("renders chains in the correct order", () => {
    const { container } = render(<SupportedChains />);

    const chainContainers = container.querySelectorAll(".size-14");

    chainContainers.forEach((chainContainer, index) => {
      const expectedChainName = supportedChains[index].name;
      expect(chainContainer).toHaveAttribute("title", expectedChainName);
    });
  });

  test("each chain container has a unique key", () => {
    // This is tested implicitly by React not throwing warnings
    // But we can verify all chains have unique IDs
    const chainIds = supportedChains.map((chain) => chain.id);
    const uniqueIds = new Set(chainIds);
    expect(uniqueIds.size).toBe(chainIds.length);
  });

  test("renders container with correct structure", () => {
    const { container } = render(<SupportedChains />);
    const outerContainer = container.querySelector(".w-full");
    const flexWrapper = outerContainer?.querySelector(".flex.flex-wrap");
    expect(outerContainer).toBeInTheDocument();
    expect(flexWrapper).toBeInTheDocument();
    expect(flexWrapper?.children).toHaveLength(supportedChains.length);
  });
});
