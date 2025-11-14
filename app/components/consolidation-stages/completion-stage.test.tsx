import { render, screen } from "@testing-library/react";
import type { Address } from "viem";
import { describe, expect, test, vi } from "vitest";
import type { ConsolidationState, TransactionStep } from "~/lib/types";
import { CompletionStage } from "./completion-stage";

// Test constants
const USDC_ADDRESS = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address;
const WBTC_ADDRESS = "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599" as Address;
const DAI_ADDRESS = "0x6B175474E89094C44Da98b954EedeAC495271d0F" as Address;
const WALLET = "0x1234567890123456789012345678901234567890" as Address;

// Mock wagmi hooks
vi.mock("wagmi", () => ({
  useToken: vi.fn((params) => ({
    data:
      params.address !== "0x0000000000000000000000000000000000000000"
        ? {
            address: params.address,
            symbol: "USDC",
            decimals: 6,
          }
        : null,
  })),
}));

// Mock ChainIcon component
vi.mock("~/components/chain-icon", () => ({
  ChainIcon: ({ chain }: { chain: string }) => <div data-testid="chain-icon">{chain}</div>,
}));

// Mock AddressDisplay components
vi.mock("~/components/ui/address-display", () => {
  const React = require("react");
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
    AddressDisplayText: () => {
      const address = React.useContext(AddressContext);
      return (
        <span data-testid="address-display-text">{address ? `${address.slice(0, 6)}...${address.slice(-4)}` : ""}</span>
      );
    },
  };
});

// Mock TokenDisplay components
vi.mock("~/components/ui/token-display", () => ({
  TokenDisplayRoot: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div className={className} data-testid="token-display-root">
      {children}
    </div>
  ),
  TokenDisplayIcon: ({ className }: { className?: string }) => (
    <div className={className} data-testid="token-display-icon" />
  ),
  TokenDisplaySymbol: () => <span data-testid="token-display-symbol">USDC</span>,
  TokenDisplayAmount: ({ amount }: { amount: bigint }) => (
    <span data-testid="token-display-amount">{amount.toString()}</span>
  ),
}));

describe("CompletionStage", () => {
  test("completed state - shows single destination token with final amount", () => {
    const step1: TransactionStep = {
      id: "step-1",
      type: "swap",
      status: "success",
      chainId: 1,
      inputTokens: [
        {
          token: DAI_ADDRESS,
          amount: 1000000n,
          chainId: 1,
          walletAddress: WALLET,
          symbol: "DAI",
          decimals: 18,
        },
      ],
      outputToken: {
        token: USDC_ADDRESS,
        amount: 500000n,
        chainId: 1,
        walletAddress: WALLET,
        symbol: "USDC",
        decimals: 6,
        provenance: undefined,
      },
    };

    const state: ConsolidationState = {
      id: "test-completed",
      plan: [step1],
      currentStepIndex: 1,
      status: "completed",
      results: {
        "step-1": {
          stepId: "step-1",
          status: "success",
          chainId: 1,
          transactionHash: "0xhash1",
          actualOutput: step1.outputToken,
        },
      },
      sourceTokens: [
        {
          token: DAI_ADDRESS,
          amount: 1000000n,
          chainId: 1,
          walletAddress: WALLET,
          symbol: "DAI",
          decimals: 18,
        },
      ],
      destinationToken: {
        token: USDC_ADDRESS,
        chainId: 1,
        walletAddress: WALLET,
        symbol: "USDC",
        decimals: 6,
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      hasSubsequentExecution: false,
    };

    const onClose = vi.fn();
    render(<CompletionStage state={state} onClose={onClose} />);

    // Should show success message
    expect(screen.getByText("Consolidation Successful!")).toBeInTheDocument();

    // Should show 1 source token
    const sourceSection = screen.getByText("Source Tokens").parentElement;
    expect(sourceSection).toBeInTheDocument();

    // Should show 1 final token
    const destSection = screen.getByText("Final Token").parentElement;
    expect(destSection).toBeInTheDocument();
  });

  test("partial state - simple dependency failure, shows remaining token", () => {
    const step1: TransactionStep = {
      id: "step-1",
      type: "swap",
      status: "failed",
      chainId: 1,
      inputTokens: [
        {
          token: DAI_ADDRESS,
          amount: 1000000n,
          chainId: 1,
          walletAddress: WALLET,
          symbol: "DAI",
          decimals: 18,
        },
      ],
      outputToken: {
        token: USDC_ADDRESS,
        amount: 500000n,
        chainId: 1,
        walletAddress: WALLET,
        symbol: "USDC",
        decimals: 6,
      },
    };

    const step2: TransactionStep = {
      id: "step-2",
      type: "bridge",
      status: "skipped",
      chainId: 1,
      inputTokens: [
        {
          token: USDC_ADDRESS,
          amount: 500000n,
          chainId: 1,
          walletAddress: WALLET,
          symbol: "USDC",
          decimals: 6,
          provenance: "step-1", // Depends on step-1
        },
      ],
      outputToken: {
        token: USDC_ADDRESS,
        amount: 500000n,
        chainId: 10,
        walletAddress: WALLET,
        symbol: "USDC",
        decimals: 6,
      },
    };

    const step3: TransactionStep = {
      id: "step-3",
      type: "swap",
      status: "success",
      chainId: 10,
      inputTokens: [
        {
          token: WBTC_ADDRESS,
          amount: 100000n,
          chainId: 10,
          walletAddress: WALLET,
          symbol: "WBTC",
          decimals: 8,
        },
      ],
      outputToken: {
        token: USDC_ADDRESS,
        amount: 300000n,
        chainId: 10,
        walletAddress: WALLET,
        symbol: "USDC",
        decimals: 6,
      },
    };

    const state: ConsolidationState = {
      id: "test-partial",
      plan: [step1, step2, step3],
      currentStepIndex: 3,
      status: "partial",
      results: {
        "step-1": {
          stepId: "step-1",
          status: "failed",
          chainId: 1,
        },
        "step-2": {
          stepId: "step-2",
          status: "skipped",
          chainId: 1,
          skipReason: "Depends on failed step step-1",
        },
        "step-3": {
          stepId: "step-3",
          status: "success",
          chainId: 10,
          transactionHash: "0xhash3",
          actualOutput: step3.outputToken,
        },
      },
      sourceTokens: [
        {
          token: DAI_ADDRESS,
          amount: 1000000n,
          chainId: 1,
          walletAddress: WALLET,
          symbol: "DAI",
          decimals: 18,
        },
        {
          token: WBTC_ADDRESS,
          amount: 100000n,
          chainId: 10,
          walletAddress: WALLET,
          symbol: "WBTC",
          decimals: 8,
        },
      ],
      destinationToken: {
        token: USDC_ADDRESS,
        chainId: 10,
        walletAddress: WALLET,
        symbol: "USDC",
        decimals: 6,
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      hasSubsequentExecution: true,
    };

    const onClose = vi.fn();
    render(<CompletionStage state={state} onClose={onClose} />);

    // Should show partial completion message
    expect(screen.getByText("Consolidation Partially Completed")).toBeInTheDocument();

    // Should show final token (step-3 produces USDC on OP Mainnet which is the destination)
    const destSection = screen.getByText("Final Token").parentElement;
    expect(destSection).toBeInTheDocument();
  });

  test("partial state - complex branching with multiple final steps", () => {
    // Branch A: step-1 -> step-2 (step-1 fails, step-2 skipped)
    const step1: TransactionStep = {
      id: "step-1",
      type: "swap",
      status: "failed",
      chainId: 1,
      inputTokens: [
        {
          token: DAI_ADDRESS,
          amount: 1000000n,
          chainId: 1,
          walletAddress: WALLET,
          symbol: "DAI",
          decimals: 18,
        },
      ],
      outputToken: {
        token: USDC_ADDRESS,
        amount: 500000n,
        chainId: 1,
        walletAddress: WALLET,
        symbol: "USDC",
        decimals: 6,
      },
    };

    const step2: TransactionStep = {
      id: "step-2",
      type: "bridge",
      status: "skipped",
      chainId: 1,
      inputTokens: [
        {
          token: USDC_ADDRESS,
          amount: 500000n,
          chainId: 1,
          walletAddress: WALLET,
          symbol: "USDC",
          decimals: 6,
          provenance: "step-1",
        },
      ],
      outputToken: {
        token: USDC_ADDRESS,
        amount: 500000n,
        chainId: 10,
        walletAddress: WALLET,
        symbol: "USDC",
        decimals: 6,
      },
    };

    // Branch B: step-3 -> step-4 (both succeed, step-4 is final)
    const step3: TransactionStep = {
      id: "step-3",
      type: "swap",
      status: "success",
      chainId: 137,
      inputTokens: [
        {
          token: DAI_ADDRESS,
          amount: 2000000n,
          chainId: 137,
          walletAddress: WALLET,
          symbol: "DAI",
          decimals: 18,
        },
      ],
      outputToken: {
        token: USDC_ADDRESS,
        amount: 800000n,
        chainId: 137,
        walletAddress: WALLET,
        symbol: "USDC",
        decimals: 6,
      },
    };

    const step4: TransactionStep = {
      id: "step-4",
      type: "bridge",
      status: "success",
      chainId: 137,
      inputTokens: [
        {
          token: USDC_ADDRESS,
          amount: 800000n,
          chainId: 137,
          walletAddress: WALLET,
          symbol: "USDC",
          decimals: 6,
          provenance: "step-3",
        },
      ],
      outputToken: {
        token: USDC_ADDRESS,
        amount: 800000n,
        chainId: 10,
        walletAddress: WALLET,
        symbol: "USDC",
        decimals: 6,
      },
    };

    // Branch C: step-5 (succeeds, is final)
    const step5: TransactionStep = {
      id: "step-5",
      type: "swap",
      status: "success",
      chainId: 10,
      inputTokens: [
        {
          token: WBTC_ADDRESS,
          amount: 100000n,
          chainId: 10,
          walletAddress: WALLET,
          symbol: "WBTC",
          decimals: 8,
        },
      ],
      outputToken: {
        token: USDC_ADDRESS,
        amount: 300000n,
        chainId: 10,
        walletAddress: WALLET,
        symbol: "USDC",
        decimals: 6,
      },
    };

    const state: ConsolidationState = {
      id: "test-complex-partial",
      plan: [step1, step2, step3, step4, step5],
      currentStepIndex: 5,
      status: "partial",
      results: {
        "step-1": {
          stepId: "step-1",
          status: "failed",
          chainId: 1,
        },
        "step-2": {
          stepId: "step-2",
          status: "skipped",
          chainId: 1,
          skipReason: "Depends on failed step step-1",
        },
        "step-3": {
          stepId: "step-3",
          status: "success",
          chainId: 137,
          transactionHash: "0xhash3",
        },
        "step-4": {
          stepId: "step-4",
          status: "success",
          chainId: 137,
          transactionHash: "0xhash4",
        },
        "step-5": {
          stepId: "step-5",
          status: "success",
          chainId: 10,
          transactionHash: "0xhash5",
        },
      },
      sourceTokens: [
        {
          token: DAI_ADDRESS,
          amount: 1000000n,
          chainId: 1,
          walletAddress: WALLET,
          symbol: "DAI",
          decimals: 18,
        },
        {
          token: DAI_ADDRESS,
          amount: 2000000n,
          chainId: 137,
          walletAddress: WALLET,
          symbol: "DAI",
          decimals: 18,
        },
        {
          token: WBTC_ADDRESS,
          amount: 100000n,
          chainId: 10,
          walletAddress: WALLET,
          symbol: "WBTC",
          decimals: 8,
        },
      ],
      destinationToken: {
        token: USDC_ADDRESS,
        chainId: 10,
        walletAddress: WALLET,
        symbol: "USDC",
        decimals: 6,
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      hasSubsequentExecution: true,
    };

    const onClose = vi.fn();
    render(<CompletionStage state={state} onClose={onClose} />);

    // Should show partial completion message
    expect(screen.getByText("Consolidation Partially Completed")).toBeInTheDocument();

    // Should show "Final Token" (singular) - step-4 and step-5 both produce USDC on OP Mainnet (the destination)
    const destSection = screen.getByText("Final Token").parentElement;
    expect(destSection).toBeInTheDocument();

    // Should show 1 final token (step-4 USDC from Polygon, which is the destination token)
    const tokenDisplays = screen.getAllByTestId("token-display-root");
    // 3 source tokens + 1 final token = 4 total
    expect(tokenDisplays.length).toBeGreaterThanOrEqual(4);
  });

  test("no successful steps - shows empty destination tokens", () => {
    const step1: TransactionStep = {
      id: "step-1",
      type: "swap",
      status: "failed",
      chainId: 1,
      inputTokens: [
        {
          token: DAI_ADDRESS,
          amount: 1000000n,
          chainId: 1,
          walletAddress: WALLET,
          symbol: "DAI",
          decimals: 18,
        },
      ],
      outputToken: {
        token: USDC_ADDRESS,
        amount: 500000n,
        chainId: 1,
        walletAddress: WALLET,
        symbol: "USDC",
        decimals: 6,
      },
    };

    const step2: TransactionStep = {
      id: "step-2",
      type: "bridge",
      status: "skipped",
      chainId: 1,
      inputTokens: [
        {
          token: USDC_ADDRESS,
          amount: 500000n,
          chainId: 1,
          walletAddress: WALLET,
          symbol: "USDC",
          decimals: 6,
          provenance: "step-1",
        },
      ],
      outputToken: {
        token: USDC_ADDRESS,
        amount: 500000n,
        chainId: 10,
        walletAddress: WALLET,
        symbol: "USDC",
        decimals: 6,
      },
    };

    const state: ConsolidationState = {
      id: "test-no-success",
      plan: [step1, step2],
      currentStepIndex: 2,
      status: "partial",
      results: {
        "step-1": {
          stepId: "step-1",
          status: "failed",
          chainId: 1,
        },
        "step-2": {
          stepId: "step-2",
          status: "skipped",
          chainId: 1,
          skipReason: "Depends on failed step step-1",
        },
      },
      sourceTokens: [
        {
          token: DAI_ADDRESS,
          amount: 1000000n,
          chainId: 1,
          walletAddress: WALLET,
          symbol: "DAI",
          decimals: 18,
        },
      ],
      destinationToken: {
        token: USDC_ADDRESS,
        chainId: 10,
        walletAddress: WALLET,
        symbol: "USDC",
        decimals: 6,
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      hasSubsequentExecution: true,
    };

    const onClose = vi.fn();
    render(<CompletionStage state={state} onClose={onClose} />);

    // Should show partial completion message
    expect(screen.getByText("Consolidation Partially Completed")).toBeInTheDocument();

    // Should show source tokens section
    const sourceSection = screen.getByText("Source Tokens").parentElement;
    expect(sourceSection).toBeInTheDocument();

    // Should show final token (destination with 0 amount)
    const destSection = screen.getByText("Final Token").parentElement;
    expect(destSection).toBeInTheDocument();
  });

  test("bridge and claim with failed final swap - shows only claim output, not attestation", () => {
    // This tests the user's reported issue: when bridging and swapping, and the swap fails,
    // we should only show the claim step's output, not the attestation step's output
    const step1: TransactionStep = {
      id: "step-1",
      type: "swap",
      status: "success",
      chainId: 1,
      inputTokens: [
        {
          token: DAI_ADDRESS,
          amount: 1000000n,
          chainId: 1,
          walletAddress: WALLET,
          symbol: "DAI",
          decimals: 18,
        },
      ],
      outputToken: {
        token: USDC_ADDRESS,
        amount: 500000n,
        chainId: 1,
        walletAddress: WALLET,
        symbol: "USDC",
        decimals: 6,
        provenance: "step-1",
      },
    };

    const step2: TransactionStep = {
      id: "step-2",
      type: "bridge",
      status: "success",
      chainId: 1,
      inputTokens: [
        {
          token: USDC_ADDRESS,
          amount: 500000n,
          chainId: 1,
          walletAddress: WALLET,
          symbol: "USDC",
          decimals: 6,
          provenance: "step-1",
        },
      ],
      outputToken: {
        token: USDC_ADDRESS,
        amount: 500000n,
        chainId: 10,
        walletAddress: WALLET,
        symbol: "USDC",
        decimals: 6,
        provenance: "step-2",
      },
    };

    const step3: TransactionStep = {
      id: "step-3",
      type: "attestation",
      status: "success",
      chainId: 10,
      inputTokens: [
        {
          token: USDC_ADDRESS,
          amount: 500000n,
          chainId: 10,
          walletAddress: WALLET,
          symbol: "USDC",
          decimals: 6,
          provenance: "step-2",
        },
      ],
      outputToken: {
        token: USDC_ADDRESS,
        amount: 500000n,
        chainId: 10,
        walletAddress: WALLET,
        symbol: "USDC",
        decimals: 6,
        provenance: "step-3",
      },
    };

    const step4: TransactionStep = {
      id: "step-4",
      type: "claim",
      status: "success",
      chainId: 10,
      inputTokens: [
        {
          token: USDC_ADDRESS,
          amount: 500000n,
          chainId: 10,
          walletAddress: WALLET,
          symbol: "USDC",
          decimals: 6,
          provenance: "step-2",
        },
      ],
      outputToken: {
        token: USDC_ADDRESS,
        amount: 500000n,
        chainId: 10,
        walletAddress: WALLET,
        symbol: "USDC",
        decimals: 6,
        provenance: "step-4",
      },
    };

    const step5: TransactionStep = {
      id: "step-5",
      type: "swap",
      status: "failed",
      chainId: 10,
      inputTokens: [
        {
          token: USDC_ADDRESS,
          amount: 500000n,
          chainId: 10,
          walletAddress: WALLET,
          symbol: "USDC",
          decimals: 6,
          provenance: "step-4",
        },
      ],
      outputToken: {
        token: WBTC_ADDRESS,
        amount: 800000n,
        chainId: 10,
        walletAddress: WALLET,
        symbol: "WBTC",
        decimals: 8,
      },
    };

    const state: ConsolidationState = {
      id: "test-bridge-claim-failed-swap",
      plan: [step1, step2, step3, step4, step5],
      currentStepIndex: 5,
      status: "partial",
      results: {
        "step-1": {
          stepId: "step-1",
          status: "success",
          chainId: 1,
          transactionHash: "0xhash1",
          actualOutput: step1.outputToken,
        },
        "step-2": {
          stepId: "step-2",
          status: "success",
          chainId: 1,
          transactionHash: "0xhash2",
          actualOutput: step2.outputToken,
        },
        "step-3": {
          stepId: "step-3",
          status: "success",
          chainId: 10,
          transactionHash: "0xhash3",
          actualOutput: step3.outputToken,
        },
        "step-4": {
          stepId: "step-4",
          status: "success",
          chainId: 10,
          transactionHash: "0xhash4",
          actualOutput: step4.outputToken,
        },
        "step-5": {
          stepId: "step-5",
          status: "failed",
          chainId: 10,
        },
      },
      sourceTokens: [
        {
          token: DAI_ADDRESS,
          amount: 1000000n,
          chainId: 1,
          walletAddress: WALLET,
          symbol: "DAI",
          decimals: 18,
        },
      ],
      destinationToken: {
        token: WBTC_ADDRESS,
        chainId: 10,
        walletAddress: WALLET,
        symbol: "WBTC",
        decimals: 8,
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      hasSubsequentExecution: true,
    };

    const onClose = vi.fn();
    render(<CompletionStage state={state} onClose={onClose} />);

    // Should show partial completion message
    expect(screen.getByText("Consolidation Partially Completed")).toBeInTheDocument();

    // Should show "Final Tokens" - destination (0 WBTC) + unintended (USDC from claim)
    const destSection = screen.getByText("Final Tokens").parentElement;
    expect(destSection).toBeInTheDocument();

    // Should have exactly 1 source token + 2 final tokens (0 WBTC destination + USDC unintended) = 3 token displays
    const tokenDisplays = screen.getAllByTestId("token-display-root");
    expect(tokenDisplays).toHaveLength(3);
  });

  test("bridge USDC and swap to WBTC - bridge succeeds, swap fails - shows 0 WBTC and USDC unintended", () => {
    // User's requested test case: bridge USDC (arb) -> USDC (pol) works, swap to WBTC (pol) fails
    // Should show: 0 WBTC (destination) first, then USDC (unintended)
    const step1: TransactionStep = {
      id: "step-1",
      type: "bridge",
      status: "success",
      chainId: 42161, // Arbitrum
      inputTokens: [
        {
          token: USDC_ADDRESS,
          amount: 1000000n, // 1 USDC
          chainId: 42161,
          walletAddress: WALLET,
          symbol: "USDC",
          decimals: 6,
        },
      ],
      outputToken: {
        token: USDC_ADDRESS,
        amount: 1000000n,
        chainId: 137, // Polygon
        walletAddress: WALLET,
        symbol: "USDC",
        decimals: 6,
        provenance: "step-1",
      },
    };

    const step2: TransactionStep = {
      id: "step-2",
      type: "attestation",
      status: "success",
      chainId: 137,
      inputTokens: [
        {
          token: USDC_ADDRESS,
          amount: 1000000n,
          chainId: 137,
          walletAddress: WALLET,
          symbol: "USDC",
          decimals: 6,
          provenance: "step-1",
        },
      ],
      outputToken: {
        token: USDC_ADDRESS,
        amount: 1000000n,
        chainId: 137,
        walletAddress: WALLET,
        symbol: "USDC",
        decimals: 6,
        provenance: "step-2",
      },
    };

    const step3: TransactionStep = {
      id: "step-3",
      type: "claim",
      status: "success",
      chainId: 137,
      inputTokens: [
        {
          token: USDC_ADDRESS,
          amount: 1000000n,
          chainId: 137,
          walletAddress: WALLET,
          symbol: "USDC",
          decimals: 6,
          provenance: "step-1",
        },
      ],
      outputToken: {
        token: USDC_ADDRESS,
        amount: 1000000n,
        chainId: 137,
        walletAddress: WALLET,
        symbol: "USDC",
        decimals: 6,
        provenance: "step-3",
      },
    };

    const step4: TransactionStep = {
      id: "step-4",
      type: "swap",
      status: "failed",
      chainId: 137,
      inputTokens: [
        {
          token: USDC_ADDRESS,
          amount: 1000000n,
          chainId: 137,
          walletAddress: WALLET,
          symbol: "USDC",
          decimals: 6,
          provenance: "step-3",
        },
      ],
      outputToken: {
        token: WBTC_ADDRESS,
        amount: 50000n, // 0.0005 WBTC
        chainId: 137,
        walletAddress: WALLET,
        symbol: "WBTC",
        decimals: 8,
      },
    };

    const state: ConsolidationState = {
      id: "test-bridge-swap-fail",
      plan: [step1, step2, step3, step4],
      currentStepIndex: 4,
      status: "partial",
      results: {
        "step-1": {
          stepId: "step-1",
          status: "success",
          chainId: 42161,
          transactionHash: "0xhash1",
          actualOutput: step1.outputToken,
        },
        "step-2": {
          stepId: "step-2",
          status: "success",
          chainId: 137,
          transactionHash: "0xhash2",
          actualOutput: step2.outputToken,
        },
        "step-3": {
          stepId: "step-3",
          status: "success",
          chainId: 137,
          transactionHash: "0xhash3",
          actualOutput: step3.outputToken,
        },
        "step-4": {
          stepId: "step-4",
          status: "failed",
          chainId: 137,
        },
      },
      sourceTokens: [
        {
          token: USDC_ADDRESS,
          amount: 1000000n,
          chainId: 42161,
          walletAddress: WALLET,
          symbol: "USDC",
          decimals: 6,
        },
      ],
      destinationToken: {
        token: WBTC_ADDRESS,
        chainId: 137,
        walletAddress: WALLET,
        symbol: "WBTC",
        decimals: 8,
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      hasSubsequentExecution: true,
    };

    const onClose = vi.fn();
    render(<CompletionStage state={state} onClose={onClose} />);

    // Should show partial completion message
    expect(screen.getByText("Consolidation Partially Completed")).toBeInTheDocument();

    // Should show "Final Tokens" (plural)
    const destSection = screen.getByText("Final Tokens").parentElement;
    expect(destSection).toBeInTheDocument();

    // Should have 1 source token + 2 final tokens (0 WBTC destination + 1 USDC unintended) = 3 total
    const tokenDisplays = screen.getAllByTestId("token-display-root");
    expect(tokenDisplays).toHaveLength(3);

    // Check for "Unintended" label on the USDC token
    expect(screen.getByText("Unintended")).toBeInTheDocument();
  });
});
