import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { MouseEvent, ReactNode } from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { GatedConnectButton } from "./gated-connect-button";

const injectedConnector = { id: "injected", uid: "injected-1", name: "Injected" };
const walletConnectEmitter = {
  on: vi.fn(),
  off: vi.fn(),
};
const walletConnectConnector = {
  id: "walletConnect",
  uid: "walletconnect-1",
  name: "WalletConnect",
  emitter: walletConnectEmitter,
};

vi.mock("lucide-react", () => ({
  ArrowUpRightIcon: ({ className }: { className?: string }) => (
    <div data-testid="arrow-up-right-icon" className={className} />
  ),
  CheckIcon: ({ className }: { className?: string }) => <div data-testid="check-icon" className={className} />,
  ChevronLeftIcon: ({ className }: { className?: string }) => (
    <div data-testid="chevron-left-icon" className={className} />
  ),
  CopyIcon: ({ className }: { className?: string }) => <div data-testid="copy-icon" className={className} />,
  LightbulbIcon: ({ className }: { className?: string }) => <div data-testid="lightbulb-icon" className={className} />,
  LoaderCircleIcon: ({ className }: { className?: string }) => (
    <div data-testid="loader-circle-icon" className={className} />
  ),
  LogOutIcon: ({ className }: { className?: string }) => <div data-testid="logout-icon" className={className} />,
  QrCodeIcon: ({ className }: { className?: string }) => <div data-testid="qr-code-icon" className={className} />,
  WalletIcon: ({ className }: { className?: string }) => <div data-testid="wallet-icon" className={className} />,
}));

vi.mock("react-qr-code", () => ({
  default: ({ value }: { value: string }) => <div data-testid="walletconnect-qr" data-value={value} />,
}));

vi.mock("react-router", () => ({
  Link: ({
    to,
    children,
    target,
    className,
    onClick,
  }: {
    to: string;
    children: ReactNode;
    target?: string;
    className?: string;
    onClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
  }) => (
    <a href={to} target={target} className={className} onClick={onClick}>
      {children}
    </a>
  ),
}));

const mockSetTermsAccepted = vi.fn();
const mockUseLocalStorageState = vi.fn();
vi.mock("use-local-storage-state", () => ({
  default: (key: string, options: { defaultValue: boolean }) => mockUseLocalStorageState(key, options),
}));

const mockConnectAsync = vi.fn();
const mockDisconnect = vi.fn();
const mockUseConnect = vi.fn();
vi.mock("wagmi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("wagmi")>();
  return {
    ...actual,
    useConnect: () => mockUseConnect(),
    useDisconnect: () => ({ disconnect: mockDisconnect }),
  };
});

const mockUseConnectedAddresses = vi.fn();
vi.mock("~/hooks/use-connected-addresses", () => ({
  useConnectedAddresses: () => mockUseConnectedAddresses(),
}));

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
    children: ReactNode;
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
    children: ReactNode;
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
      onChange={(event) => onCheckedChange?.(event.target.checked)}
      className={className}
      data-testid="terms-checkbox"
    />
  ),
}));

vi.mock("~/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div data-testid="dialog">{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div data-testid="dialog-content">{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p data-testid="dialog-description">{children}</p>,
  DialogFooter: ({ children, className }: { children: ReactNode; className?: string }) => (
    <div data-testid="dialog-footer" className={className}>
      {children}
    </div>
  ),
  DialogHeader: ({ children }: { children: ReactNode }) => <div data-testid="dialog-header">{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2 data-testid="dialog-title">{children}</h2>,
}));

vi.mock("~/components/ui/scroll-area", () => ({
  ScrollArea: ({ children, className }: { children: ReactNode; className?: string }) => (
    <div data-testid="scroll-area" className={className}>
      {children}
    </div>
  ),
}));

vi.mock("~/lib/utils", () => ({
  cn: (...classes: (string | undefined | false)[]) => classes.filter(Boolean).join(" "),
}));

const mockEthereumRequest = vi.fn();
const mockClipboardWriteText = vi.fn();
Object.defineProperty(window, "ethereum", {
  value: {
    request: mockEthereumRequest,
  },
  writable: true,
  configurable: true,
});
Object.defineProperty(navigator, "clipboard", {
  value: {
    writeText: mockClipboardWriteText,
  },
  writable: true,
  configurable: true,
});

describe("GatedConnectButton", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    walletConnectEmitter.on.mockReset();
    walletConnectEmitter.off.mockReset();
    Object.defineProperty(window, "ethereum", {
      value: {
        request: mockEthereumRequest,
      },
      writable: true,
      configurable: true,
    });
    mockUseConnectedAddresses.mockReturnValue([]);
    mockUseLocalStorageState.mockReturnValue([false, mockSetTermsAccepted]);
    mockUseConnect.mockReturnValue({
      connectors: [injectedConnector, walletConnectConnector],
      connectAsync: mockConnectAsync,
      error: null,
      status: "idle",
    });
    mockEthereumRequest.mockResolvedValue(undefined);
    mockClipboardWriteText.mockResolvedValue(undefined);
  });

  test("renders connect button when disconnected", () => {
    render(<GatedConnectButton />);

    const button = screen.getByRole("button", { name: /connect wallet/i });
    expect(button).toBeInTheDocument();
    expect(button).toHaveAttribute("data-variant", "default");
  });

  test("renders connected state and avatars when addresses exist", () => {
    mockUseConnectedAddresses.mockReturnValue(["0x1234567890abcdef", "0xabcdef1234567890"]);
    render(<GatedConnectButton />);

    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.getAllByTestId("address-avatar")).toHaveLength(2);
  });

  test("uses the terms local storage key", () => {
    render(<GatedConnectButton />);

    expect(mockUseLocalStorageState).toHaveBeenCalledWith("octocash:terms-accepted", {
      defaultValue: false,
    });
  });

  test("shows onboarding when terms are not yet accepted", async () => {
    const user = userEvent.setup();
    render(<GatedConnectButton />);

    await user.click(screen.getByRole("button", { name: /connect wallet/i }));

    expect(screen.getByText("Welcome to Octocash")).toBeInTheDocument();
    expect(screen.getByText("Terms of Service")).toHaveAttribute("href", "/terms");
    expect(screen.getByRole("button", { name: /continue/i })).toBeDisabled();
  });

  test("advances through onboarding into the wallet chooser", async () => {
    const user = userEvent.setup();
    render(<GatedConnectButton />);

    await user.click(screen.getByRole("button", { name: /connect wallet/i }));
    await user.click(screen.getByTestId("terms-checkbox"));
    await user.click(screen.getByRole("button", { name: /continue/i }));

    expect(mockSetTermsAccepted).toHaveBeenCalledWith(true);
    expect(screen.getByText("Connect Your Wallets")).toBeInTheDocument();
    expect(screen.getByTestId("lightbulb-icon")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /let's go/i }));

    expect(screen.getByText("Choose a Wallet")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /browser wallet/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /walletconnect/i })).toBeInTheDocument();
  });

  test("opens the wallet chooser directly when terms were already accepted", async () => {
    mockUseLocalStorageState.mockReturnValue([true, mockSetTermsAccepted]);
    const user = userEvent.setup();
    render(<GatedConnectButton />);

    await user.click(screen.getByRole("button", { name: /connect wallet/i }));

    expect(screen.getByText("Choose a Wallet")).toBeInTheDocument();
    expect(screen.queryByText("Welcome to Octocash")).not.toBeInTheDocument();
  });

  test("connects with the injected connector from the wallet chooser", async () => {
    const user = userEvent.setup();
    render(<GatedConnectButton />);

    await user.click(screen.getByRole("button", { name: /connect wallet/i }));
    await user.click(screen.getByTestId("terms-checkbox"));
    await user.click(screen.getByRole("button", { name: /continue/i }));
    await user.click(screen.getByRole("button", { name: /let's go/i }));
    await user.click(screen.getByRole("button", { name: /browser wallet/i }));

    expect(mockConnectAsync).toHaveBeenCalledWith({ connector: injectedConnector });
    await waitFor(() => {
      expect(screen.queryByText("Choose a Wallet")).not.toBeInTheDocument();
    });
  });

  test("keeps the wallet chooser open when a connect attempt fails", async () => {
    mockConnectAsync.mockRejectedValueOnce(new Error("No provider found"));
    const user = userEvent.setup();
    render(<GatedConnectButton />);

    await user.click(screen.getByRole("button", { name: /connect wallet/i }));
    await user.click(screen.getByTestId("terms-checkbox"));
    await user.click(screen.getByRole("button", { name: /continue/i }));
    await user.click(screen.getByRole("button", { name: /let's go/i }));
    await user.click(screen.getByRole("button", { name: /browser wallet/i }));

    expect(screen.getByText("Choose a Wallet")).toBeInTheDocument();
  });

  test("shows a disabled browser wallet option when no injected provider is available", async () => {
    Object.defineProperty(window, "ethereum", {
      value: undefined,
      writable: true,
      configurable: true,
    });
    mockUseLocalStorageState.mockReturnValue([true, mockSetTermsAccepted]);
    const user = userEvent.setup();
    render(<GatedConnectButton />);

    await user.click(screen.getByRole("button", { name: /connect wallet/i }));

    const browserWalletButton = screen.getByRole("button", { name: /browser wallet/i });
    expect(browserWalletButton).toBeDisabled();
    expect(screen.getByText(/no injected wallet detected/i)).toBeInTheDocument();
  });

  test("shows an enabled 'Open in MetaMask' deeplink option on mobile when no injected provider is available", async () => {
    Object.defineProperty(window, "ethereum", {
      value: undefined,
      writable: true,
      configurable: true,
    });
    const originalUserAgent = navigator.userAgent;
    Object.defineProperty(navigator, "userAgent", {
      value:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
      writable: true,
      configurable: true,
    });
    const originalLocation = window.location;
    Object.defineProperty(window, "location", {
      value: { host: "octo.cash", pathname: "/dashboard", search: "", href: "https://octo.cash/dashboard" },
      writable: true,
      configurable: true,
    });
    mockUseLocalStorageState.mockReturnValue([true, mockSetTermsAccepted]);
    const user = userEvent.setup();
    render(<GatedConnectButton />);

    await user.click(screen.getByRole("button", { name: /connect wallet/i }));

    const metaMaskButton = screen.getByRole("button", { name: /open in metamask/i });
    expect(metaMaskButton).not.toBeDisabled();

    await user.click(metaMaskButton);

    expect(window.location.href).toBe("https://metamask.app.link/dapp/octo.cash/dashboard");

    Object.defineProperty(navigator, "userAgent", {
      value: originalUserAgent,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(window, "location", {
      value: originalLocation,
      writable: true,
      configurable: true,
    });
  });

  test("renders wagmi connection errors inside the wallet chooser", async () => {
    mockUseLocalStorageState.mockReturnValue([true, mockSetTermsAccepted]);
    mockUseConnect.mockReturnValue({
      connectors: [injectedConnector, walletConnectConnector],
      connectAsync: mockConnectAsync,
      error: new Error("Connection rejected"),
      status: "error",
    });
    const user = userEvent.setup();
    render(<GatedConnectButton />);

    await user.click(screen.getByRole("button", { name: /connect wallet/i }));

    expect(screen.getByText("Connection rejected")).toBeInTheDocument();
  });

  test("renders the WalletConnect QR inside our modal and copies the link", async () => {
    mockUseLocalStorageState.mockReturnValue([true, mockSetTermsAccepted]);
    mockConnectAsync.mockImplementation(async ({ connector }: { connector: typeof walletConnectConnector }) => {
      const handler = walletConnectEmitter.on.mock.calls.find(([eventName]) => eventName === "message")?.[1];
      handler?.({ type: "display_uri", data: "wc:octocash-test", uid: connector.uid });
      return await new Promise(() => {});
    });
    const user = userEvent.setup();
    render(<GatedConnectButton />);

    await user.click(screen.getByRole("button", { name: /connect wallet/i }));
    await user.click(screen.getByRole("button", { name: /walletconnect/i }));

    expect(screen.getByText(/scan with walletconnect/i)).toBeInTheDocument();
    expect(screen.getByTestId("walletconnect-qr")).toHaveAttribute("data-value", "wc:octocash-test");

    await user.click(screen.getByRole("button", { name: /copy link/i }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /copied/i })).toBeInTheDocument();
    });
  });

  test("shows connected wallets dialog and supports changing addresses", async () => {
    mockUseConnectedAddresses.mockReturnValue(["0x1234567890abcdef"]);
    const user = userEvent.setup();
    render(<GatedConnectButton />);

    await user.click(screen.getByRole("button", { name: /connected/i }));
    await user.click(screen.getByRole("button", { name: /change wallets/i }));

    expect(screen.getByText("Connected Wallets")).toBeInTheDocument();
    expect(mockEthereumRequest).toHaveBeenCalledWith({
      method: "wallet_requestPermissions",
      params: [{ eth_accounts: {} }],
    });
  });

  test("disconnects from the connected wallets dialog", async () => {
    mockUseConnectedAddresses.mockReturnValue(["0x1234567890abcdef"]);
    const user = userEvent.setup();
    render(<GatedConnectButton />);

    await user.click(screen.getByRole("button", { name: /connected/i }));
    await user.click(screen.getByRole("button", { name: /disconnect/i }));

    expect(mockDisconnect).toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.queryByText("Connected Wallets")).not.toBeInTheDocument();
    });
  });

  test("logs change-wallet errors without crashing", async () => {
    mockUseConnectedAddresses.mockReturnValue(["0x1234567890abcdef"]);
    mockEthereumRequest.mockRejectedValueOnce(new Error("User rejected"));
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const user = userEvent.setup();
    render(<GatedConnectButton />);

    await user.click(screen.getByRole("button", { name: /connected/i }));
    await user.click(screen.getByRole("button", { name: /change wallets/i }));

    await waitFor(() => {
      expect(consoleSpy).toHaveBeenCalledWith("Error requesting accounts:", expect.any(Error));
    });
    consoleSpy.mockRestore();
  });
});
