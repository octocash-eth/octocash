import { render, screen } from "@testing-library/react";
import { makeState, makeStep, makeToken, USDC_ETHEREUM, WALLET } from "test/test-helpers";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { DestinationToken } from "~/lib/types";
import { TransactionPlanExecutor } from "./transaction-plan-executor";

// Mock the planning + execution hooks so the tests drive the component's
// branching directly (loader vs plan vs error) without network or wagmi.
const mockUsePlanning = vi.fn();
vi.mock("~/hooks/use-consolidation-planning", () => ({
  useConsolidationPlanning: (options: unknown) => mockUsePlanning(options),
}));

const mockUseExecution = vi.fn();
vi.mock("~/hooks/use-consolidation-execution", () => ({
  useConsolidationExecution: (options: unknown) => mockUseExecution(options),
}));

vi.mock("./plan-list", () => ({
  PlanList: () => <div data-testid="plan-list" />,
}));

vi.mock("./loading-states/planning-loader", () => ({
  PlanningLoader: () => <div data-testid="planning-loader" />,
}));

const planningResult = (overrides: Record<string, unknown> = {}) => ({
  state: null,
  isPlanning: false,
  planningPhase: null,
  planError: "",
  planWarnings: [],
  generatePlan: vi.fn(),
  attemptCount: 0,
  ...overrides,
});

const executionResult = (overrides: Record<string, unknown> = {}) => ({
  state: null,
  isExecuting: false,
  executeOrResume: vi.fn(),
  retryFailedStep: vi.fn(),
  skipFailedStep: vi.fn(),
  liveProgress: {},
  ...overrides,
});

const destinationToken: DestinationToken = {
  token: USDC_ETHEREUM,
  chainId: 1,
  walletAddress: WALLET,
  symbol: "USDC",
  decimals: 6,
};

const executingState = makeState({
  plan: [
    makeStep({
      id: "step-1",
      status: "executing",
      inputTokens: [makeToken(USDC_ETHEREUM, 1000000n, 1)],
      outputToken: makeToken(USDC_ETHEREUM, 1000000n, 1),
    }),
  ],
  sourceTokens: [makeToken(USDC_ETHEREUM, 1000000n, 1)],
  destinationToken,
  status: "executing",
});

const renderExecutor = () =>
  render(
    <TransactionPlanExecutor
      planId="plan-1"
      sourceTokens={[makeToken(USDC_ETHEREUM, 1000000n, 1)]}
      destinationToken={destinationToken}
    />,
  );

describe("TransactionPlanExecutor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUsePlanning.mockReturnValue(planningResult());
    mockUseExecution.mockReturnValue(executionResult());
  });

  test("shows the planning loader during initial planning", () => {
    mockUsePlanning.mockReturnValue(planningResult({ isPlanning: true }));

    renderExecutor();

    expect(screen.getByTestId("planning-loader")).toBeInTheDocument();
    expect(screen.queryByTestId("plan-list")).not.toBeInTheDocument();
  });

  test("keeps the plan visible when planning re-runs mid-execution", () => {
    // A wallet-key change mid-execution re-arms the planning query: state
    // goes null + isPlanning true while the live execution state persists.
    mockUsePlanning.mockReturnValue(planningResult({ isPlanning: true }));
    mockUseExecution.mockReturnValue(executionResult({ state: executingState, isExecuting: true }));

    renderExecutor();

    expect(screen.getByTestId("plan-list")).toBeInTheDocument();
    expect(screen.queryByTestId("planning-loader")).not.toBeInTheDocument();
  });

  test("plans with the query enabled before execution starts", () => {
    renderExecutor();

    expect(mockUsePlanning).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: true }));
  });

  test("disables planning once execution is underway", () => {
    mockUseExecution.mockReturnValue(executionResult({ state: executingState, isExecuting: true }));

    renderExecutor();

    expect(mockUsePlanning).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: false }));
  });

  test("keeps planning disabled after execution completes", () => {
    mockUseExecution.mockReturnValue(executionResult({ state: { ...executingState, status: "completed" } }));

    renderExecutor();

    expect(mockUsePlanning).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: false }));
  });
});
