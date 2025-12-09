import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { makeState, makeStep, makeToken, USDC_ETHEREUM, USDC_OPTIMISM, USDC_POLYGON } from "test/test-helpers";
import { describe, expect, test, vi } from "vitest";
import type { ConsolidationState } from "~/lib/types";
import History, { meta } from "./route";

// Mock react-router
vi.mock("react-router", () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => <a href={to}>{children}</a>,
  useLocation: () => ({ pathname: "/wallet/history" }),
}));

// Mock hooks
const mockRemoveConsolidation = vi.fn();
const mockClearAll = vi.fn();
const mockSaveConsolidation = vi.fn();
const mockGetConsolidation = vi.fn();
const mockGetIncompleteConsolidations = vi.fn();

vi.mock("~/hooks/use-consolidation-records", () => ({
  useConsolidationRecords: vi.fn(() => ({
    consolidations: [],
    removeConsolidation: mockRemoveConsolidation,
    clearAll: mockClearAll,
    saveConsolidation: mockSaveConsolidation,
    getConsolidation: mockGetConsolidation,
    getIncompleteConsolidations: mockGetIncompleteConsolidations,
  })),
}));

// Mock components
vi.mock("~/components/site", () => ({
  SiteHeader: () => <header data-testid="site-header">Site Header</header>,
}));

vi.mock("~/components/consolidation-tokens-summary", () => ({
  ConsolidationTokensSummary: ({ state }: { state: ConsolidationState }) => (
    <div data-testid="consolidation-tokens-summary">{state.id}</div>
  ),
}));

vi.mock("~/components/transaction-plan", () => ({
  TransactionPlanViewer: ({ state, showActions }: { state: ConsolidationState; showActions: boolean }) => (
    <div data-testid="transaction-plan-viewer" data-show-actions={showActions}>
      {state.id}
    </div>
  ),
}));

vi.mock("./manual-claim-dialog", () => ({
  default: ({ children }: { children: React.ReactNode }) => <div data-testid="manual-claim-dialog">{children}</div>,
}));

// Mock UI components
vi.mock("~/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    variant,
    size,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    variant?: string;
    size?: string;
  }) => (
    <button onClick={onClick} data-variant={variant} data-size={size} type="button">
      {children}
    </button>
  ),
}));

vi.mock("~/components/ui/card", () => ({
  Card: ({ children, className, onClick }: { children: React.ReactNode; className?: string; onClick?: () => void }) => (
    // biome-ignore lint/a11y/useSemanticElements: Mocking Card as div
    <div
      data-testid="card"
      className={className}
      onClick={onClick}
      onKeyDown={(e) => onClick && e.key === "Enter" && onClick()}
      role="button"
      tabIndex={0}
    >
      {children}
    </div>
  ),
  CardAction: ({ children }: { children: React.ReactNode }) => <div data-testid="card-action">{children}</div>,
  CardContent: ({ children }: { children: React.ReactNode }) => <div data-testid="card-content">{children}</div>,
  CardHeader: ({ children }: { children: React.ReactNode }) => <div data-testid="card-header">{children}</div>,
  CardTitle: ({ children }: { children: React.ReactNode }) => <h3>{children}</h3>,
}));

vi.mock("~/components/ui/dialog", () => ({
  Dialog: ({
    children,
    open,
    onOpenChange: _,
  }: {
    children: React.ReactNode;
    open: boolean;
    onOpenChange: (open: boolean) => void;
  }) => (
    <div data-testid="dialog" data-open={open}>
      {children}
    </div>
  ),
  DialogContent: ({ children }: { children: React.ReactNode }) => <div data-testid="dialog-content">{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div data-testid="dialog-footer">{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div data-testid="dialog-header">{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

// Mock icons
vi.mock("lucide-react", () => ({
  ChevronDown: () => <span data-testid="chevron-down">▼</span>,
  ChevronUp: () => <span data-testid="chevron-up">▲</span>,
  Inbox: () => <span data-testid="inbox-icon">📥</span>,
  Trash2: () => <span data-testid="trash-icon">🗑️</span>,
}));

// Mock meta utilities
vi.mock("~/utils/meta", () => ({
  generateMeta: vi.fn(() => [
    { title: "History" },
    { name: "description", content: "View your consolidation transaction history" },
    { name: "robots", content: "noindex" },
  ]),
}));

// Helper to create complete mock return value for useConsolidationRecords
function createMockHookReturn(consolidations: ConsolidationState[]) {
  return {
    consolidations,
    removeConsolidation: mockRemoveConsolidation,
    clearAll: mockClearAll,
    saveConsolidation: mockSaveConsolidation,
    getConsolidation: mockGetConsolidation,
    getIncompleteConsolidations: mockGetIncompleteConsolidations,
  };
}

// Helper to create mock consolidation data using test helpers
function createMockConsolidation(overrides: Partial<ConsolidationState> = {}): ConsolidationState {
  const token1 = makeToken(USDC_ETHEREUM, 100000000n, 1);
  const token2 = makeToken(USDC_OPTIMISM, 200000000n, 10);
  const outputToken = makeToken(USDC_ETHEREUM, 300000000n, 1);

  return makeState({
    id: "test-id-1",
    sourceTokens: [token1, token2],
    destinationToken: {
      token: USDC_ETHEREUM,
      chainId: 1,
      walletAddress: token1.walletAddress,
      symbol: "USDC",
      decimals: 6,
    },
    plan: [
      makeStep({
        id: "step-1",
        type: "swap",
        status: "success",
        inputTokens: [token1],
        outputToken,
      }),
      makeStep({
        id: "step-2",
        type: "bridge",
        status: "success",
        inputTokens: [token2],
        outputToken,
      }),
    ],
    createdAt: new Date("2025-01-01T10:00:00Z").getTime(),
    updatedAt: new Date("2025-01-01T11:00:00Z").getTime(),
    ...overrides,
  });
}

describe("History route - meta function", () => {
  test("returns meta tags with noIndex", () => {
    const result = meta();

    expect(result).toEqual([
      { title: "History" },
      { name: "description", content: "View your consolidation transaction history" },
      { name: "robots", content: "noindex" },
    ]);
  });
});

describe("History component - Empty state", () => {
  test("renders without crashing when empty", () => {
    render(<History />);
    expect(screen.getByTestId("site-header")).toBeInTheDocument();
  });

  test("shows empty state when no consolidations", () => {
    render(<History />);

    expect(screen.getByText("No consolidations yet")).toBeInTheDocument();
    expect(screen.getByText(/Run a consolidation to see it here/)).toBeInTheDocument();
    expect(screen.getByTestId("inbox-icon")).toBeInTheDocument();
  });

  test("empty state has link to start consolidating", () => {
    render(<History />);

    const link = screen.getByText("Start Consolidating").closest("a");
    expect(link).toHaveAttribute("href", "/dashboard");
  });

  test("does not show Clear All button when empty", () => {
    render(<History />);

    expect(screen.queryByText("Clear All")).not.toBeInTheDocument();
  });

  test("shows Manual CCTP Claim button when empty", () => {
    render(<History />);

    expect(screen.getByText("Manual CCTP Claim")).toBeInTheDocument();
    expect(screen.getByTestId("manual-claim-dialog")).toBeInTheDocument();
  });
});

describe("History component - With consolidations", () => {
  test("renders consolidations list", async () => {
    const { useConsolidationRecords } = await import("~/hooks/use-consolidation-records");
    const mockConsolidation = createMockConsolidation();

    vi.mocked(useConsolidationRecords).mockReturnValue(createMockHookReturn([mockConsolidation]));

    render(<History />);

    expect(screen.getByText("Consolidation History")).toBeInTheDocument();
    expect(screen.queryByText("No consolidations yet")).not.toBeInTheDocument();
  });

  test("shows Clear All button when consolidations exist", async () => {
    const { useConsolidationRecords } = await import("~/hooks/use-consolidation-records");
    const mockConsolidation = createMockConsolidation();

    vi.mocked(useConsolidationRecords).mockReturnValue(createMockHookReturn([mockConsolidation]));

    render(<History />);

    expect(screen.getByText("Clear All")).toBeInTheDocument();
  });

  test("renders multiple consolidation cards", async () => {
    const { useConsolidationRecords } = await import("~/hooks/use-consolidation-records");
    const mockConsolidations = [
      createMockConsolidation({ id: "test-1" }),
      createMockConsolidation({ id: "test-2" }),
      createMockConsolidation({ id: "test-3" }),
    ];

    vi.mocked(useConsolidationRecords).mockReturnValue(createMockHookReturn(mockConsolidations));

    render(<History />);

    const cards = screen.getAllByTestId("card");
    expect(cards).toHaveLength(3);
  });
});

describe("ConsolidationCard component", () => {
  test("displays consolidation date and time", async () => {
    const { useConsolidationRecords } = await import("~/hooks/use-consolidation-records");
    const mockConsolidation = createMockConsolidation({
      updatedAt: new Date("2025-01-15T14:30:00Z").getTime(),
    });

    vi.mocked(useConsolidationRecords).mockReturnValue(createMockHookReturn([mockConsolidation]));

    render(<History />);

    // Date will be formatted based on locale
    const cardHeader = screen.getByTestId("card-header");
    expect(cardHeader).toBeInTheDocument();
  });

  test("displays consolidation status with correct color", async () => {
    const { useConsolidationRecords } = await import("~/hooks/use-consolidation-records");
    const mockConsolidation = createMockConsolidation({ status: "completed" });

    vi.mocked(useConsolidationRecords).mockReturnValue(createMockHookReturn([mockConsolidation]));

    render(<History />);

    expect(screen.getByText("completed")).toBeInTheDocument();
  });

  test("displays token and chain counts", async () => {
    const { useConsolidationRecords } = await import("~/hooks/use-consolidation-records");
    const mockConsolidation = createMockConsolidation({
      sourceTokens: [
        makeToken(USDC_ETHEREUM, 100000000n, 1),
        makeToken(USDC_OPTIMISM, 200000000n, 10),
        makeToken(USDC_POLYGON, 300000000n, 137),
      ],
    });

    vi.mocked(useConsolidationRecords).mockReturnValue(createMockHookReturn([mockConsolidation]));

    render(<History />);

    expect(screen.getByText(/3 tokens across 3 chains/)).toBeInTheDocument();
  });

  test("displays step completion status", async () => {
    const { useConsolidationRecords } = await import("~/hooks/use-consolidation-records");

    const token1 = makeToken(USDC_ETHEREUM, 100000000n, 1);
    const token2 = makeToken(USDC_ETHEREUM, 100000000n, 1);
    const token3 = makeToken(USDC_ETHEREUM, 100000000n, 1);
    const token4 = makeToken(USDC_OPTIMISM, 200000000n, 10);
    const token5 = makeToken(USDC_OPTIMISM, 200000000n, 10);

    const mockConsolidation = createMockConsolidation({
      plan: [
        makeStep({
          id: "step-1",
          type: "swap",
          status: "success",
          inputTokens: [token1],
          outputToken: token2,
        }),
        makeStep({
          id: "step-2",
          type: "bridge",
          status: "success",
          inputTokens: [token2],
          outputToken: token3,
        }),
        makeStep({
          id: "step-3",
          type: "swap",
          status: "pending",
          inputTokens: [token4],
          outputToken: token5,
        }),
      ],
    });

    vi.mocked(useConsolidationRecords).mockReturnValue(createMockHookReturn([mockConsolidation]));

    render(<History />);

    expect(screen.getByText("2/3 steps completed")).toBeInTheDocument();
  });

  test("displays consolidation ID", async () => {
    const { useConsolidationRecords } = await import("~/hooks/use-consolidation-records");
    const mockConsolidation = createMockConsolidation({ id: "unique-test-id-123" });

    vi.mocked(useConsolidationRecords).mockReturnValue(createMockHookReturn([mockConsolidation]));

    render(<History />);

    expect(screen.getByText(/ID: unique-test-id-123/)).toBeInTheDocument();
  });

  test("shows expand button", async () => {
    const { useConsolidationRecords } = await import("~/hooks/use-consolidation-records");
    const mockConsolidation = createMockConsolidation();

    vi.mocked(useConsolidationRecords).mockReturnValue(createMockHookReturn([mockConsolidation]));

    render(<History />);

    expect(screen.getByTestId("chevron-down")).toBeInTheDocument();
  });

  test("shows delete button", async () => {
    const { useConsolidationRecords } = await import("~/hooks/use-consolidation-records");
    const mockConsolidation = createMockConsolidation();

    vi.mocked(useConsolidationRecords).mockReturnValue(createMockHookReturn([mockConsolidation]));

    render(<History />);

    expect(screen.getByTestId("trash-icon")).toBeInTheDocument();
  });
});

describe("ConsolidationCard - Expand/Collapse", () => {
  test("card is collapsed by default", async () => {
    const { useConsolidationRecords } = await import("~/hooks/use-consolidation-records");
    const mockConsolidation = createMockConsolidation();

    vi.mocked(useConsolidationRecords).mockReturnValue(createMockHookReturn([mockConsolidation]));

    render(<History />);

    expect(screen.queryByTestId("consolidation-tokens-summary")).not.toBeInTheDocument();
    expect(screen.queryByText("Transaction Steps")).not.toBeInTheDocument();
  });

  test("clicking card expands it", async () => {
    const { useConsolidationRecords } = await import("~/hooks/use-consolidation-records");
    const mockConsolidation = createMockConsolidation();

    vi.mocked(useConsolidationRecords).mockReturnValue(createMockHookReturn([mockConsolidation]));

    const user = userEvent.setup();
    render(<History />);

    const card = screen.getByTestId("card");
    await user.click(card);

    expect(screen.getByTestId("consolidation-tokens-summary")).toBeInTheDocument();
    expect(screen.getByText("Transaction Steps")).toBeInTheDocument();
    expect(screen.getByTestId("chevron-up")).toBeInTheDocument();
  });

  test("clicking expanded card collapses it", async () => {
    const { useConsolidationRecords } = await import("~/hooks/use-consolidation-records");
    const mockConsolidation = createMockConsolidation();

    vi.mocked(useConsolidationRecords).mockReturnValue(createMockHookReturn([mockConsolidation]));

    const user = userEvent.setup();
    render(<History />);

    const card = screen.getByTestId("card");

    // Expand
    await user.click(card);
    expect(screen.getByTestId("consolidation-tokens-summary")).toBeInTheDocument();

    // Collapse
    await user.click(card);
    expect(screen.queryByTestId("consolidation-tokens-summary")).not.toBeInTheDocument();
  });

  test("expanded card shows consolidation tokens summary", async () => {
    const { useConsolidationRecords } = await import("~/hooks/use-consolidation-records");
    const mockConsolidation = createMockConsolidation({ id: "test-123" });

    vi.mocked(useConsolidationRecords).mockReturnValue(createMockHookReturn([mockConsolidation]));

    const user = userEvent.setup();
    render(<History />);

    const card = screen.getByTestId("card");
    await user.click(card);

    const summary = screen.getByTestId("consolidation-tokens-summary");
    expect(summary).toHaveTextContent("test-123");
  });

  test("expanded card shows transaction plan viewer", async () => {
    const { useConsolidationRecords } = await import("~/hooks/use-consolidation-records");
    const mockConsolidation = createMockConsolidation({ id: "test-456" });

    vi.mocked(useConsolidationRecords).mockReturnValue(createMockHookReturn([mockConsolidation]));

    const user = userEvent.setup();
    render(<History />);

    const card = screen.getByTestId("card");
    await user.click(card);

    const viewer = screen.getByTestId("transaction-plan-viewer");
    expect(viewer).toHaveTextContent("test-456");
    expect(viewer).toHaveAttribute("data-show-actions", "false");
  });
});

describe("ConsolidationCard - Delete functionality", () => {
  test("clicking delete button shows confirmation dialog", async () => {
    const { useConsolidationRecords } = await import("~/hooks/use-consolidation-records");
    const mockConsolidation = createMockConsolidation();

    vi.mocked(useConsolidationRecords).mockReturnValue(createMockHookReturn([mockConsolidation]));

    const user = userEvent.setup();
    render(<History />);

    const deleteButton = screen.getByTestId("trash-icon").closest("button");
    if (!deleteButton) throw new Error("Delete button not found");
    await user.click(deleteButton);

    expect(screen.getByText("Delete Consolidation?")).toBeInTheDocument();
    expect(screen.getByText(/This will permanently delete this consolidation record/)).toBeInTheDocument();
  });

  test("confirming delete calls removeConsolidation", async () => {
    const { useConsolidationRecords } = await import("~/hooks/use-consolidation-records");
    const mockConsolidation = createMockConsolidation({ id: "delete-me-123" });

    vi.mocked(useConsolidationRecords).mockReturnValue(createMockHookReturn([mockConsolidation]));

    const user = userEvent.setup();
    render(<History />);

    // Open delete dialog
    // Open delete dialog
    const deleteButton = screen.getByTestId("trash-icon").closest("button");
    if (!deleteButton) throw new Error("Delete button not found");
    await user.click(deleteButton);

    // Confirm deletion
    const dialogs = screen.getAllByTestId("dialog-footer");
    const deleteDialog = dialogs[0]; // First dialog is the card's delete dialog
    const confirmButton = within(deleteDialog).getByText("Delete");
    await user.click(confirmButton);

    expect(mockRemoveConsolidation).toHaveBeenCalledWith("delete-me-123");
  });

  test("canceling delete does not call removeConsolidation", async () => {
    const { useConsolidationRecords } = await import("~/hooks/use-consolidation-records");
    const mockConsolidation = createMockConsolidation({ id: "keep-me-456" });

    vi.mocked(useConsolidationRecords).mockReturnValue(createMockHookReturn([mockConsolidation]));

    mockRemoveConsolidation.mockClear();

    const user = userEvent.setup();
    render(<History />);

    // Open delete dialog
    // Open delete dialog
    const deleteButton = screen.getByTestId("trash-icon").closest("button");
    if (!deleteButton) throw new Error("Delete button not found");
    await user.click(deleteButton);

    // Cancel deletion
    const dialogs = screen.getAllByTestId("dialog-footer");
    const deleteDialog = dialogs[0];
    const cancelButton = within(deleteDialog).getByText("Cancel");
    await user.click(cancelButton);

    expect(mockRemoveConsolidation).not.toHaveBeenCalled();
  });
});

describe("Clear All functionality", () => {
  test("clicking Clear All shows confirmation dialog", async () => {
    const { useConsolidationRecords } = await import("~/hooks/use-consolidation-records");
    const mockConsolidation = createMockConsolidation();

    vi.mocked(useConsolidationRecords).mockReturnValue(createMockHookReturn([mockConsolidation]));

    const user = userEvent.setup();
    render(<History />);

    const clearAllButton = screen.getByText("Clear All");
    await user.click(clearAllButton);

    expect(screen.getByText("Clear All History?")).toBeInTheDocument();
    expect(screen.getByText(/This will permanently delete all consolidation records/)).toBeInTheDocument();
  });

  test("confirming Clear All calls clearAll", async () => {
    const { useConsolidationRecords } = await import("~/hooks/use-consolidation-records");
    const mockConsolidation = createMockConsolidation();

    vi.mocked(useConsolidationRecords).mockReturnValue(createMockHookReturn([mockConsolidation]));

    const user = userEvent.setup();
    render(<History />);

    // Open Clear All dialog
    const clearAllButton = screen.getByText("Clear All");
    await user.click(clearAllButton);

    // Confirm clear all - we need to find the "Delete All" button in the dialog footer
    const _dialogs = screen.getAllByTestId("dialog");
    // Find the dialog that's currently open (last one in the array)
    const confirmButton = screen.getByText("Delete All");
    await user.click(confirmButton);

    expect(mockClearAll).toHaveBeenCalled();
  });

  test("canceling Clear All does not call clearAll", async () => {
    const { useConsolidationRecords } = await import("~/hooks/use-consolidation-records");
    const mockConsolidation = createMockConsolidation();

    vi.mocked(useConsolidationRecords).mockReturnValue(createMockHookReturn([mockConsolidation]));

    mockClearAll.mockClear();

    const user = userEvent.setup();
    render(<History />);

    // Open Clear All dialog
    const clearAllButton = screen.getByText("Clear All");
    await user.click(clearAllButton);

    // Cancel - find the cancel button (there are multiple, get all and find the right one)
    const cancelButtons = screen.getAllByText("Cancel");
    // The Clear All dialog's cancel button should be the last one
    const clearAllCancelButton = cancelButtons[cancelButtons.length - 1];
    await user.click(clearAllCancelButton);

    expect(mockClearAll).not.toHaveBeenCalled();
  });
});

describe("Status colors", () => {
  const statusColors = [
    { status: "completed", expectedText: "completed" },
    { status: "partial", expectedText: "partial" },
    { status: "paused", expectedText: "paused" },
    { status: "executing", expectedText: "executing" },
  ] as const;

  test.each(statusColors)("displays correct color for $status status", async ({ status, expectedText }) => {
    const { useConsolidationRecords } = await import("~/hooks/use-consolidation-records");
    const mockConsolidation = createMockConsolidation({ status: status as ConsolidationState["status"] });

    vi.mocked(useConsolidationRecords).mockReturnValue(createMockHookReturn([mockConsolidation]));

    render(<History />);

    expect(screen.getByText(expectedText)).toBeInTheDocument();
  });
});

describe("Multiple consolidations", () => {
  test("can expand different cards independently", async () => {
    const { useConsolidationRecords } = await import("~/hooks/use-consolidation-records");
    const mockConsolidations = [createMockConsolidation({ id: "card-1" }), createMockConsolidation({ id: "card-2" })];

    vi.mocked(useConsolidationRecords).mockReturnValue(createMockHookReturn(mockConsolidations));

    const user = userEvent.setup();
    render(<History />);

    const cards = screen.getAllByTestId("card");

    // Expand first card
    await user.click(cards[0]);
    const summaries = screen.getAllByTestId("consolidation-tokens-summary");
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toHaveTextContent("card-1");

    // Expand second card
    await user.click(cards[1]);
    const summariesAfter = screen.getAllByTestId("consolidation-tokens-summary");
    expect(summariesAfter).toHaveLength(2);
  });

  test("displays consolidations in order", async () => {
    const { useConsolidationRecords } = await import("~/hooks/use-consolidation-records");
    const mockConsolidations = [
      createMockConsolidation({ id: "first-consolidation" }),
      createMockConsolidation({ id: "second-consolidation" }),
      createMockConsolidation({ id: "third-consolidation" }),
    ];

    vi.mocked(useConsolidationRecords).mockReturnValue(createMockHookReturn(mockConsolidations));

    render(<History />);

    expect(screen.getByText(/ID: first-consolidation/)).toBeInTheDocument();
    expect(screen.getByText(/ID: second-consolidation/)).toBeInTheDocument();
    expect(screen.getByText(/ID: third-consolidation/)).toBeInTheDocument();
  });
});
