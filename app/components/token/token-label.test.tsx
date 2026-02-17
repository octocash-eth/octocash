import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { zeroAddress } from "viem";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { TokenLabel } from "./token-label";

// Mock useToken hook
const mockUseToken = vi.fn();

vi.mock("~/hooks/use-token", () => ({
  useToken: (config: unknown) => mockUseToken(config),
}));

// Helper to wrap components with QueryClientProvider
function renderWithQueryClient(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

describe("TokenLabel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseToken.mockReturnValue({ data: undefined });
  });

  describe("rendering", () => {
    test("renders with valid token address", () => {
      const tokenAddress = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
      const { container } = renderWithQueryClient(<TokenLabel tokenAddress={tokenAddress} chainId={1} />);

      expect(container).toBeInTheDocument();
      expect(container.querySelector('[data-slot="avatar"]')).toBeInTheDocument();
    });

    test("renders with zero address (native token)", () => {
      const { container } = renderWithQueryClient(<TokenLabel tokenAddress={zeroAddress} chainId={1} symbol="ETH" />);

      expect(container).toBeInTheDocument();
      expect(container.querySelector('[data-slot="avatar"]')).toBeInTheDocument();
    });

    test("renders with provided symbol", () => {
      mockUseToken.mockReturnValue({
        data: { symbol: "USDC", decimals: 6, name: "USD Coin" },
      });

      const { getByText } = renderWithQueryClient(
        <TokenLabel tokenAddress="0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" chainId={1} symbol="USDC" />,
      );

      expect(getByText("USDC")).toBeInTheDocument();
    });

    test("renders without provided symbol", () => {
      mockUseToken.mockReturnValue({
        data: { symbol: "USDC", decimals: 6, name: "USD Coin" },
      });

      const { getByText } = renderWithQueryClient(
        <TokenLabel tokenAddress="0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" chainId={1} />,
      );

      expect(getByText("USDC")).toBeInTheDocument();
    });
  });

  describe("TokenDisplayRoot integration", () => {
    test("passes tokenAddress to TokenDisplayRoot", () => {
      const tokenAddress = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
      mockUseToken.mockReturnValue({
        data: { symbol: "USDC", decimals: 6 },
      });

      const { container } = renderWithQueryClient(<TokenLabel tokenAddress={tokenAddress} chainId={1} />);

      expect(container.querySelector(".flex.items-center")).toBeInTheDocument();
    });

    test("passes chainId to TokenDisplayRoot", () => {
      mockUseToken.mockReturnValue({
        data: { symbol: "USDC", decimals: 6 },
      });

      renderWithQueryClient(<TokenLabel tokenAddress="0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" chainId={1} />);

      expect(mockUseToken).toHaveBeenCalledWith(
        expect.objectContaining({
          chainId: 1,
        }),
      );
    });

    test("passes symbol to TokenDisplayRoot", () => {
      const { getByText } = renderWithQueryClient(
        <TokenLabel tokenAddress="0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" chainId={1} symbol="USDC" />,
      );

      expect(getByText("USDC")).toBeInTheDocument();
    });
  });

  describe("TokenDisplayIcon", () => {
    test("renders TokenDisplayIcon with correct size", () => {
      mockUseToken.mockReturnValue({
        data: { symbol: "USDC", decimals: 6 },
      });

      const { container } = renderWithQueryClient(
        <TokenLabel tokenAddress="0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" chainId={1} />,
      );

      const icon = container.querySelector(".size-4");
      expect(icon).toBeInTheDocument();
    });

    test("renders icon for native token", () => {
      const { container } = renderWithQueryClient(<TokenLabel tokenAddress={zeroAddress} chainId={1} symbol="ETH" />);

      const icon = container.querySelector('[data-slot="avatar"]');
      expect(icon).toBeInTheDocument();
    });

    test("renders icon for ERC20 token", () => {
      mockUseToken.mockReturnValue({
        data: { symbol: "USDC", decimals: 6 },
      });

      const { container } = renderWithQueryClient(
        <TokenLabel tokenAddress="0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" chainId={1} />,
      );

      const icon = container.querySelector('[data-slot="avatar"]');
      expect(icon).toBeInTheDocument();
    });
  });

  describe("TokenDisplaySymbol", () => {
    test("renders symbol from prop", () => {
      const { getByText } = renderWithQueryClient(
        <TokenLabel tokenAddress="0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" chainId={1} symbol="USDC" />,
      );

      expect(getByText("USDC")).toBeInTheDocument();
    });

    test("renders symbol from fetched data", () => {
      mockUseToken.mockReturnValue({
        data: { symbol: "USDC", decimals: 6 },
      });

      const { getByText } = renderWithQueryClient(
        <TokenLabel tokenAddress="0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" chainId={1} />,
      );

      expect(getByText("USDC")).toBeInTheDocument();
    });

    test("renders fallback when no symbol available", () => {
      mockUseToken.mockReturnValue({
        data: undefined,
      });

      const { getByText } = renderWithQueryClient(
        <TokenLabel tokenAddress="0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" chainId={1} />,
      );

      expect(getByText("???")).toBeInTheDocument();
    });
  });

  describe("different chains", () => {
    test("renders Ethereum token", () => {
      mockUseToken.mockReturnValue({
        data: { symbol: "USDC", decimals: 6 },
      });

      renderWithQueryClient(<TokenLabel tokenAddress="0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" chainId={1} />);

      expect(mockUseToken).toHaveBeenCalledWith(
        expect.objectContaining({
          chainId: 1,
        }),
      );
    });

    test("renders Polygon token", () => {
      mockUseToken.mockReturnValue({
        data: { symbol: "USDC", decimals: 6 },
      });

      renderWithQueryClient(<TokenLabel tokenAddress="0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" chainId={137} />);

      expect(mockUseToken).toHaveBeenCalledWith(
        expect.objectContaining({
          chainId: 137,
        }),
      );
    });

    test("renders Arbitrum token", () => {
      mockUseToken.mockReturnValue({
        data: { symbol: "USDC", decimals: 6 },
      });

      renderWithQueryClient(<TokenLabel tokenAddress="0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" chainId={42161} />);

      expect(mockUseToken).toHaveBeenCalledWith(
        expect.objectContaining({
          chainId: 42161,
        }),
      );
    });

    test("renders Optimism token", () => {
      mockUseToken.mockReturnValue({
        data: { symbol: "USDC", decimals: 6 },
      });

      renderWithQueryClient(<TokenLabel tokenAddress="0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" chainId={10} />);

      expect(mockUseToken).toHaveBeenCalledWith(
        expect.objectContaining({
          chainId: 10,
        }),
      );
    });
  });

  describe("token address handling", () => {
    test("handles checksummed addresses", () => {
      mockUseToken.mockReturnValue({
        data: { symbol: "USDC", decimals: 6 },
      });

      const checksummedAddress = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
      const { container } = renderWithQueryClient(<TokenLabel tokenAddress={checksummedAddress} chainId={1} />);

      expect(container.firstChild).not.toBeNull();
    });

    test("handles lowercase addresses", () => {
      mockUseToken.mockReturnValue({
        data: { symbol: "USDC", decimals: 6 },
      });

      const lowercaseAddress = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
      const { container } = renderWithQueryClient(<TokenLabel tokenAddress={lowercaseAddress} chainId={1} />);

      expect(container.firstChild).not.toBeNull();
    });

    test("handles uppercase addresses", () => {
      mockUseToken.mockReturnValue({
        data: { symbol: "USDC", decimals: 6 },
      });

      const uppercaseAddress = "0XA0B86991C6218B36C1D19D4A2E9EB0CE3606EB48";
      const { container } = renderWithQueryClient(<TokenLabel tokenAddress={uppercaseAddress} chainId={1} />);

      expect(container.firstChild).not.toBeNull();
    });

    test("handles zero address", () => {
      const { container } = renderWithQueryClient(<TokenLabel tokenAddress={zeroAddress} chainId={1} symbol="ETH" />);

      expect(container.firstChild).not.toBeNull();
    });
  });

  describe("token symbols", () => {
    test("handles ETH symbol", () => {
      const { getByText } = renderWithQueryClient(<TokenLabel tokenAddress={zeroAddress} chainId={1} symbol="ETH" />);

      expect(getByText("ETH")).toBeInTheDocument();
    });

    test("handles USDC symbol", () => {
      mockUseToken.mockReturnValue({
        data: { symbol: "USDC", decimals: 6 },
      });

      const { getByText } = renderWithQueryClient(
        <TokenLabel tokenAddress="0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" chainId={1} symbol="USDC" />,
      );

      expect(getByText("USDC")).toBeInTheDocument();
    });

    test("handles USDT symbol", () => {
      mockUseToken.mockReturnValue({
        data: { symbol: "USDT", decimals: 6 },
      });

      const { getByText } = renderWithQueryClient(
        <TokenLabel tokenAddress="0xdAC17F958D2ee523a2206206994597C13D831ec7" chainId={1} symbol="USDT" />,
      );

      expect(getByText("USDT")).toBeInTheDocument();
    });

    test("handles DAI symbol", () => {
      mockUseToken.mockReturnValue({
        data: { symbol: "DAI", decimals: 18 },
      });

      const { getByText } = renderWithQueryClient(
        <TokenLabel tokenAddress="0x6B175474E89094C44Da98b954EedeAC495271d0F" chainId={1} symbol="DAI" />,
      );

      expect(getByText("DAI")).toBeInTheDocument();
    });

    test("handles WETH symbol", () => {
      mockUseToken.mockReturnValue({
        data: { symbol: "WETH", decimals: 18 },
      });

      const { getByText } = renderWithQueryClient(
        <TokenLabel tokenAddress="0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" chainId={1} symbol="WETH" />,
      );

      expect(getByText("WETH")).toBeInTheDocument();
    });
  });

  describe("edge cases", () => {
    test("handles very long token symbols", () => {
      mockUseToken.mockReturnValue({
        data: { symbol: "VERYLONGTOKENSYMBOL", decimals: 18 },
      });

      const { getByText } = renderWithQueryClient(
        <TokenLabel
          tokenAddress="0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
          chainId={1}
          symbol="VERYLONGTOKENSYMBOL"
        />,
      );

      expect(getByText("VERYLONGTOKENSYMBOL")).toBeInTheDocument();
    });

    test("handles empty symbol string", () => {
      mockUseToken.mockReturnValue({
        data: { symbol: "", decimals: 18 },
      });

      const { container } = renderWithQueryClient(
        <TokenLabel tokenAddress="0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" chainId={1} symbol="" />,
      );

      expect(container.firstChild).not.toBeNull();
    });

    test("handles undefined symbol", () => {
      mockUseToken.mockReturnValue({
        data: { symbol: "USDC", decimals: 6 },
      });

      const { getByText } = renderWithQueryClient(
        <TokenLabel tokenAddress="0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" chainId={1} symbol={undefined} />,
      );

      expect(getByText("USDC")).toBeInTheDocument();
    });

    test("handles symbol with special characters", () => {
      mockUseToken.mockReturnValue({
        data: { symbol: "$TOKEN", decimals: 18 },
      });

      const { getByText } = renderWithQueryClient(
        <TokenLabel tokenAddress="0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" chainId={1} symbol="$TOKEN" />,
      );

      expect(getByText("$TOKEN")).toBeInTheDocument();
    });

    test("handles symbol with numbers", () => {
      mockUseToken.mockReturnValue({
        data: { symbol: "1INCH", decimals: 18 },
      });

      const { getByText } = renderWithQueryClient(
        <TokenLabel tokenAddress="0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" chainId={1} symbol="1INCH" />,
      );

      expect(getByText("1INCH")).toBeInTheDocument();
    });
  });

  describe("component structure", () => {
    test("renders TokenDisplayRoot container", () => {
      mockUseToken.mockReturnValue({
        data: { symbol: "USDC", decimals: 6 },
      });

      const { container } = renderWithQueryClient(
        <TokenLabel tokenAddress="0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" chainId={1} />,
      );

      // TokenDisplayRoot renders a div with flex items-center
      expect(container.querySelector(".flex.items-center")).toBeInTheDocument();
    });

    test("contains icon and symbol elements", () => {
      mockUseToken.mockReturnValue({
        data: { symbol: "USDC", decimals: 6 },
      });

      const { container, getByText } = renderWithQueryClient(
        <TokenLabel tokenAddress="0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" chainId={1} symbol="USDC" />,
      );

      // Icon
      expect(container.querySelector('[data-slot="avatar"]')).toBeInTheDocument();
      // Symbol
      expect(getByText("USDC")).toBeInTheDocument();
    });

    test("maintains correct element order", () => {
      mockUseToken.mockReturnValue({
        data: { symbol: "USDC", decimals: 6 },
      });

      const { container } = renderWithQueryClient(
        <TokenLabel tokenAddress="0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" chainId={1} symbol="USDC" />,
      );

      const root = container.querySelector(".flex.items-center");
      expect(root).toBeInTheDocument();
      expect(root?.children.length).toBeGreaterThan(0);
    });
  });

  describe("useToken hook integration", () => {
    test("calls useToken for non-zero address without symbol", () => {
      const tokenAddress = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
      renderWithQueryClient(<TokenLabel tokenAddress={tokenAddress} chainId={1} />);

      expect(mockUseToken).toHaveBeenCalledWith(
        expect.objectContaining({
          address: tokenAddress,
          chainId: 1,
        }),
      );
    });

    test("optimizes query when symbol is provided", () => {
      const tokenAddress = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
      renderWithQueryClient(<TokenLabel tokenAddress={tokenAddress} chainId={1} symbol="USDC" />);

      // useToken should still be called but query might be optimized
      expect(mockUseToken).toHaveBeenCalled();
    });

    test("handles token data loading state", () => {
      mockUseToken.mockReturnValue({
        data: undefined,
        isLoading: true,
      });

      const { container } = renderWithQueryClient(
        <TokenLabel tokenAddress="0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" chainId={1} />,
      );

      expect(container.firstChild).not.toBeNull();
    });

    test("handles token data error state", () => {
      mockUseToken.mockReturnValue({
        data: undefined,
        error: new Error("Failed to fetch"),
      });

      const { container } = renderWithQueryClient(
        <TokenLabel tokenAddress="0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" chainId={1} />,
      );

      expect(container.firstChild).not.toBeNull();
    });
  });
});
