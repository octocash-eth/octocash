import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { zeroAddress } from "viem";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { TokenAmount } from "~/lib/types";
import { TokenCard } from "./token-card";

// Mock ethereum-blockies-base64
vi.mock("ethereum-blockies-base64", () => ({
  default: vi.fn((address: string) => `data:image/png;base64,blockie-${address}`),
}));

// Mock hooks
const mockUseToken = vi.fn();
const mockUseEnsName = vi.fn();
const mockUseEnsAddress = vi.fn();
const mockUseEnsAvatar = vi.fn();

vi.mock("~/hooks/use-token", () => ({
  useToken: (config: unknown) => mockUseToken(config),
}));

// Stub the token-price context — these tests don't assert on USD output and
// shouldn't need a full <TokenPriceProvider>/QueryClientProvider chain.
vi.mock("~/context/token-price-provider", () => ({
  usePrice: () => ({ price: undefined, isPending: false }),
}));

vi.mock("wagmi", () => ({
  useEnsName: (config: unknown) => mockUseEnsName(config),
  useEnsAddress: (config: unknown) => mockUseEnsAddress(config),
  useEnsAvatar: (config: unknown) => mockUseEnsAvatar(config),
}));

// Mock ChainIcon component
vi.mock("~/components/chain/chain-icon", () => ({
  ChainIcon: ({ chain, className }: { chain: string; className?: string }) => (
    <div data-testid="chain-icon" data-chain={chain} className={className} />
  ),
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

describe("TokenCard", () => {
  const baseToken: TokenAmount = {
    token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as `0x${string}`,
    amount: 1000000n,
    chainId: 1,
    walletAddress: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" as `0x${string}`,
    symbol: "USDC",
    decimals: 6,
    name: "USD Coin",
    unitaryPrice: 1.0,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockUseToken.mockReturnValue({ data: undefined });
    mockUseEnsName.mockReturnValue({ data: undefined });
    mockUseEnsAddress.mockReturnValue({ data: undefined });
    mockUseEnsAvatar.mockReturnValue({ data: undefined, isLoading: false });
  });

  describe("rendering", () => {
    test("renders with valid token data", () => {
      mockUseToken.mockReturnValue({
        data: { symbol: "USDC", decimals: 6, name: "USD Coin" },
      });

      const { container } = renderWithQueryClient(<TokenCard token={baseToken} />);

      expect(container).toBeInTheDocument();
      expect(container.querySelector('[data-slot="avatar"]')).toBeInTheDocument();
    });

    test("renders with native token (zero address)", () => {
      const nativeToken: TokenAmount = {
        ...baseToken,
        token: zeroAddress,
        symbol: "ETH",
      };

      const { container } = renderWithQueryClient(<TokenCard token={nativeToken} />);

      expect(container).toBeInTheDocument();
      expect(container.querySelector('[data-slot="avatar"]')).toBeInTheDocument();
    });

    test("renders with label", () => {
      mockUseToken.mockReturnValue({
        data: { symbol: "USDC", decimals: 6, name: "USD Coin" },
      });

      const { getByText } = renderWithQueryClient(<TokenCard token={baseToken} label="Source" />);

      expect(getByText("Source")).toBeInTheDocument();
    });

    test("renders without label when not provided", () => {
      mockUseToken.mockReturnValue({
        data: { symbol: "USDC", decimals: 6, name: "USD Coin" },
      });

      const { queryByText } = renderWithQueryClient(<TokenCard token={baseToken} />);

      expect(queryByText("Source")).not.toBeInTheDocument();
    });

    test("renders chain information", () => {
      mockUseToken.mockReturnValue({
        data: { symbol: "USDC", decimals: 6, name: "USD Coin" },
      });

      const { getByTestId, getByText } = renderWithQueryClient(<TokenCard token={baseToken} />);

      const chainIcon = getByTestId("chain-icon");
      expect(chainIcon).toBeInTheDocument();
      expect(chainIcon).toHaveAttribute("data-chain", "Ethereum");
      expect(getByText("Ethereum")).toBeInTheDocument();
    });

    test("renders wallet address", () => {
      mockUseToken.mockReturnValue({
        data: { symbol: "USDC", decimals: 6, name: "USD Coin" },
      });

      const { container } = renderWithQueryClient(<TokenCard token={baseToken} />);

      // Check that AddressDisplay components are rendered
      expect(container.querySelector('[data-slot="avatar"]')).toBeInTheDocument();
    });
  });

  describe("token amount display", () => {
    test("renders amount when greater than 0", () => {
      mockUseToken.mockReturnValue({
        data: { symbol: "USDC", decimals: 6, name: "USD Coin" },
      });

      const { container } = renderWithQueryClient(<TokenCard token={baseToken} />);

      expect(container).toBeInTheDocument();
      // TokenDisplayAmount should be rendered
    });

    test("does not render amount when 0", () => {
      mockUseToken.mockReturnValue({
        data: { symbol: "USDC", decimals: 6, name: "USD Coin" },
      });

      const zeroToken: TokenAmount = {
        ...baseToken,
        amount: 0n,
      };

      const { container } = renderWithQueryClient(<TokenCard token={zeroToken} />);

      expect(container).toBeInTheDocument();
      // Amount display should not be in ml-auto span
      expect(container.querySelector(".ml-auto")).not.toBeInTheDocument();
    });

    test("renders amount with unitary price", () => {
      mockUseToken.mockReturnValue({
        data: { symbol: "USDC", decimals: 6, name: "USD Coin" },
      });

      const tokenWithPrice: TokenAmount = {
        ...baseToken,
        amount: 1000000000n,
        unitaryPrice: 1.0,
      };

      const { container } = renderWithQueryClient(<TokenCard token={tokenWithPrice} />);

      expect(container).toBeInTheDocument();
    });

    test("renders amount without unitary price", () => {
      mockUseToken.mockReturnValue({
        data: { symbol: "USDC", decimals: 6, name: "USD Coin" },
      });

      const tokenWithoutPrice: TokenAmount = {
        ...baseToken,
        amount: 1000000000n,
        unitaryPrice: undefined,
      };

      const { container } = renderWithQueryClient(<TokenCard token={tokenWithoutPrice} />);

      expect(container).toBeInTheDocument();
    });
  });

  describe("token data loading", () => {
    test("returns null when non-zero address token has no data", () => {
      mockUseToken.mockReturnValue({ data: undefined });

      const { container } = renderWithQueryClient(<TokenCard token={baseToken} />);

      expect(container.firstChild).toBeNull();
    });

    test("renders when token data is loaded", () => {
      mockUseToken.mockReturnValue({
        data: { symbol: "USDC", decimals: 6, name: "USD Coin" },
      });

      const { container } = renderWithQueryClient(<TokenCard token={baseToken} />);

      expect(container.firstChild).not.toBeNull();
    });

    test("does not require token data for zero address", () => {
      mockUseToken.mockReturnValue({ data: undefined });

      const nativeToken: TokenAmount = {
        ...baseToken,
        token: zeroAddress,
        symbol: "ETH",
      };

      const { container } = renderWithQueryClient(<TokenCard token={nativeToken} />);

      expect(container.firstChild).not.toBeNull();
    });

    test("calls useToken with correct config for non-zero address", () => {
      renderWithQueryClient(<TokenCard token={baseToken} />);

      expect(mockUseToken).toHaveBeenCalledWith({
        address: baseToken.token,
        chainId: baseToken.chainId,
        query: {
          enabled: true,
        },
      });
    });

    test("calls useToken with disabled query for zero address", () => {
      const nativeToken: TokenAmount = {
        ...baseToken,
        token: zeroAddress,
        symbol: "ETH",
      };

      renderWithQueryClient(<TokenCard token={nativeToken} />);

      expect(mockUseToken).toHaveBeenCalledWith({
        address: zeroAddress,
        chainId: nativeToken.chainId,
        query: {
          enabled: false,
        },
      });
    });
  });

  describe("chain handling", () => {
    test("displays chain name for known chain", () => {
      mockUseToken.mockReturnValue({
        data: { symbol: "USDC", decimals: 6, name: "USD Coin" },
      });

      const { getByText } = renderWithQueryClient(<TokenCard token={baseToken} />);

      expect(getByText("Ethereum")).toBeInTheDocument();
    });

    test("displays fallback for unknown chain", () => {
      mockUseToken.mockReturnValue({
        data: { symbol: "USDC", decimals: 6, name: "USD Coin" },
      });

      const unknownChainToken: TokenAmount = {
        ...baseToken,
        chainId: 99999,
      };

      const { getByText } = renderWithQueryClient(<TokenCard token={unknownChainToken} />);

      expect(getByText("Chain 99999")).toBeInTheDocument();
    });

    test("renders ChainIcon with correct chain name", () => {
      mockUseToken.mockReturnValue({
        data: { symbol: "USDC", decimals: 6, name: "USD Coin" },
      });

      const { getByTestId } = renderWithQueryClient(<TokenCard token={baseToken} />);

      const chainIcon = getByTestId("chain-icon");
      expect(chainIcon).toHaveAttribute("data-chain", "Ethereum");
    });

    test("renders ChainIcon with fallback chain name", () => {
      mockUseToken.mockReturnValue({
        data: { symbol: "USDC", decimals: 6, name: "USD Coin" },
      });

      const unknownChainToken: TokenAmount = {
        ...baseToken,
        chainId: 99999,
      };

      const { getByTestId } = renderWithQueryClient(<TokenCard token={unknownChainToken} />);

      const chainIcon = getByTestId("chain-icon");
      expect(chainIcon).toHaveAttribute("data-chain", "Chain 99999");
    });
  });

  describe("label handling", () => {
    test("renders label with correct styling", () => {
      mockUseToken.mockReturnValue({
        data: { symbol: "USDC", decimals: 6, name: "USD Coin" },
      });

      const { getByText } = renderWithQueryClient(<TokenCard token={baseToken} label="Source" />);

      const labelElement = getByText("Source");
      expect(labelElement).toHaveClass("text-xs");
      expect(labelElement).toHaveClass("px-1.5");
      expect(labelElement).toHaveClass("py-0.5");
      expect(labelElement).toHaveClass("rounded");
      expect(labelElement).toHaveClass("bg-muted");
      expect(labelElement).toHaveClass("text-muted-foreground");
      expect(labelElement).toHaveClass("font-medium");
    });

    test("renders multiple labels correctly", () => {
      mockUseToken.mockReturnValue({
        data: { symbol: "USDC", decimals: 6, name: "USD Coin" },
      });

      const { getByText, rerender } = renderWithQueryClient(<TokenCard token={baseToken} label="Source" />);

      expect(getByText("Source")).toBeInTheDocument();

      rerender(
        <QueryClientProvider
          client={
            new QueryClient({
              defaultOptions: { queries: { retry: false } },
            })
          }
        >
          <TokenCard token={baseToken} label="Destination" />
        </QueryClientProvider>,
      );

      expect(getByText("Destination")).toBeInTheDocument();
    });
  });

  describe("component structure", () => {
    test("renders with correct container classes", () => {
      mockUseToken.mockReturnValue({
        data: { symbol: "USDC", decimals: 6, name: "USD Coin" },
      });

      const { container } = renderWithQueryClient(<TokenCard token={baseToken} />);

      const card = container.querySelector(".bg-background");
      expect(card).toBeInTheDocument();
      expect(card).toHaveClass("rounded-lg");
      expect(card).toHaveClass("border");
      expect(card).toHaveClass("border-border");
      expect(card).toHaveClass("p-3");
      expect(card).toHaveClass("space-y-2");
    });

    test("contains TokenDisplayRoot", () => {
      mockUseToken.mockReturnValue({
        data: { symbol: "USDC", decimals: 6, name: "USD Coin" },
      });

      const { container } = renderWithQueryClient(<TokenCard token={baseToken} />);

      // TokenDisplayRoot renders a div with flex items-center
      expect(container.querySelector(".flex.items-center")).toBeInTheDocument();
    });

    test("contains TokenDisplayIcon", () => {
      mockUseToken.mockReturnValue({
        data: { symbol: "USDC", decimals: 6, name: "USD Coin" },
      });

      const { container } = renderWithQueryClient(<TokenCard token={baseToken} />);

      // TokenDisplayIcon should render an avatar
      expect(container.querySelector('[data-slot="avatar"]')).toBeInTheDocument();
    });

    test("contains AddressDisplayRoot for wallet", () => {
      mockUseToken.mockReturnValue({
        data: { symbol: "USDC", decimals: 6, name: "USD Coin" },
      });

      const { container } = renderWithQueryClient(<TokenCard token={baseToken} />);

      // AddressDisplay should render avatar
      expect(container.querySelector('[data-slot="avatar"]')).toBeInTheDocument();
    });
  });

  describe("edge cases", () => {
    test("handles very large amounts", () => {
      mockUseToken.mockReturnValue({
        data: { symbol: "USDC", decimals: 6, name: "USD Coin" },
      });

      const largeToken: TokenAmount = {
        ...baseToken,
        amount: 1000000000000000000n,
      };

      const { container } = renderWithQueryClient(<TokenCard token={largeToken} />);

      expect(container.firstChild).not.toBeNull();
    });

    test("handles very small amounts", () => {
      mockUseToken.mockReturnValue({
        data: { symbol: "USDC", decimals: 6, name: "USD Coin" },
      });

      const smallToken: TokenAmount = {
        ...baseToken,
        amount: 1n,
      };

      const { container } = renderWithQueryClient(<TokenCard token={smallToken} />);

      expect(container.firstChild).not.toBeNull();
    });

    test("handles token without name", () => {
      mockUseToken.mockReturnValue({
        data: { symbol: "USDC", decimals: 6, name: undefined },
      });

      const tokenWithoutName: TokenAmount = {
        ...baseToken,
        name: undefined,
      };

      const { container } = renderWithQueryClient(<TokenCard token={tokenWithoutName} />);

      expect(container.firstChild).not.toBeNull();
    });

    test("handles long token symbols", () => {
      mockUseToken.mockReturnValue({
        data: { symbol: "VERYLONGTOKENSYMBOL", decimals: 18, name: "Very Long Token" },
      });

      const longSymbolToken: TokenAmount = {
        ...baseToken,
        symbol: "VERYLONGTOKENSYMBOL",
      };

      const { container } = renderWithQueryClient(<TokenCard token={longSymbolToken} />);

      expect(container.firstChild).not.toBeNull();
    });

    test("handles long labels", () => {
      mockUseToken.mockReturnValue({
        data: { symbol: "USDC", decimals: 6, name: "USD Coin" },
      });

      const longLabel = "This is a very long label that might cause layout issues";
      const { getByText } = renderWithQueryClient(<TokenCard token={baseToken} label={longLabel} />);

      expect(getByText(longLabel)).toBeInTheDocument();
    });

    test("handles missing wallet address", () => {
      mockUseToken.mockReturnValue({
        data: { symbol: "USDC", decimals: 6, name: "USD Coin" },
      });

      const tokenWithEmptyWallet: TokenAmount = {
        ...baseToken,
        walletAddress: "0x0000000000000000000000000000000000000000" as `0x${string}`,
      };

      const { container } = renderWithQueryClient(<TokenCard token={tokenWithEmptyWallet} />);

      expect(container.firstChild).not.toBeNull();
    });
  });

  describe("different chains", () => {
    test("renders Polygon token", () => {
      mockUseToken.mockReturnValue({
        data: { symbol: "USDC", decimals: 6, name: "USD Coin" },
      });

      const polygonToken: TokenAmount = {
        ...baseToken,
        chainId: 137,
      };

      const { getByText } = renderWithQueryClient(<TokenCard token={polygonToken} />);

      expect(getByText("Polygon")).toBeInTheDocument();
    });

    test("renders Arbitrum token", () => {
      mockUseToken.mockReturnValue({
        data: { symbol: "USDC", decimals: 6, name: "USD Coin" },
      });

      const arbitrumToken: TokenAmount = {
        ...baseToken,
        chainId: 42161,
      };

      const { getByText } = renderWithQueryClient(<TokenCard token={arbitrumToken} />);

      expect(getByText("Arbitrum One")).toBeInTheDocument();
    });

    test("renders Optimism token", () => {
      mockUseToken.mockReturnValue({
        data: { symbol: "USDC", decimals: 6, name: "USD Coin" },
      });

      const optimismToken: TokenAmount = {
        ...baseToken,
        chainId: 10,
      };

      const { getByText } = renderWithQueryClient(<TokenCard token={optimismToken} />);

      expect(getByText("OP Mainnet")).toBeInTheDocument();
    });
  });

  describe("token symbols", () => {
    test("handles ETH symbol", () => {
      mockUseToken.mockReturnValue({
        data: { symbol: "ETH", decimals: 18, name: "Ether" },
      });

      const ethToken: TokenAmount = {
        ...baseToken,
        symbol: "ETH",
        decimals: 18,
      };

      const { container } = renderWithQueryClient(<TokenCard token={ethToken} />);

      expect(container.firstChild).not.toBeNull();
    });

    test("handles USDT symbol", () => {
      mockUseToken.mockReturnValue({
        data: { symbol: "USDT", decimals: 6, name: "Tether USD" },
      });

      const usdtToken: TokenAmount = {
        ...baseToken,
        symbol: "USDT",
      };

      const { container } = renderWithQueryClient(<TokenCard token={usdtToken} />);

      expect(container.firstChild).not.toBeNull();
    });

    test("handles DAI symbol", () => {
      mockUseToken.mockReturnValue({
        data: { symbol: "DAI", decimals: 18, name: "Dai Stablecoin" },
      });

      const daiToken: TokenAmount = {
        ...baseToken,
        symbol: "DAI",
        decimals: 18,
      };

      const { container } = renderWithQueryClient(<TokenCard token={daiToken} />);

      expect(container.firstChild).not.toBeNull();
    });
  });
});
