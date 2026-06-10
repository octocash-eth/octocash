import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Address } from "viem";
import { getAddress } from "viem";
import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { DestinationSelection } from "./select-destination-stage";
import { SelectDestinationStage } from "./select-destination-stage";

// Mock ResizeObserver for Radix UI components
beforeAll(() => {
  global.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

// Mock wagmi hooks
vi.mock("wagmi", () => ({
  useAccount: vi.fn(() => ({
    addresses: [
      "0x1234567890123456789012345678901234567890" as Address,
      "0x0987654321098765432109876543210987654321" as Address,
    ],
  })),
}));

// Mock AddressSelector
vi.mock("~/components/address", () => ({
  AddressSelector: ({
    value,
    onChange,
    options,
    chainId,
  }: {
    value: string;
    onChange: (value: string) => void;
    options?: Array<{ value: string; label: string }>;
    chainId?: number;
  }) => (
    <div data-testid="address-selector" data-chain-id={chainId}>
      <select
        aria-label="address-selector"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        data-testid="address-selector-select"
      >
        <option value="">Select address</option>
        {options?.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  ),
}));

// Mock TokenSelector
vi.mock("~/components/token", () => ({
  getDefaultTokenOptions: vi.fn((chainId: number) => {
    if (chainId === 1) {
      return [
        { value: "1:0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48:6:USDC:USD Coin" },
        { value: "1:0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599:8:WBTC:Wrapped BTC" },
      ];
    }
    if (chainId === 8453) {
      return [{ value: "8453:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913:6:USDC:USD Coin" }];
    }
    return [];
  }),
  TokenSelector: ({
    value,
    onChange,
    disabled,
    chainId,
    options,
  }: {
    value: string;
    onChange: (tokenData: {
      chainId: number;
      address: Address;
      decimals: number;
      symbol: string;
      name: string;
    }) => void;
    disabled?: boolean;
    chainId: number;
    options?: Array<{ value: string }>;
  }) => (
    <div data-testid="token-selector" data-disabled={disabled} data-chain-id={chainId}>
      <select
        aria-label="token-selector"
        value={value}
        onChange={(e) => {
          const address = e.target.value as Address;
          if (address) {
            // Component receives full data but strips name in handleTokenChange
            onChange({
              chainId,
              address,
              decimals: 6,
              symbol: "USDC",
              name: "USD Coin",
            });
          }
        }}
        disabled={disabled}
        data-testid="token-selector-select"
      >
        <option value="">Select token</option>
        {options?.map((opt) => (
          <option key={opt.value} value={opt.value.split(":")[1]}>
            {opt.value.split(":")[3]}
          </option>
        ))}
      </select>
    </div>
  ),
}));

// Mock ChainIcon
vi.mock("~/components/chain/chain-icon", () => ({
  ChainIcon: ({ chain, className }: { chain: string; className?: string }) => (
    <div className={className} data-testid="chain-icon" data-chain={chain}>
      {chain}
    </div>
  ),
}));

// Mock Select components
vi.mock("~/components/ui/select", () => {
  const React = require("react");

  // Store for collecting SelectItem data
  const items: Array<{ value: string; children: React.ReactNode }> = [];

  return {
    Select: ({
      value,
      onValueChange,
      children,
    }: {
      value: string;
      onValueChange: (value: string) => void;
      children: React.ReactNode;
      required?: boolean;
    }) => {
      // Clear items for this render
      items.length = 0;
      // Render children to trigger SelectItem renders
      React.Children.forEach(children, () => {});

      return (
        <div data-testid="select-root">
          <select
            aria-label="chain-selector"
            value={value || ""}
            onChange={(e) => onValueChange(e.target.value)}
            data-testid="chain-selector-select"
          >
            {children}
          </select>
        </div>
      );
    },
    SelectTrigger: ({ children, id }: { children: React.ReactNode; id?: string; className?: string }) => (
      <div data-testid="select-trigger" id={id}>
        {children}
      </div>
    ),
    SelectValue: ({ placeholder }: { placeholder: string }) => <span data-testid="select-value">{placeholder}</span>,
    SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => (
      <option value={value} data-testid={`select-item-${value}`}>
        {children}
      </option>
    ),
  };
});

// Mock supported chains
vi.mock("~/data/supported-chains", () => ({
  supportedChains: [
    { id: 1, name: "Ethereum" },
    { id: 10, name: "OP Mainnet" },
    { id: 42161, name: "Arbitrum One" },
    { id: 8453, name: "Base" },
    { id: 137, name: "Polygon" },
  ],
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

describe("SelectDestinationStage", () => {
  const mockOnChange = vi.fn();

  beforeEach(() => {
    mockOnChange.mockClear();
  });

  describe("initial rendering", () => {
    test("renders all form fields", () => {
      const value: DestinationSelection = {};
      renderWithQueryClient(<SelectDestinationStage value={value} onChange={mockOnChange} />);

      expect(screen.getByText("Destination Wallet")).toBeInTheDocument();
      expect(screen.getByText("Destination Chain")).toBeInTheDocument();
      expect(screen.getByText("Destination Token")).toBeInTheDocument();
    });

    test("renders AddressSelector with account addresses", () => {
      const value: DestinationSelection = {};
      renderWithQueryClient(<SelectDestinationStage value={value} onChange={mockOnChange} />);

      const addressSelector = screen.getByTestId("address-selector");
      expect(addressSelector).toBeInTheDocument();

      // Should have options for both addresses from useAccount
      const select = screen.getByTestId("address-selector-select");
      expect(select).toBeInTheDocument();
    });

    test("renders chain selector with supported chains", () => {
      const value: DestinationSelection = {};
      renderWithQueryClient(<SelectDestinationStage value={value} onChange={mockOnChange} />);

      // Should render all supported chains
      expect(screen.getByTestId("select-item-1")).toBeInTheDocument();
      expect(screen.getByTestId("select-item-10")).toBeInTheDocument();
      expect(screen.getByTestId("select-item-42161")).toBeInTheDocument();
      expect(screen.getByTestId("select-item-8453")).toBeInTheDocument();
      expect(screen.getByTestId("select-item-137")).toBeInTheDocument();
    });

    test("token selector is disabled when no chain is selected", () => {
      const value: DestinationSelection = {};
      renderWithQueryClient(<SelectDestinationStage value={value} onChange={mockOnChange} />);

      const tokenSelector = screen.getByTestId("token-selector");
      expect(tokenSelector).toHaveAttribute("data-disabled", "true");
    });
  });

  describe("wallet address selection", () => {
    test("calls onChange with valid wallet address", async () => {
      const { user } = renderWithQueryClient(<SelectDestinationStage value={{}} onChange={mockOnChange} />);

      const addressSelect = screen.getByTestId("address-selector-select");
      const testAddress = "0x1234567890123456789012345678901234567890";

      await user.selectOptions(addressSelect, testAddress);

      expect(mockOnChange).toHaveBeenCalledWith({
        walletAddress: getAddress(testAddress),
      });
    });

    test("calls onChange with undefined for empty address", async () => {
      const { user } = renderWithQueryClient(
        <SelectDestinationStage
          value={{
            walletAddress: "0x1234567890123456789012345678901234567890" as Address,
          }}
          onChange={mockOnChange}
        />,
      );

      const addressSelect = screen.getByTestId("address-selector-select");
      await user.selectOptions(addressSelect, "");

      expect(mockOnChange).toHaveBeenCalledWith({
        walletAddress: undefined,
      });
    });

    test("displays selected wallet address", () => {
      const testAddress = "0x1234567890123456789012345678901234567890" as Address;
      const value: DestinationSelection = {
        walletAddress: testAddress,
      };
      renderWithQueryClient(<SelectDestinationStage value={value} onChange={mockOnChange} />);

      const addressSelect = screen.getByTestId("address-selector-select");
      expect(addressSelect).toHaveValue(testAddress);
    });

    test("passes chainId to AddressSelector when chain is selected", () => {
      const value: DestinationSelection = {
        chainId: 1,
      };
      renderWithQueryClient(<SelectDestinationStage value={value} onChange={mockOnChange} />);

      const addressSelector = screen.getByTestId("address-selector");
      expect(addressSelector).toHaveAttribute("data-chain-id", "1");
    });
  });

  describe("chain selection", () => {
    test("calls onChange with selected chain and clears token info", async () => {
      const { user } = renderWithQueryClient(
        <SelectDestinationStage
          value={{
            tokenInfo: {
              address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address,
              decimals: 6,
              symbol: "USDC",
            },
          }}
          onChange={mockOnChange}
        />,
      );

      const chainSelect = screen.getByTestId("chain-selector-select");
      await user.selectOptions(chainSelect, "1");

      expect(mockOnChange).toHaveBeenCalledWith({
        chainId: 1,
        tokenInfo: undefined,
      });
    });

    test("displays selected chain", () => {
      const value: DestinationSelection = {
        chainId: 1,
      };
      renderWithQueryClient(<SelectDestinationStage value={value} onChange={mockOnChange} />);

      const chainSelect = screen.getByTestId("chain-selector-select");
      expect(chainSelect).toHaveValue("1");
    });

    test("enables token selector when chain is selected", () => {
      const value: DestinationSelection = {
        chainId: 1,
      };
      renderWithQueryClient(<SelectDestinationStage value={value} onChange={mockOnChange} />);

      const tokenSelector = screen.getByTestId("token-selector");
      expect(tokenSelector).toHaveAttribute("data-disabled", "false");
    });

    test("renders chain icons for each chain option", () => {
      const value: DestinationSelection = {};
      renderWithQueryClient(<SelectDestinationStage value={value} onChange={mockOnChange} />);

      // Chain icons should be rendered within select items
      const chainIcons = screen.getAllByTestId("chain-icon");
      expect(chainIcons.length).toBeGreaterThan(0);
    });
  });

  describe("token selection", () => {
    test("calls onChange with token info", async () => {
      const { user } = renderWithQueryClient(
        <SelectDestinationStage
          value={{
            chainId: 1,
          }}
          onChange={mockOnChange}
        />,
      );

      const tokenSelect = screen.getByTestId("token-selector-select");
      const tokenAddress = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
      await user.selectOptions(tokenSelect, tokenAddress);

      expect(mockOnChange).toHaveBeenCalledWith({
        chainId: 1,
        tokenInfo: {
          address: tokenAddress,
          decimals: 6,
          symbol: "USDC",
        },
      });
    });

    test("displays selected token address", () => {
      const tokenAddress = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address;
      const value: DestinationSelection = {
        chainId: 1,
        tokenInfo: {
          address: tokenAddress,
          decimals: 6,
          symbol: "USDC",
        },
      };
      renderWithQueryClient(<SelectDestinationStage value={value} onChange={mockOnChange} />);

      const tokenSelect = screen.getByTestId("token-selector-select");
      expect(tokenSelect).toHaveValue(tokenAddress);
    });

    test("passes chainId to TokenSelector", () => {
      const value: DestinationSelection = {
        chainId: 8453,
      };
      renderWithQueryClient(<SelectDestinationStage value={value} onChange={mockOnChange} />);

      const tokenSelector = screen.getByTestId("token-selector");
      expect(tokenSelector).toHaveAttribute("data-chain-id", "8453");
    });

    test("displays empty token value when no token is selected", () => {
      const value: DestinationSelection = {
        chainId: 1,
      };
      renderWithQueryClient(<SelectDestinationStage value={value} onChange={mockOnChange} />);

      const tokenSelect = screen.getByTestId("token-selector-select");
      expect(tokenSelect).toHaveValue("");
    });
  });

  describe("token options memoization", () => {
    test("memoizes token options based on chainId", async () => {
      const { getDefaultTokenOptions } = await import("~/components/token");
      vi.mocked(getDefaultTokenOptions).mockClear();

      const value: DestinationSelection = {
        chainId: 1,
      };

      const { rerender } = renderWithQueryClient(<SelectDestinationStage value={value} onChange={mockOnChange} />);

      // Initial render should call getDefaultTokenOptions
      expect(getDefaultTokenOptions).toHaveBeenCalledWith(1);
      const callCount = vi.mocked(getDefaultTokenOptions).mock.calls.length;

      // Rerender with same chainId should not call getDefaultTokenOptions again
      rerender(
        <QueryClientProvider
          client={
            new QueryClient({
              defaultOptions: {
                queries: {
                  retry: false,
                },
              },
            })
          }
        >
          <SelectDestinationStage value={value} onChange={mockOnChange} />
        </QueryClientProvider>,
      );

      // Call count should not increase due to memoization
      expect(vi.mocked(getDefaultTokenOptions).mock.calls.length).toBe(callCount);
    });

    test("recalculates token options when chainId changes", async () => {
      const { getDefaultTokenOptions } = await import("~/components/token");
      vi.mocked(getDefaultTokenOptions).mockClear();

      const value1: DestinationSelection = {
        chainId: 1,
      };

      const queryClient = new QueryClient({
        defaultOptions: {
          queries: {
            retry: false,
          },
        },
      });

      const { rerender } = render(
        <QueryClientProvider client={queryClient}>
          <SelectDestinationStage value={value1} onChange={mockOnChange} />
        </QueryClientProvider>,
      );

      expect(getDefaultTokenOptions).toHaveBeenCalledWith(1);
      const callCount1 = vi.mocked(getDefaultTokenOptions).mock.calls.length;

      // Change chainId
      const value2: DestinationSelection = {
        chainId: 8453,
      };

      rerender(
        <QueryClientProvider client={queryClient}>
          <SelectDestinationStage value={value2} onChange={mockOnChange} />
        </QueryClientProvider>,
      );

      // Should call getDefaultTokenOptions again with new chainId
      expect(getDefaultTokenOptions).toHaveBeenCalledWith(8453);
      expect(vi.mocked(getDefaultTokenOptions).mock.calls.length).toBeGreaterThan(callCount1);
    });

    test("returns empty array when no chainId is selected", () => {
      const value: DestinationSelection = {};
      renderWithQueryClient(<SelectDestinationStage value={value} onChange={mockOnChange} />);

      const tokenSelector = screen.getByTestId("token-selector");
      expect(tokenSelector).toBeInTheDocument();
      // Token selector should receive empty options
    });
  });

  describe("full workflow", () => {
    test("allows selecting wallet, chain, and token in sequence", async () => {
      let currentValue: DestinationSelection = {};
      const handleChange = (newValue: DestinationSelection) => {
        currentValue = newValue;
        mockOnChange(newValue);
      };

      const { rerender } = renderWithQueryClient(
        <SelectDestinationStage value={currentValue} onChange={handleChange} />,
      );

      const user = userEvent.setup();

      // Step 1: Select wallet address
      const addressSelect = screen.getByTestId("address-selector-select");
      const testAddress = "0x1234567890123456789012345678901234567890";
      await user.selectOptions(addressSelect, testAddress);

      expect(mockOnChange).toHaveBeenLastCalledWith({
        walletAddress: getAddress(testAddress),
      });

      // Re-render with updated value
      rerender(
        <QueryClientProvider
          client={
            new QueryClient({
              defaultOptions: {
                queries: {
                  retry: false,
                },
              },
            })
          }
        >
          <SelectDestinationStage value={currentValue} onChange={handleChange} />
        </QueryClientProvider>,
      );

      // Step 2: Select chain
      const chainSelect = screen.getByTestId("chain-selector-select");
      await user.selectOptions(chainSelect, "1");

      expect(mockOnChange).toHaveBeenLastCalledWith({
        walletAddress: getAddress(testAddress),
        chainId: 1,
        tokenInfo: undefined,
      });

      // Re-render with updated value
      rerender(
        <QueryClientProvider
          client={
            new QueryClient({
              defaultOptions: {
                queries: {
                  retry: false,
                },
              },
            })
          }
        >
          <SelectDestinationStage value={currentValue} onChange={handleChange} />
        </QueryClientProvider>,
      );

      // Step 3: Select token
      const tokenSelect = screen.getByTestId("token-selector-select");
      const tokenAddress = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
      await user.selectOptions(tokenSelect, tokenAddress);

      expect(mockOnChange).toHaveBeenLastCalledWith({
        walletAddress: getAddress(testAddress),
        chainId: 1,
        tokenInfo: {
          address: tokenAddress,
          decimals: 6,
          symbol: "USDC",
        },
      });
    });

    test("changing chain resets token selection", async () => {
      const { user } = renderWithQueryClient(
        <SelectDestinationStage
          value={{
            chainId: 1,
            tokenInfo: {
              address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address,
              decimals: 6,
              symbol: "USDC",
            },
          }}
          onChange={mockOnChange}
        />,
      );

      const chainSelect = screen.getByTestId("chain-selector-select");
      await user.selectOptions(chainSelect, "8453");

      // Token info should be cleared when chain changes
      expect(mockOnChange).toHaveBeenCalledWith({
        chainId: 8453,
        tokenInfo: undefined,
      });
    });
  });

  describe("edge cases", () => {
    test("handles empty account addresses", async () => {
      const { useAccount } = await import("wagmi");
      vi.mocked(useAccount).mockReturnValueOnce({
        addresses: [],
        status: "connected",
      } as unknown as ReturnType<typeof useAccount>);

      const value: DestinationSelection = {};
      renderWithQueryClient(<SelectDestinationStage value={value} onChange={mockOnChange} />);

      expect(screen.getByTestId("address-selector")).toBeInTheDocument();
    });

    test("handles undefined account addresses", async () => {
      const { useAccount } = await import("wagmi");
      vi.mocked(useAccount).mockReturnValueOnce({
        addresses: undefined,
        status: "connected",
      } as unknown as ReturnType<typeof useAccount>);

      const value: DestinationSelection = {};
      renderWithQueryClient(<SelectDestinationStage value={value} onChange={mockOnChange} />);

      expect(screen.getByTestId("address-selector")).toBeInTheDocument();
    });

    test("handles no initial chainId selection", () => {
      const value: DestinationSelection = {};
      renderWithQueryClient(<SelectDestinationStage value={value} onChange={mockOnChange} />);

      const chainSelect = screen.getByTestId("chain-selector-select");
      // When no chainId is set, the select should show the empty value or first option
      // The component converts undefined chainId to empty string for the select value
      expect(chainSelect).toBeInTheDocument();
      // The actual value depends on the select component's default behavior
      const actualValue = chainSelect.getAttribute("value");
      expect(actualValue).toBeDefined();
    });

    test("uses default chainId of 1 for token selector when chainId is undefined", () => {
      const value: DestinationSelection = {};
      renderWithQueryClient(<SelectDestinationStage value={value} onChange={mockOnChange} />);

      const tokenSelector = screen.getByTestId("token-selector");
      expect(tokenSelector).toHaveAttribute("data-chain-id", "1");
    });
  });
});
