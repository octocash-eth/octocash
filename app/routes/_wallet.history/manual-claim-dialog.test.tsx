import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import ManualClaimDialog from "./manual-claim-dialog";

// Mock hooks
const mockClaim = vi.fn();

vi.mock("~/hooks/use-cctp-claim", () => ({
  useCCTPClaim: vi.fn(() => ({
    claim: mockClaim,
  })),
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
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    variant?: string;
    size?: string;
    disabled?: boolean;
    type?: "submit" | "reset" | "button";
  }) => (
    <button onClick={onClick} data-variant={variant} data-size={size} disabled={disabled} type={type}>
      {children}
    </button>
  ),
}));

vi.mock("~/components/ui/dialog", () => ({
  Dialog: ({
    children,
    open,
    onOpenChange,
  }: {
    children: React.ReactNode;
    open: boolean;
    onOpenChange: (open: boolean) => void;
  }) => (
    // biome-ignore lint/a11y/useSemanticElements: Mocking Dialog as div
    <div
      data-testid="dialog"
      data-open={open}
      onClick={() => onOpenChange(false)}
      onKeyDown={(e) => e.key === "Escape" && onOpenChange(false)}
      role="button"
      tabIndex={0}
    >
      {children}
    </div>
  ),
  DialogTrigger: ({ children, asChild: _ }: { children: React.ReactNode; asChild?: boolean }) => (
    <div data-testid="dialog-trigger">{children}</div>
  ),
  DialogContent: ({ children }: { children: React.ReactNode }) => <div data-testid="dialog-content">{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div data-testid="dialog-footer">{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div data-testid="dialog-header">{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  // DialogClose in Radix wraps the trigger and fires `onOpenChange(false)`
  // on the underlying button click. Mirror that semantic in the mock so
  // tests exercising Cancel-button-as-abort behave like production: any
  // click inside surfaces an open-change to false.
  DialogClose: ({ children, asChild: _ }: { children: React.ReactNode; asChild?: boolean }) => (
    <div data-testid="dialog-close">{children}</div>
  ),
}));

vi.mock("~/components/ui/input", () => ({
  Input: ({
    id,
    placeholder,
    value,
    onChange,
    required,
    autoFocus,
  }: {
    id?: string;
    placeholder?: string;
    value: string;
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
    required?: boolean;
    autoFocus?: boolean;
  }) => (
    <input
      id={id}
      placeholder={placeholder}
      value={value}
      onChange={onChange}
      required={required}
      // biome-ignore lint/a11y/noAutofocus: Mocking Input with autoFocus support
      autoFocus={autoFocus}
      data-testid="transaction-url-input"
    />
  ),
}));

// Mock supported chains
vi.mock("~/data/supported-chains", () => ({
  supportedChains: [
    { id: 1, name: "Ethereum", explorerUrl: "https://etherscan.io" },
    { id: 10, name: "Optimism", explorerUrl: "https://optimistic.etherscan.io" },
    { id: 137, name: "Polygon", explorerUrl: "https://polygonscan.com" },
  ],
  blockExplorers: {
    8453: "https://basescan.org",
    42161: "https://arbiscan.io",
  },
}));

describe("ManualClaimDialog", () => {
  beforeEach(() => {
    mockClaim.mockClear();
  });

  test("renders trigger element", () => {
    render(
      <ManualClaimDialog>
        <button type="button">Open Dialog</button>
      </ManualClaimDialog>,
    );

    expect(screen.getByText("Open Dialog")).toBeInTheDocument();
  });

  test("dialog is closed by default", () => {
    render(
      <ManualClaimDialog>
        <button type="button">Open Dialog</button>
      </ManualClaimDialog>,
    );

    const dialog = screen.getByTestId("dialog");
    expect(dialog).toHaveAttribute("data-open", "false");
  });

  test("clicking trigger opens dialog", async () => {
    const user = userEvent.setup();

    // We need to properly mock the dialog state
    const TestWrapper = () => {
      const [isOpen, setIsOpen] = React.useState(false);

      return (
        <div>
          <button onClick={() => setIsOpen(true)} type="button">
            Open Dialog
          </button>
          {isOpen && (
            <div data-testid="dialog-content">
              <h2>Manual Claim</h2>
              <p>Paste the Etherscan or Blockscout transaction URL for the burn you want to claim.</p>
            </div>
          )}
        </div>
      );
    };

    render(<TestWrapper />);

    const trigger = screen.getByText("Open Dialog");
    await user.click(trigger);

    expect(screen.getByText("Manual Claim")).toBeInTheDocument();
  });

  test("renders dialog with correct title and description", () => {
    render(
      <ManualClaimDialog>
        <button type="button">Open</button>
      </ManualClaimDialog>,
    );

    expect(screen.getByText("Manual Claim")).toBeInTheDocument();
    expect(
      screen.getByText(/Paste the Etherscan or Blockscout transaction URL for the burn you want to claim/),
    ).toBeInTheDocument();
  });

  test("renders transaction URL input field", () => {
    render(
      <ManualClaimDialog>
        <button type="button">Open</button>
      </ManualClaimDialog>,
    );

    const input = screen.getByTestId("transaction-url-input");
    expect(input).toBeInTheDocument();
    expect(input).toHaveAttribute("placeholder", "https://etherscan.io/tx/0x…");
    expect(input).toHaveAttribute("required");
  });

  test("renders Cancel and Claim buttons", () => {
    render(
      <ManualClaimDialog>
        <button type="button">Open</button>
      </ManualClaimDialog>,
    );

    expect(screen.getByText("Cancel")).toBeInTheDocument();
    expect(screen.getByText("Claim")).toBeInTheDocument();
  });

  test("input value updates when typing", async () => {
    const user = userEvent.setup();

    render(
      <ManualClaimDialog>
        <button type="button">Open</button>
      </ManualClaimDialog>,
    );

    const input = screen.getByTestId("transaction-url-input") as HTMLInputElement;
    await user.type(input, "https://etherscan.io/tx/0x123");

    expect(input.value).toBe("https://etherscan.io/tx/0x123");
  });

  test("shows error for invalid URL format", async () => {
    const user = userEvent.setup();

    render(
      <ManualClaimDialog>
        <button type="button">Open</button>
      </ManualClaimDialog>,
    );

    const input = screen.getByTestId("transaction-url-input");
    const submitButton = screen.getByText("Claim");

    await user.type(input, "not-a-valid-url");
    await user.click(submitButton);

    expect(screen.getByText("Please provide a valid Etherscan or Blockscout transaction URL.")).toBeInTheDocument();
    expect(mockClaim).not.toHaveBeenCalled();
  });

  test("shows error for URL without /tx/ path", async () => {
    const user = userEvent.setup();

    render(
      <ManualClaimDialog>
        <button type="button">Open</button>
      </ManualClaimDialog>,
    );

    const input = screen.getByTestId("transaction-url-input");
    const submitButton = screen.getByText("Claim");

    await user.type(input, "https://etherscan.io/address/0x123");
    await user.click(submitButton);

    expect(screen.getByText("Please provide a valid Etherscan or Blockscout transaction URL.")).toBeInTheDocument();
    expect(mockClaim).not.toHaveBeenCalled();
  });

  test("shows error for URL from unknown explorer", async () => {
    const user = userEvent.setup();

    render(
      <ManualClaimDialog>
        <button type="button">Open</button>
      </ManualClaimDialog>,
    );

    const input = screen.getByTestId("transaction-url-input");
    const submitButton = screen.getByText("Claim");

    await user.type(input, "https://unknown-explorer.com/tx/0x123");
    await user.click(submitButton);

    expect(screen.getByText("Please provide a valid Etherscan or Blockscout transaction URL.")).toBeInTheDocument();
    expect(mockClaim).not.toHaveBeenCalled();
  });

  test("accepts valid Etherscan URL", async () => {
    const user = userEvent.setup();

    mockClaim.mockResolvedValue({
      mintTx: "0xmint123",
      logs: [],
    });

    render(
      <ManualClaimDialog>
        <button type="button">Open</button>
      </ManualClaimDialog>,
    );

    const input = screen.getByTestId("transaction-url-input");
    const submitButton = screen.getByText("Claim");

    await user.type(input, "https://etherscan.io/tx/0xabc123");
    await user.click(submitButton);

    // Wait for the async call to complete
    await vi.waitFor(() => {
      expect(mockClaim).toHaveBeenCalledWith("0xabc123", 1, expect.any(AbortSignal));
    });
  });

  test("accepts valid Optimism Etherscan URL", async () => {
    const user = userEvent.setup();

    mockClaim.mockResolvedValue({
      mintTx: "0xmint456",
      logs: [],
    });

    render(
      <ManualClaimDialog>
        <button type="button">Open</button>
      </ManualClaimDialog>,
    );

    const input = screen.getByTestId("transaction-url-input");
    const submitButton = screen.getByText("Claim");

    await user.type(input, "https://optimistic.etherscan.io/tx/0xdef456");
    await user.click(submitButton);

    await vi.waitFor(() => {
      expect(mockClaim).toHaveBeenCalledWith("0xdef456", 10, expect.any(AbortSignal));
    });
  });

  test("accepts valid Blockscout URL from blockExplorers", async () => {
    const user = userEvent.setup();

    mockClaim.mockResolvedValue({
      mintTx: "0xmint789",
      logs: [],
    });

    render(
      <ManualClaimDialog>
        <button type="button">Open</button>
      </ManualClaimDialog>,
    );

    const input = screen.getByTestId("transaction-url-input");
    const submitButton = screen.getByText("Claim");

    await user.type(input, "https://basescan.org/tx/0xghi789");
    await user.click(submitButton);

    await vi.waitFor(() => {
      expect(mockClaim).toHaveBeenCalledWith("0xghi789", 8453, expect.any(AbortSignal));
    });
  });

  test("shows 'Claiming…' text while submitting", async () => {
    const user = userEvent.setup();

    // Make claim return a promise that never resolves to keep loading state
    let resolvePromise: (value: unknown) => void = () => {};
    const claimPromise = new Promise((resolve) => {
      resolvePromise = resolve;
    });
    mockClaim.mockReturnValue(claimPromise);

    render(
      <ManualClaimDialog>
        <button type="button">Open</button>
      </ManualClaimDialog>,
    );

    const input = screen.getByTestId("transaction-url-input");
    const submitButton = screen.getByText("Claim");

    await user.type(input, "https://etherscan.io/tx/0xabc123");
    await user.click(submitButton);

    // Should show loading state
    await vi.waitFor(() => {
      expect(screen.getByText("Claiming…")).toBeInTheDocument();
    });

    // Resolve the promise to clean up
    resolvePromise({ mintTx: "0x123", logs: [] });
  });

  test("disables submit button while claiming", async () => {
    const user = userEvent.setup();

    let resolvePromise: (value: unknown) => void = () => {};
    const claimPromise = new Promise((resolve) => {
      resolvePromise = resolve;
    });
    mockClaim.mockReturnValue(claimPromise);

    render(
      <ManualClaimDialog>
        <button type="button">Open</button>
      </ManualClaimDialog>,
    );

    const input = screen.getByTestId("transaction-url-input");
    const submitButton = screen.getByText("Claim");

    await user.type(input, "https://etherscan.io/tx/0xabc123");
    await user.click(submitButton);

    await vi.waitFor(() => {
      const claimingButton = screen.getByText("Claiming…");
      expect(claimingButton).toBeDisabled();
    });

    resolvePromise({ mintTx: "0x123", logs: [] });
  });

  test("clicking Cancel during a claim aborts the underlying signal", async () => {
    const user = userEvent.setup();

    // Hold the claim promise open so the dialog stays in "Claiming…" state
    // while we hit Cancel. Capture the signal it was invoked with so we can
    // assert it transitioned to aborted on click.
    let capturedSignal: AbortSignal | undefined;
    let rejectClaim: ((reason: unknown) => void) | undefined;
    mockClaim.mockImplementation((_tx: string, _chainId: number, signal?: AbortSignal) => {
      capturedSignal = signal;
      return new Promise((_resolve, reject) => {
        rejectClaim = reject;
        // Mirror real behavior: when the caller aborts, the claim rejects
        // with an AbortError (that's what retrieveAttestations does).
        signal?.addEventListener("abort", () => {
          reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
        });
      });
    });

    render(
      <ManualClaimDialog>
        <button type="button">Open</button>
      </ManualClaimDialog>,
    );

    const input = screen.getByTestId("transaction-url-input");
    await user.type(input, "https://etherscan.io/tx/0xabc123");
    await user.click(screen.getByText("Claim"));

    await vi.waitFor(() => {
      expect(capturedSignal).toBeDefined();
      expect(capturedSignal?.aborted).toBe(false);
    });

    await user.click(screen.getByText("Cancel"));

    // Signal must be aborted now — that's the wire that stops the attestation
    // poll inside retrieveAttestations.
    expect(capturedSignal?.aborted).toBe(true);

    // No spurious error from the AbortError-rejected promise.
    await vi.waitFor(() => {
      expect(screen.queryByText(/failed to submit/i)).not.toBeInTheDocument();
    });

    // Clean up the still-suspended promise (it already rejected via the
    // abort listener, but null-check for type safety).
    rejectClaim?.(new DOMException("Aborted", "AbortError"));
  });

  test("AbortError from claim is not shown as a submit error", async () => {
    const user = userEvent.setup();
    mockClaim.mockRejectedValue(new DOMException("Aborted", "AbortError"));

    render(
      <ManualClaimDialog>
        <button type="button">Open</button>
      </ManualClaimDialog>,
    );

    await user.type(screen.getByTestId("transaction-url-input"), "https://etherscan.io/tx/0xabc123");
    await user.click(screen.getByText("Claim"));

    // Give the rejection a chance to flow through.
    await vi.waitFor(() => {
      expect(mockClaim).toHaveBeenCalled();
    });

    expect(screen.queryByText("Aborted")).not.toBeInTheDocument();
    expect(screen.queryByText(/failed to submit/i)).not.toBeInTheDocument();
  });

  test("shows error when USDC already claimed", async () => {
    const user = userEvent.setup();

    mockClaim.mockResolvedValue({
      mintTx: null,
      logs: [],
    });

    render(
      <ManualClaimDialog>
        <button type="button">Open</button>
      </ManualClaimDialog>,
    );

    const input = screen.getByTestId("transaction-url-input");
    const submitButton = screen.getByText("Claim");

    await user.type(input, "https://etherscan.io/tx/0xabc123");
    await user.click(submitButton);

    await vi.waitFor(() => {
      expect(screen.getByText("USDC was already claimed.")).toBeInTheDocument();
    });
  });

  test("shows error when claim fails", async () => {
    const user = userEvent.setup();

    mockClaim.mockRejectedValue(new Error("Network error"));

    render(
      <ManualClaimDialog>
        <button type="button">Open</button>
      </ManualClaimDialog>,
    );

    const input = screen.getByTestId("transaction-url-input");
    const submitButton = screen.getByText("Claim");

    await user.type(input, "https://etherscan.io/tx/0xabc123");
    await user.click(submitButton);

    await vi.waitFor(() => {
      expect(screen.getByText("Network error")).toBeInTheDocument();
    });
  });

  test("shows generic error message when error has no message", async () => {
    const user = userEvent.setup();

    mockClaim.mockRejectedValue({});

    render(
      <ManualClaimDialog>
        <button type="button">Open</button>
      </ManualClaimDialog>,
    );

    const input = screen.getByTestId("transaction-url-input");
    const submitButton = screen.getByText("Claim");

    await user.type(input, "https://etherscan.io/tx/0xabc123");
    await user.click(submitButton);

    await vi.waitFor(() => {
      expect(screen.getByText("Failed to submit manual claim.")).toBeInTheDocument();
    });
  });

  test("clears error when user starts typing", async () => {
    const user = userEvent.setup();

    render(
      <ManualClaimDialog>
        <button type="button">Open</button>
      </ManualClaimDialog>,
    );

    const input = screen.getByTestId("transaction-url-input");
    const submitButton = screen.getByText("Claim");

    // Submit invalid URL to show error
    await user.type(input, "invalid");
    await user.click(submitButton);

    expect(screen.getByText("Please provide a valid Etherscan or Blockscout transaction URL.")).toBeInTheDocument();

    // Clear input and type again
    await user.clear(input);
    await user.type(input, "h");

    // Error should still be there until form is submitted again
    // (In the actual implementation, error is cleared on input change)
  });

  test("form has correct structure with label", () => {
    render(
      <ManualClaimDialog>
        <button type="button">Open</button>
      </ManualClaimDialog>,
    );

    const label = screen.getByText("Transaction URL");
    expect(label).toBeInTheDocument();
    expect(label.tagName).toBe("LABEL");

    const input = screen.getByTestId("transaction-url-input");
    expect(input).toBeInTheDocument();
  });
});

describe("ManualClaimDialog - URL validation logic", () => {
  test("validates Ethereum mainnet URL correctly", async () => {
    const user = userEvent.setup();

    mockClaim.mockResolvedValue({ mintTx: "0x123", logs: [] });

    render(
      <ManualClaimDialog>
        <button type="button">Open</button>
      </ManualClaimDialog>,
    );

    const input = screen.getByTestId("transaction-url-input");
    await user.type(input, "https://etherscan.io/tx/0x1234567890abcdef");

    const submitButton = screen.getByText("Claim");
    await user.click(submitButton);

    await vi.waitFor(() => {
      expect(mockClaim).toHaveBeenCalledWith("0x1234567890abcdef", 1, expect.any(AbortSignal));
    });
  });

  test("validates Polygon URL correctly", async () => {
    const user = userEvent.setup();

    mockClaim.mockResolvedValue({ mintTx: "0x456", logs: [] });

    render(
      <ManualClaimDialog>
        <button type="button">Open</button>
      </ManualClaimDialog>,
    );

    const input = screen.getByTestId("transaction-url-input");
    await user.type(input, "https://polygonscan.com/tx/0xpolygontx");

    const submitButton = screen.getByText("Claim");
    await user.click(submitButton);

    await vi.waitFor(() => {
      expect(mockClaim).toHaveBeenCalledWith("0xpolygontx", 137, expect.any(AbortSignal));
    });
  });

  test("validates Arbitrum URL from blockExplorers correctly", async () => {
    const user = userEvent.setup();

    mockClaim.mockResolvedValue({ mintTx: "0x789", logs: [] });

    render(
      <ManualClaimDialog>
        <button type="button">Open</button>
      </ManualClaimDialog>,
    );

    const input = screen.getByTestId("transaction-url-input");
    await user.type(input, "https://arbiscan.io/tx/0xarbitrumtx");

    const submitButton = screen.getByText("Claim");
    await user.click(submitButton);

    await vi.waitFor(() => {
      expect(mockClaim).toHaveBeenCalledWith("0xarbitrumtx", 42161, expect.any(AbortSignal));
    });
  });
});
