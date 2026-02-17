import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import { formatTokenValue, parseTokenValue, type TokenData, TokenSelector } from "./token-selector";

// Mock wagmi hooks
vi.mock("wagmi", () => ({
  usePublicClient: vi.fn(() => ({
    readContract: vi.fn(() => Promise.resolve(null)),
  })),
  useReadContracts: vi.fn(() => ({ data: undefined })),
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
  return {
    user: userEvent.setup(),
    ...render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>),
  };
}

describe("formatTokenValue", () => {
  test("formats token with all parameters", () => {
    const result = formatTokenValue(1, "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", 6, "USDC", "USD Coin");
    expect(result).toBe("1:0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48:6:USDC:USD Coin");
  });

  test("formats WBTC token", () => {
    const result = formatTokenValue(1, "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", 8, "WBTC", "Wrapped BTC");
    expect(result).toBe("1:0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599:8:WBTC:Wrapped BTC");
  });

  test("formats ETH token with zero address", () => {
    const result = formatTokenValue(1, "0x0000000000000000000000000000000000000000", 18, "ETH", "Ether");
    expect(result).toBe("1:0x0000000000000000000000000000000000000000:18:ETH:Ether");
  });
});

describe("parseTokenValue", () => {
  test("parses formatted token value", () => {
    const result = parseTokenValue("1:0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48:6:USDC:USD Coin");
    expect(result).toEqual({
      chainId: 1,
      address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      decimals: 6,
      symbol: "USDC",
      name: "USD Coin",
    });
  });

  test("parses token with multi-word name", () => {
    const result = parseTokenValue("1:0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599:8:WBTC:Wrapped BTC");
    expect(result).toEqual({
      chainId: 1,
      address: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
      decimals: 8,
      symbol: "WBTC",
      name: "Wrapped BTC",
    });
  });

  test("returns undefined for empty value", () => {
    const result = parseTokenValue("");
    expect(result).toBeUndefined();
  });

  test("returns undefined for invalid format", () => {
    const result = parseTokenValue("invalid-format");
    expect(result).toBeUndefined();
  });

  test("returns undefined for incomplete format", () => {
    const result = parseTokenValue("1:0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48:6");
    expect(result).toBeUndefined();
  });
});

describe("TokenSelector", () => {
  const mockOnChange = vi.fn((_tokenData: TokenData) => {});

  test("renders with placeholder", () => {
    renderWithQueryClient(<TokenSelector chainId={1} value="" onChange={mockOnChange} />);
    expect(screen.getByText("Select token...")).toBeInTheDocument();
  });

  test("renders with custom placeholder", () => {
    renderWithQueryClient(<TokenSelector chainId={1} value="" onChange={mockOnChange} placeholder="Choose a token" />);
    expect(screen.getByText("Choose a token")).toBeInTheDocument();
  });

  test("displays selected token", () => {
    const testAddress = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
    const options = [{ value: formatTokenValue(1, testAddress, 6, "USDC", "USD Coin") }];
    renderWithQueryClient(<TokenSelector chainId={1} value={testAddress} onChange={mockOnChange} options={options} />);

    // Should show the token symbol
    expect(screen.getByText("USDC")).toBeInTheDocument();
  });

  test("disabled state prevents interaction", () => {
    renderWithQueryClient(<TokenSelector chainId={1} value="" onChange={mockOnChange} disabled />);

    const button = screen.getByRole("button");
    expect(button).toBeDisabled();
  });

  test("accepts formatted token options", () => {
    const options = [
      { value: formatTokenValue(1, "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", 6, "USDC", "USD Coin") },
      { value: formatTokenValue(1, "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", 8, "WBTC", "Wrapped BTC") },
    ];

    renderWithQueryClient(<TokenSelector chainId={1} value="" onChange={mockOnChange} options={options} />);

    expect(screen.getByRole("button")).toBeInTheDocument();
  });
});

describe("TokenSelector with initial tokens", () => {
  const mockOnChange = vi.fn((_tokenData: TokenData) => {});

  test("renders with default USDC, WBTC, ETH tokens for mainnet", () => {
    renderWithQueryClient(<TokenSelector chainId={1} value="" onChange={mockOnChange} />);
    expect(screen.getByRole("button")).toBeInTheDocument();
  });

  test("renders with default tokens for Base", () => {
    renderWithQueryClient(<TokenSelector chainId={8453} value="" onChange={mockOnChange} />);
    expect(screen.getByRole("button")).toBeInTheDocument();
  });

  test("uses WETH label for Polygon", () => {
    const wethAddress = "0x11cd37bb86f65419713f30673a480ea33c826872";
    const options = [{ value: formatTokenValue(137, wethAddress, 18, "WETH", "Wrapped Ether") }];
    renderWithQueryClient(
      <TokenSelector chainId={137} value={wethAddress} onChange={mockOnChange} options={options} />,
    );

    expect(screen.getByText("WETH")).toBeInTheDocument();
  });
});

describe("TokenSelector validation", () => {
  const mockOnChange = vi.fn((_tokenData: TokenData) => {});

  test("shows error message for invalid input", async () => {
    const { user } = renderWithQueryClient(<TokenSelector chainId={1} value="" onChange={mockOnChange} />);

    // Open the combobox
    const button = screen.getByRole("button");
    await user.click(button);

    // Type an invalid string (not an address, not a valid symbol)
    const input = screen.getByPlaceholderText("Search or paste token address");
    await user.type(input, "invalid@token!");

    // The error message should be displayed
    expect(screen.getByText('"invalid@token!" is not a valid token address')).toBeInTheDocument();
  });

  test("prevents adding duplicate tokens", async () => {
    const existingToken = formatTokenValue(1, "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", 6, "USDC", "USD Coin");
    const options = [{ value: existingToken }];

    const { user } = renderWithQueryClient(
      <TokenSelector chainId={1} value="" onChange={mockOnChange} options={options} />,
    );

    // Open the combobox
    const button = screen.getByRole("button");
    await user.click(button);

    // Try to add the same token address
    const input = screen.getByPlaceholderText("Search or paste token address");
    await user.type(input, "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");

    // The duplicate error message should be displayed
    expect(screen.getByText("Token already in the list")).toBeInTheDocument();
  });

  test("prevents adding duplicate tokens by symbol", async () => {
    const existingToken = formatTokenValue(1, "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", 6, "USDC", "USD Coin");
    const options = [{ value: existingToken }];

    const { user } = renderWithQueryClient(
      <TokenSelector chainId={1} value="" onChange={mockOnChange} options={options} />,
    );

    // Open the combobox
    const button = screen.getByRole("button");
    await user.click(button);

    // Try to add the same token by symbol
    const input = screen.getByPlaceholderText("Search or paste token address");
    await user.type(input, "USDC");

    // The duplicate error message should be displayed
    expect(screen.getByText("Token already in the list")).toBeInTheDocument();
  });

  test("allows same token address on different chains", () => {
    const mainnetToken = formatTokenValue(1, "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", 6, "USDC", "USD Coin");
    const baseToken = formatTokenValue(8453, "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", 6, "USDC", "USD Coin");

    const parsed1 = parseTokenValue(mainnetToken);
    const parsed2 = parseTokenValue(baseToken);

    // Different chainIds should be treated as different tokens
    expect(parsed1?.chainId).not.toBe(parsed2?.chainId);
  });
});

describe("TokenSelector preserves user-added tokens", () => {
  const mockOnChange = vi.fn((_tokenData: TokenData) => {});

  test("preserves tokens when options reference changes", async () => {
    const user = userEvent.setup();
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });

    const initialOptions = [
      { value: formatTokenValue(1, "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", 6, "USDC", "USD Coin") },
    ];

    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <TokenSelector chainId={1} value="" onChange={mockOnChange} options={initialOptions} />
      </QueryClientProvider>,
    );

    // Open the combobox
    const button = screen.getByRole("button");
    await user.click(button);

    // Verify initial token is present
    expect(screen.getByText("USDC")).toBeInTheDocument();

    // Close the combobox by clicking outside
    await user.click(document.body);

    // Now simulate parent re-rendering with same options but different reference
    // This simulates what happens when parent calls getDefaultTokenOptions() on every render
    const newOptionsReference = [
      { value: formatTokenValue(1, "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", 6, "USDC", "USD Coin") },
    ];

    rerender(
      <QueryClientProvider client={queryClient}>
        <TokenSelector chainId={1} value="" onChange={mockOnChange} options={newOptionsReference} />
      </QueryClientProvider>,
    );

    // Re-open the combobox
    await user.click(button);

    // USDC should still be there after rerender
    expect(screen.getByText("USDC")).toBeInTheDocument();
  });

  test("resets tokens when chainId changes", async () => {
    const user = userEvent.setup();
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });

    // Add a unique custom token to mainnet that's NOT on Base
    const mainnetOptions = [
      { value: formatTokenValue(1, "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", 6, "USDC", "USD Coin") },
      { value: formatTokenValue(1, "0x6B175474E89094C44Da98b954EedeAC495271d0F", 18, "DAI", "Dai Stablecoin") },
    ];
    const baseOptions = [
      { value: formatTokenValue(8453, "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", 6, "USDC", "USD Coin") },
    ];

    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <TokenSelector chainId={1} value="" onChange={mockOnChange} options={mainnetOptions} />
      </QueryClientProvider>,
    );

    // Open the combobox on mainnet
    const button = screen.getByRole("button");
    await user.click(button);

    // Verify mainnet tokens are present (USDC and custom DAI token)
    expect(screen.getByText("USDC")).toBeInTheDocument();
    expect(screen.getByText("DAI")).toBeInTheDocument();

    // Close combobox
    await user.click(document.body);

    // Switch to Base chain with different options (no DAI)
    rerender(
      <QueryClientProvider client={queryClient}>
        <TokenSelector chainId={8453} value="" onChange={mockOnChange} options={baseOptions} />
      </QueryClientProvider>,
    );

    // Re-open the combobox
    await user.click(button);

    // Base's USDC should be present
    expect(screen.getByText("USDC")).toBeInTheDocument();

    // Mainnet's custom DAI token should NOT be present anymore
    expect(screen.queryByText("DAI")).not.toBeInTheDocument();
  });
});
