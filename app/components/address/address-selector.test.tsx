import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import { AddressSelector, formatAddressValue, parseAddressValue } from "./address-selector";

// Mock wagmi hooks
vi.mock("wagmi", async () => {
  const actual = await vi.importActual("wagmi");
  return {
    ...actual,
    useEnsAddress: vi.fn(() => ({ data: undefined })),
    useEnsName: vi.fn(() => ({ data: undefined })),
    usePublicClient: vi.fn(() => ({
      getEnsName: vi.fn(() => Promise.resolve(null)),
      getEnsAddress: vi.fn(() => Promise.resolve(null)),
    })),
  };
});

// Mock AddressDisplay components to avoid WagmiProvider requirement
vi.mock("~/components/address/address-display", () => {
  const React = require("react");

  // Create a context to pass the address
  const AddressContext = React.createContext("");

  return {
    AddressDisplayRoot: ({
      children,
      address,
      className,
    }: {
      children: React.ReactNode;
      address: string;
      className?: string;
    }) => (
      <AddressContext.Provider value={address}>
        <div className={className} data-testid="address-display-root" data-address={address}>
          {children}
        </div>
      </AddressContext.Provider>
    ),
    AddressDisplayAvatar: ({ className }: { className?: string }) => (
      <div className={className} data-testid="address-display-avatar" />
    ),
    AddressDisplayText: ({ children }: { children?: React.ReactNode }) => {
      const address = React.useContext(AddressContext);
      const displayText = children || (address ? `${address.slice(0, 6)}...${address.slice(-4)}` : "0x1234...7890");
      return <span data-testid="address-display-text">{displayText}</span>;
    },
  };
});

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

describe("formatAddressValue", () => {
  test("formats address with ENS name", () => {
    const result = formatAddressValue("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", "vitalik.eth");
    expect(result).toBe("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045:vitalik.eth");
  });

  test("formats address without ENS name", () => {
    const result = formatAddressValue("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045");
    expect(result).toBe("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045");
  });
});

describe("parseAddressValue", () => {
  test("parses address with ENS name", () => {
    const result = parseAddressValue("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045:vitalik.eth");
    expect(result).toEqual({
      address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
      ensName: "vitalik.eth",
    });
  });

  test("parses plain address", () => {
    const result = parseAddressValue("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045");
    expect(result).toEqual({
      address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
    });
  });

  test("returns null for empty value", () => {
    const result = parseAddressValue("");
    expect(result).toBeNull();
  });

  test("returns null for invalid format", () => {
    const result = parseAddressValue("invalid:format:with:too:many:colons");
    expect(result).toBeNull();
  });
});

describe("AddressSelector", () => {
  const mockOnChange = vi.fn();

  test("renders with placeholder", () => {
    renderWithQueryClient(<AddressSelector value="" onChange={mockOnChange} />);
    expect(screen.getByText("0x...")).toBeInTheDocument();
  });

  test("renders with custom placeholder", () => {
    renderWithQueryClient(<AddressSelector value="" onChange={mockOnChange} placeholder="Select address" />);
    expect(screen.getByText("Select address")).toBeInTheDocument();
  });

  test("displays selected address", () => {
    const testAddress = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
    renderWithQueryClient(<AddressSelector value={testAddress} onChange={mockOnChange} />);

    // Should show the formatted address
    const elements = screen.getAllByText(/0xd8dA/);
    expect(elements.length).toBeGreaterThan(0);
  });

  test("disabled state prevents interaction", () => {
    renderWithQueryClient(<AddressSelector value="" onChange={mockOnChange} disabled />);

    const button = screen.getByRole("button");
    expect(button).toBeDisabled();
  });

  test("formats options with ENS names for filtering", () => {
    const formattedValue = formatAddressValue("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", "vitalik.eth");
    const options = [{ value: formattedValue }];

    renderWithQueryClient(<AddressSelector value="" onChange={mockOnChange} options={options} />);

    // Component should accept formatted options
    expect(screen.getByRole("button")).toBeInTheDocument();
  });
});

describe("AddressSelector ENS functionality", () => {
  const mockOnChange = vi.fn();

  test("parses formatted value with ENS name", () => {
    const address = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
    const ensName = "vitalik.eth";
    const formatted = formatAddressValue(address, ensName);
    const parsed = parseAddressValue(formatted);

    expect(parsed).toEqual({ address, ensName });
  });

  test("displays formatted addresses with ENS names", () => {
    const address = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
    const formattedValue = formatAddressValue(address, "vitalik.eth");

    renderWithQueryClient(<AddressSelector value={formattedValue} onChange={mockOnChange} />);

    // Should display the address
    expect(screen.getByRole("button")).toBeInTheDocument();
  });

  test("allows selection of pre-formatted addresses with ENS", () => {
    const address = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
    const formattedValue = formatAddressValue(address, "vitalik.eth");
    const options = [{ value: formattedValue }];

    renderWithQueryClient(<AddressSelector value="" onChange={mockOnChange} options={options} />);

    // Component should render with the options
    expect(screen.getByRole("button")).toBeInTheDocument();
  });

  test("handles multiple addresses in options", () => {
    const addresses = ["0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0"];

    const options = addresses.map((addr) => ({ value: addr }));
    renderWithQueryClient(<AddressSelector value="" onChange={mockOnChange} options={options} />);

    // Component should render with multiple options
    expect(screen.getByRole("button")).toBeInTheDocument();
  });

  test("accepts ENS formatted options", () => {
    const formattedAddresses = [
      formatAddressValue("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", "vitalik.eth"),
      formatAddressValue("0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0", "test.eth"),
    ];

    const options = formattedAddresses.map((value) => ({ value }));
    renderWithQueryClient(<AddressSelector value="" onChange={mockOnChange} options={options} />);

    expect(screen.getByRole("button")).toBeInTheDocument();
  });
});

describe("AddressSelector validation", () => {
  const mockOnChange = vi.fn();

  test("shows error message for invalid address input", async () => {
    const { user } = renderWithQueryClient(<AddressSelector value="" onChange={mockOnChange} />);

    // Open the combobox
    const button = screen.getByRole("button");
    await user.click(button);

    // Type an invalid string (not an address, not an ENS name)
    const input = screen.getByPlaceholderText("Select or paste an address");
    await user.type(input, "not@valid!");

    // The error message should be displayed
    expect(screen.getByText('"not@valid!" is not a valid address/ENS')).toBeInTheDocument();
  });

  test("prevents adding duplicate addresses", async () => {
    const existingAddress = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
    const options = [{ value: existingAddress }];

    const { user } = renderWithQueryClient(<AddressSelector value="" onChange={mockOnChange} options={options} />);

    // Open the combobox
    const button = screen.getByRole("button");
    await user.click(button);

    // Try to add the same address
    const input = screen.getByPlaceholderText("Select or paste an address");
    await user.type(input, existingAddress);

    // The duplicate error message should be displayed
    expect(screen.getByText("Already in the list")).toBeInTheDocument();
  });

  test("prevents adding duplicate ENS names", async () => {
    const existingValue = formatAddressValue("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", "vitalik.eth");
    const options = [{ value: existingValue }];

    const { user } = renderWithQueryClient(<AddressSelector value="" onChange={mockOnChange} options={options} />);

    // Open the combobox
    const button = screen.getByRole("button");
    await user.click(button);

    // Try to add the same ENS name
    const input = screen.getByPlaceholderText("Select or paste an address");
    await user.type(input, "vitalik.eth");

    // The duplicate error message should be displayed
    expect(screen.getByText("Already in the list")).toBeInTheDocument();
  });

  test("prevents adding ENS name when address already exists", async () => {
    const address = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
    const options = [{ value: address }];

    const { user } = renderWithQueryClient(<AddressSelector value="" onChange={mockOnChange} options={options} />);

    // Open the combobox
    const button = screen.getByRole("button");
    await user.click(button);

    // Try to add an ENS name that resolves to the existing address
    const input = screen.getByPlaceholderText("Select or paste an address");
    await user.type(input, "vitalik.eth");

    // Press Enter to select the option
    // The option appears valid because validation is synchronous,
    // but handleAddressChange will prevent the duplicate after resolution
    await user.keyboard("{Enter}");

    // Wait a bit for the async resolution
    await new Promise((resolve) => setTimeout(resolve, 100));

    // The onChange should not have been called because the address already exists
    expect(mockOnChange).not.toHaveBeenCalled();
  });

  test("prevents adding address when ENS name for that address already exists", async () => {
    const address = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
    const existingValue = formatAddressValue(address, "vitalik.eth");
    const options = [{ value: existingValue }];

    const { user } = renderWithQueryClient(<AddressSelector value="" onChange={mockOnChange} options={options} />);

    // Open the combobox
    const button = screen.getByRole("button");
    await user.click(button);

    // Try to add the raw address when it already exists with an ENS name
    const input = screen.getByPlaceholderText("Select or paste an address");
    await user.type(input, address);

    // The duplicate error message should be displayed
    expect(screen.getByText("Already in the list")).toBeInTheDocument();
  });
});
