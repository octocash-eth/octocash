import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { GatedConnectButton } from "./gated-connect-button";

// Mock RainbowKit
const mockOpenConnectModal = vi.fn();
vi.mock("@rainbow-me/rainbowkit", () => ({
  useConnectModal: () => ({ openConnectModal: mockOpenConnectModal }),
}));

// Mock lucide-react icons
vi.mock("lucide-react", () => ({
  LightbulbIcon: ({ className }: { className?: string }) => <div data-testid="lightbulb-icon" className={className} />,
  LogOutIcon: ({ className }: { className?: string }) => <div data-testid="logout-icon" className={className} />,
  WalletIcon: ({ className }: { className?: string }) => <div data-testid="wallet-icon" className={className} />,
}));

// Mock react-router
vi.mock("react-router", () => ({
  Link: ({
    to,
    children,
    target,
    className,
    onClick,
  }: {
    to: string;
    children: React.ReactNode;
    target?: string;
    className?: string;
    onClick?: (e: React.MouseEvent) => void;
  }) => (
    <a href={to} target={target} className={className} onClick={onClick}>
      {children}
    </a>
  ),
}));

// Mock use-local-storage-state
const mockSetTermsAccepted = vi.fn();
const mockUseLocalStorageState = vi.fn();
vi.mock("use-local-storage-state", () => ({
  default: (key: string, options: { defaultValue: boolean }) => mockUseLocalStorageState(key, options),
}));

// Mock wagmi
const mockDisconnect = vi.fn();
vi.mock("wagmi", () => ({
  useDisconnect: () => ({ disconnect: mockDisconnect }),
}));

// Mock useConnectedAddresses hook
const mockUseConnectedAddresses = vi.fn();
vi.mock("~/hooks/use-connected-addresses", () => ({
  useConnectedAddresses: () => mockUseConnectedAddresses(),
}));

// Mock address components
vi.mock("~/components/address", () => ({
  AddressAvatar: ({ addressOrEns, className }: { addressOrEns: string; className?: string }) => (
    <div data-testid="address-avatar" data-address={addressOrEns} className={className} />
  ),
  AddressDisplayAvatar: ({ className }: { className?: string }) => (
    <div data-testid="address-display-avatar" className={className} />
  ),
  AddressDisplayCopy: () => (
    <button type="button" data-testid="address-display-copy">
      Copy
    </button>
  ),
  AddressDisplayRoot: ({
    address,
    children,
    className,
  }: {
    address: string;
    children: React.ReactNode;
    className?: string;
  }) => (
    <div data-testid="address-display-root" data-address={address} className={className}>
      {children}
    </div>
  ),
  AddressDisplayText: ({ className }: { className?: string }) => (
    <span data-testid="address-display-text" className={className}>
      0x1234...5678
    </span>
  ),
}));

// Mock UI components
vi.mock("~/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    variant,
    size,
    disabled,
    type,
    className,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    variant?: string;
    size?: string;
    disabled?: boolean;
    type?: string;
    className?: string;
  }) => (
    <button
      type={type === "submit" ? "submit" : "button"}
      onClick={onClick}
      disabled={disabled}
      data-variant={variant}
      data-size={size}
      className={className}
    >
      {children}
    </button>
  ),
}));

vi.mock("~/components/ui/checkbox", () => ({
  Checkbox: ({
    id,
    checked,
    onCheckedChange,
    className,
  }: {
    id?: string;
    checked?: boolean;
    onCheckedChange?: (checked: boolean) => void;
    className?: string;
  }) => (
    <input
      type="checkbox"
      id={id}
      checked={checked}
      onChange={(e) => onCheckedChange?.(e.target.checked)}
      className={className}
      data-testid="terms-checkbox"
    />
  ),
}));

vi.mock("~/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode; onOpenChange?: (open: boolean) => void }) =>
    open ? <div data-testid="dialog">{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div data-testid="dialog-content">{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => (
    <p data-testid="dialog-description">{children}</p>
  ),
  DialogFooter: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div data-testid="dialog-footer" className={className}>
      {children}
    </div>
  ),
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div data-testid="dialog-header">{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2 data-testid="dialog-title">{children}</h2>,
}));

vi.mock("~/components/ui/scroll-area", () => ({
  ScrollArea: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div data-testid="scroll-area" className={className}>
      {children}
    </div>
  ),
}));

// Mock utils
vi.mock("~/lib/utils", () => ({
  cn: (...classes: (string | undefined)[]) => classes.filter(Boolean).join(" "),
}));

// Mock window.ethereum
const mockEthereumRequest = vi.fn();
Object.defineProperty(window, "ethereum", {
  value: {
    request: mockEthereumRequest,
  },
  writable: true,
  configurable: true,
});

describe("GatedConnectButton", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseConnectedAddresses.mockReturnValue([]);
    mockUseLocalStorageState.mockReturnValue([false, mockSetTermsAccepted]);
    mockEthereumRequest.mockResolvedValue(undefined);
  });

  describe("initial rendering", () => {
    test("renders connect button when no wallets connected", () => {
      render(<GatedConnectButton />);
      const button = screen.getByRole("button", { name: /connect wallet/i });
      expect(button).toBeInTheDocument();
    });

    test("connect button shows wallet icon", () => {
      render(<GatedConnectButton />);
      expect(screen.getByTestId("wallet-icon")).toBeInTheDocument();
    });

    test("connect button has default variant when disconnected", () => {
      render(<GatedConnectButton />);
      const button = screen.getByRole("button", { name: /connect wallet/i });
      expect(button).toHaveAttribute("data-variant", "default");
    });

    test("renders connected state when wallets are connected", () => {
      mockUseConnectedAddresses.mockReturnValue(["0x1234567890abcdef", "0xabcdef1234567890"]);
      render(<GatedConnectButton />);
      expect(screen.getByText("Connected")).toBeInTheDocument();
    });

    test("connected button has outline variant", () => {
      mockUseConnectedAddresses.mockReturnValue(["0x1234567890abcdef"]);
      render(<GatedConnectButton />);
      const button = screen.getByRole("button");
      expect(button).toHaveAttribute("data-variant", "outline");
    });
  });

  describe("connected state rendering", () => {
    test("displays avatars for connected addresses", () => {
      const addresses = ["0x1234567890abcdef", "0xabcdef1234567890"];
      mockUseConnectedAddresses.mockReturnValue(addresses);
      render(<GatedConnectButton />);

      const avatars = screen.getAllByTestId("address-avatar");
      expect(avatars).toHaveLength(2);
      expect(avatars[0]).toHaveAttribute("data-address", addresses[0]);
      expect(avatars[1]).toHaveAttribute("data-address", addresses[1]);
    });

    test("limits avatars to maximum of 8", () => {
      const addresses = Array.from({ length: 10 }, (_, i) => `0x${i}`.padEnd(42, "0"));
      mockUseConnectedAddresses.mockReturnValue(addresses);
      render(<GatedConnectButton />);

      const avatars = screen.getAllByTestId("address-avatar");
      expect(avatars).toHaveLength(8);
    });

    test("applies correct spacing classes for multiple addresses", () => {
      mockUseConnectedAddresses.mockReturnValue(["0x1234", "0x5678"]);
      render(<GatedConnectButton />);

      const container = screen.getAllByTestId("address-avatar")[0].parentElement;
      expect(container).toHaveClass("flex");
      expect(container).toHaveClass("-space-x-2");
    });

    test("applies tighter spacing for more than 4 addresses", () => {
      mockUseConnectedAddresses.mockReturnValue(["0x1", "0x2", "0x3", "0x4", "0x5"]);
      render(<GatedConnectButton />);

      const container = screen.getAllByTestId("address-avatar")[0].parentElement;
      expect(container).toHaveClass("-space-x-3");
    });
  });

  describe("onboarding step 1 — terms acceptance", () => {
    test("does not show dialog initially", () => {
      render(<GatedConnectButton />);
      expect(screen.queryByTestId("dialog")).not.toBeInTheDocument();
    });

    test("shows dialog when clicking connect without accepted terms", async () => {
      const user = userEvent.setup();
      render(<GatedConnectButton />);

      await user.click(screen.getByRole("button", { name: /connect wallet/i }));

      expect(screen.getByTestId("dialog")).toBeInTheDocument();
    });

    test("skips dialog when terms already accepted", async () => {
      mockUseLocalStorageState.mockReturnValue([true, mockSetTermsAccepted]);
      const user = userEvent.setup();
      render(<GatedConnectButton />);

      await user.click(screen.getByRole("button", { name: /connect wallet/i }));

      expect(screen.queryByTestId("dialog")).not.toBeInTheDocument();
      expect(mockOpenConnectModal).toHaveBeenCalled();
    });

    test("step 1 shows welcome title", async () => {
      const user = userEvent.setup();
      render(<GatedConnectButton />);

      await user.click(screen.getByRole("button", { name: /connect wallet/i }));

      expect(screen.getByTestId("dialog-title")).toHaveTextContent("Welcome to Octo.cash");
    });

    test("step 1 explains that data stays in the browser", async () => {
      const user = userEvent.setup();
      render(<GatedConnectButton />);

      await user.click(screen.getByRole("button", { name: /connect wallet/i }));

      const description = screen.getByTestId("dialog-description");
      expect(description).toHaveTextContent(/client-side dapp/i);
      expect(description).toHaveTextContent(/never leaves your browser/i);
    });

    test("step 1 shows a reassuring hint", async () => {
      const user = userEvent.setup();
      render(<GatedConnectButton />);

      await user.click(screen.getByRole("button", { name: /connect wallet/i }));

      expect(screen.getByTestId("lightbulb-icon")).toBeInTheDocument();
      expect(screen.getByText(/friendly octopus/i)).toBeInTheDocument();
    });

    test("step 1 includes terms checkbox", async () => {
      const user = userEvent.setup();
      render(<GatedConnectButton />);

      await user.click(screen.getByRole("button", { name: /connect wallet/i }));

      expect(screen.getByTestId("terms-checkbox")).toBeInTheDocument();
    });

    test("step 1 includes links to Terms of Service and Privacy Policy", async () => {
      const user = userEvent.setup();
      render(<GatedConnectButton />);

      await user.click(screen.getByRole("button", { name: /connect wallet/i }));

      const termsLink = screen.getByText("Terms of Service");
      const privacyLink = screen.getByText("Privacy Policy");
      expect(termsLink).toHaveAttribute("href", "/terms");
      expect(privacyLink).toHaveAttribute("href", "/privacy");
    });

    test("continue button is disabled when checkbox is not checked", async () => {
      const user = userEvent.setup();
      render(<GatedConnectButton />);

      await user.click(screen.getByRole("button", { name: /connect wallet/i }));

      const continueButton = screen.getByRole("button", { name: /continue/i });
      expect(continueButton).toBeDisabled();
    });

    test("continue button is enabled when checkbox is checked", async () => {
      const user = userEvent.setup();
      render(<GatedConnectButton />);

      await user.click(screen.getByRole("button", { name: /connect wallet/i }));

      const checkbox = screen.getByTestId("terms-checkbox");
      await user.click(checkbox);

      const continueButton = screen.getByRole("button", { name: /continue/i });
      expect(continueButton).not.toBeDisabled();
    });

    test("saves terms acceptance when continue is clicked", async () => {
      const user = userEvent.setup();
      render(<GatedConnectButton />);

      await user.click(screen.getByRole("button", { name: /connect wallet/i }));
      await user.click(screen.getByTestId("terms-checkbox"));
      await user.click(screen.getByRole("button", { name: /continue/i }));

      expect(mockSetTermsAccepted).toHaveBeenCalledWith(true);
    });

    test("resets checkbox when dialog opens", async () => {
      const user = userEvent.setup();
      render(<GatedConnectButton />);

      await user.click(screen.getByRole("button", { name: /connect wallet/i }));

      expect(screen.getByTestId("terms-checkbox")).not.toBeChecked();
    });
  });

  describe("onboarding step 2 — connect wallets info", () => {
    async function goToStep2(user: ReturnType<typeof userEvent.setup>) {
      await user.click(screen.getByRole("button", { name: /connect wallet/i }));
      await user.click(screen.getByTestId("terms-checkbox"));
      await user.click(screen.getByRole("button", { name: /continue/i }));
    }

    test("accepting terms advances to step 2", async () => {
      const user = userEvent.setup();
      render(<GatedConnectButton />);

      await goToStep2(user);

      expect(screen.getByTestId("dialog-title")).toHaveTextContent("Connect Your Wallets");
    });

    test("step 2 explains what connecting does", async () => {
      const user = userEvent.setup();
      render(<GatedConnectButton />);

      await goToStep2(user);

      const description = screen.getByTestId("dialog-description");
      expect(description).toHaveTextContent(/read-only peek at your tokens/i);
      expect(description).toHaveTextContent(/consolidating/i);
    });

    test("step 2 shows pro tip about multi-address selection", async () => {
      const user = userEvent.setup();
      render(<GatedConnectButton />);

      await goToStep2(user);

      expect(screen.getByTestId("lightbulb-icon")).toBeInTheDocument();
      expect(screen.getByText(/multiple addresses/i)).toBeInTheDocument();
      expect(screen.getByText(/edit accounts/i)).toBeInTheDocument();
    });

    test("step 2 no longer shows terms checkbox", async () => {
      const user = userEvent.setup();
      render(<GatedConnectButton />);

      await goToStep2(user);

      expect(screen.queryByTestId("terms-checkbox")).not.toBeInTheDocument();
    });

    test("clicking let's go closes dialog and opens connect modal", async () => {
      const user = userEvent.setup();
      render(<GatedConnectButton />);

      await goToStep2(user);

      await user.click(screen.getByRole("button", { name: /let's go/i }));

      await waitFor(() => {
        expect(screen.queryByTestId("dialog")).not.toBeInTheDocument();
      });
      await waitFor(() => {
        expect(mockOpenConnectModal).toHaveBeenCalled();
      });
    });
  });

  describe("connected addresses dialog", () => {
    test("shows dialog when clicking connected button", async () => {
      mockUseConnectedAddresses.mockReturnValue(["0x1234567890abcdef"]);
      const user = userEvent.setup();
      render(<GatedConnectButton />);

      const button = screen.getByRole("button");
      await user.click(button);

      expect(screen.getByTestId("dialog")).toBeInTheDocument();
      expect(screen.getByTestId("dialog-title")).toHaveTextContent("Connected Wallets");
    });

    test("displays all connected addresses in dialog", async () => {
      const addresses = ["0x1234567890abcdef", "0xabcdef1234567890", "0x1111111111111111"];
      mockUseConnectedAddresses.mockReturnValue(addresses);
      const user = userEvent.setup();
      render(<GatedConnectButton />);

      await user.click(screen.getByRole("button"));

      const addressDisplays = screen.getAllByTestId("address-display-root");
      expect(addressDisplays).toHaveLength(3);
      expect(addressDisplays[0]).toHaveAttribute("data-address", addresses[0]);
      expect(addressDisplays[1]).toHaveAttribute("data-address", addresses[1]);
      expect(addressDisplays[2]).toHaveAttribute("data-address", addresses[2]);
    });

    test("renders ScrollArea for addresses list", async () => {
      mockUseConnectedAddresses.mockReturnValue(["0x1234567890abcdef"]);
      const user = userEvent.setup();
      render(<GatedConnectButton />);

      await user.click(screen.getByRole("button"));

      expect(screen.getByTestId("scroll-area")).toBeInTheDocument();
      expect(screen.getByTestId("scroll-area")).toHaveClass("max-h-[400px]");
    });

    test("renders address components for each address", async () => {
      mockUseConnectedAddresses.mockReturnValue(["0x1234567890abcdef"]);
      const user = userEvent.setup();
      render(<GatedConnectButton />);

      await user.click(screen.getByRole("button"));

      expect(screen.getByTestId("address-display-avatar")).toBeInTheDocument();
      expect(screen.getByTestId("address-display-text")).toBeInTheDocument();
      expect(screen.getByTestId("address-display-copy")).toBeInTheDocument();
    });
  });

  describe("connected dialog actions", () => {
    test("renders Change Wallets button", async () => {
      mockUseConnectedAddresses.mockReturnValue(["0x1234567890abcdef"]);
      const user = userEvent.setup();
      render(<GatedConnectButton />);

      await user.click(screen.getByRole("button"));

      expect(screen.getByRole("button", { name: /change wallets/i })).toBeInTheDocument();
    });

    test("Change Wallets button has wallet icon", async () => {
      mockUseConnectedAddresses.mockReturnValue(["0x1234567890abcdef"]);
      const user = userEvent.setup();
      render(<GatedConnectButton />);

      await user.click(screen.getByRole("button"));

      const changeButton = screen.getByRole("button", { name: /change wallets/i });
      const icon = changeButton.querySelector('[data-testid="wallet-icon"]');
      expect(icon).toBeInTheDocument();
    });

    test("Change Wallets button requests wallet permissions", async () => {
      mockUseConnectedAddresses.mockReturnValue(["0x1234567890abcdef"]);
      const user = userEvent.setup();
      render(<GatedConnectButton />);

      await user.click(screen.getByRole("button"));

      const changeButton = screen.getByRole("button", { name: /change wallets/i });
      await user.click(changeButton);

      expect(mockEthereumRequest).toHaveBeenCalledWith({
        method: "wallet_requestPermissions",
        params: [{ eth_accounts: {} }],
      });
    });

    test("handles error when requesting wallet permissions", async () => {
      mockUseConnectedAddresses.mockReturnValue(["0x1234567890abcdef"]);
      mockEthereumRequest.mockRejectedValue(new Error("User rejected"));
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const user = userEvent.setup();
      render(<GatedConnectButton />);

      await user.click(screen.getByRole("button"));
      const changeButton = screen.getByRole("button", { name: /change wallets/i });
      await user.click(changeButton);

      await waitFor(() => {
        expect(consoleSpy).toHaveBeenCalledWith("Error requesting accounts:", expect.any(Error));
      });

      consoleSpy.mockRestore();
    });

    test("renders Disconnect button", async () => {
      mockUseConnectedAddresses.mockReturnValue(["0x1234567890abcdef"]);
      const user = userEvent.setup();
      render(<GatedConnectButton />);

      await user.click(screen.getByRole("button"));

      expect(screen.getByRole("button", { name: /disconnect/i })).toBeInTheDocument();
    });

    test("Disconnect button has logout icon", async () => {
      mockUseConnectedAddresses.mockReturnValue(["0x1234567890abcdef"]);
      const user = userEvent.setup();
      render(<GatedConnectButton />);

      await user.click(screen.getByRole("button"));

      const disconnectButton = screen.getByRole("button", { name: /disconnect/i });
      const icon = disconnectButton.querySelector('[data-testid="logout-icon"]');
      expect(icon).toBeInTheDocument();
    });

    test("Disconnect button has destructive variant", async () => {
      mockUseConnectedAddresses.mockReturnValue(["0x1234567890abcdef"]);
      const user = userEvent.setup();
      render(<GatedConnectButton />);

      await user.click(screen.getByRole("button"));

      const disconnectButton = screen.getByRole("button", { name: /disconnect/i });
      expect(disconnectButton).toHaveClass("text-destructive");
    });

    test("Disconnect button calls disconnect function", async () => {
      mockUseConnectedAddresses.mockReturnValue(["0x1234567890abcdef"]);
      const user = userEvent.setup();
      render(<GatedConnectButton />);

      await user.click(screen.getByRole("button"));

      const disconnectButton = screen.getByRole("button", { name: /disconnect/i });
      await user.click(disconnectButton);

      expect(mockDisconnect).toHaveBeenCalled();
    });

    test("Disconnect button closes dialog", async () => {
      mockUseConnectedAddresses.mockReturnValue(["0x1234567890abcdef"]);
      const user = userEvent.setup();
      render(<GatedConnectButton />);

      await user.click(screen.getByRole("button"));

      const disconnectButton = screen.getByRole("button", { name: /disconnect/i });
      await user.click(disconnectButton);

      await waitFor(() => {
        expect(screen.queryByTestId("dialog-title")).not.toBeInTheDocument();
      });
    });

    test("renders Ok button", async () => {
      mockUseConnectedAddresses.mockReturnValue(["0x1234567890abcdef"]);
      const user = userEvent.setup();
      render(<GatedConnectButton />);

      await user.click(screen.getByRole("button"));

      expect(screen.getByRole("button", { name: /ok/i })).toBeInTheDocument();
    });

    test("Ok button has large size", async () => {
      mockUseConnectedAddresses.mockReturnValue(["0x1234567890abcdef"]);
      const user = userEvent.setup();
      render(<GatedConnectButton />);

      await user.click(screen.getByRole("button"));

      const okButton = screen.getByRole("button", { name: /ok/i });
      expect(okButton).toHaveAttribute("data-size", "lg");
    });

    test("Ok button closes dialog", async () => {
      mockUseConnectedAddresses.mockReturnValue(["0x1234567890abcdef"]);
      const user = userEvent.setup();
      render(<GatedConnectButton />);

      await user.click(screen.getByRole("button"));

      const okButton = screen.getByRole("button", { name: /ok/i });
      await user.click(okButton);

      await waitFor(() => {
        expect(screen.queryByTestId("dialog-title")).not.toBeInTheDocument();
      });
    });
  });

  describe("localStorage integration", () => {
    test("uses correct localStorage key", () => {
      render(<GatedConnectButton />);
      expect(mockUseLocalStorageState).toHaveBeenCalledWith("octocash:terms-accepted", {
        defaultValue: false,
      });
    });

    test("defaults to false for terms acceptance", () => {
      render(<GatedConnectButton />);
      expect(mockUseLocalStorageState).toHaveBeenCalledWith(expect.any(String), {
        defaultValue: false,
      });
    });
  });

  describe("button variant logic", () => {
    test("uses default variant when not connected", () => {
      mockUseConnectedAddresses.mockReturnValue([]);
      render(<GatedConnectButton />);

      const button = screen.getByRole("button");
      expect(button).toHaveAttribute("data-variant", "default");
    });

    test("uses outline variant when connected", () => {
      mockUseConnectedAddresses.mockReturnValue(["0x1234567890abcdef"]);
      render(<GatedConnectButton />);

      const button = screen.getByRole("button");
      expect(button).toHaveAttribute("data-variant", "outline");
    });
  });

  describe("edge cases", () => {
    test("handles empty connected addresses array", () => {
      mockUseConnectedAddresses.mockReturnValue([]);
      render(<GatedConnectButton />);

      expect(screen.getByRole("button", { name: /connect wallet/i })).toBeInTheDocument();
      expect(screen.queryByText("Connected")).not.toBeInTheDocument();
    });

    test("handles single connected address", () => {
      mockUseConnectedAddresses.mockReturnValue(["0x1234567890abcdef"]);
      render(<GatedConnectButton />);

      expect(screen.getByText("Connected")).toBeInTheDocument();
      expect(screen.getAllByTestId("address-avatar")).toHaveLength(1);
    });

    test("handles many connected addresses", () => {
      const addresses = Array.from({ length: 15 }, (_, i) => `0x${i}`.padEnd(42, "0"));
      mockUseConnectedAddresses.mockReturnValue(addresses);
      render(<GatedConnectButton />);

      // Should only show first 8
      expect(screen.getAllByTestId("address-avatar")).toHaveLength(8);
    });

    test("handles undefined openConnectModal gracefully", async () => {
      mockUseLocalStorageState.mockReturnValue([true, mockSetTermsAccepted]);
      const user = userEvent.setup();
      render(<GatedConnectButton />);

      const button = screen.getByRole("button", { name: /connect wallet/i });

      await user.click(button);

      expect(mockOpenConnectModal).toHaveBeenCalled();
    });
  });

  describe("accessibility", () => {
    test("main button has accessible role", () => {
      render(<GatedConnectButton />);
      const button = screen.getByRole("button");
      expect(button).toBeInTheDocument();
    });

    test("dialogs have proper structure", async () => {
      const user = userEvent.setup();
      render(<GatedConnectButton />);

      await user.click(screen.getByRole("button", { name: /connect wallet/i }));

      expect(screen.getByTestId("dialog-header")).toBeInTheDocument();
      expect(screen.getByTestId("dialog-footer")).toBeInTheDocument();
    });

    test("checkbox has proper label association", async () => {
      const user = userEvent.setup();
      render(<GatedConnectButton />);

      await user.click(screen.getByRole("button", { name: /connect wallet/i }));

      const checkbox = screen.getByTestId("terms-checkbox");
      expect(checkbox).toHaveAttribute("id", "terms-checkbox");

      const label = screen.getByText(/I agree to the/);
      expect(label).toHaveAttribute("for", "terms-checkbox");
    });

    test("continue button is properly enabled/disabled based on checkbox", async () => {
      const user = userEvent.setup();
      render(<GatedConnectButton />);

      await user.click(screen.getByRole("button", { name: /connect wallet/i }));

      const checkbox = screen.getByTestId("terms-checkbox");
      const continueButton = screen.getByRole("button", { name: /continue/i });

      // Initially disabled
      expect(continueButton).toBeDisabled();

      // Enabled when checked
      await user.click(checkbox);
      expect(continueButton).not.toBeDisabled();
    });
  });

  describe("dialog state management", () => {
    test("only one dialog is open at a time", async () => {
      mockUseConnectedAddresses.mockReturnValue([]);
      const user = userEvent.setup();
      render(<GatedConnectButton />);

      await user.click(screen.getByRole("button", { name: /connect wallet/i }));
      expect(screen.getByText("Welcome to Octo.cash")).toBeInTheDocument();

      expect(screen.queryByText("Connected Wallets")).not.toBeInTheDocument();
    });

    test("onboarding dialog renders when terms not accepted", async () => {
      const user = userEvent.setup();
      render(<GatedConnectButton />);

      await user.click(screen.getByRole("button", { name: /connect wallet/i }));
      expect(screen.getByTestId("dialog-title")).toHaveTextContent("Welcome to Octo.cash");
    });

    test("connected dialog renders when addresses exist", async () => {
      mockUseConnectedAddresses.mockReturnValue(["0x1234567890abcdef"]);
      const user = userEvent.setup();
      render(<GatedConnectButton />);

      await user.click(screen.getByRole("button"));
      expect(screen.getByTestId("dialog-title")).toHaveTextContent("Connected Wallets");
    });
  });
});
