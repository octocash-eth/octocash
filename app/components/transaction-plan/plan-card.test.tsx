import { render, screen } from "@testing-library/react";
import { makeStep, makeToken, USDC_ETHEREUM, WALLET } from "test/test-helpers";
import { describe, expect, test, vi } from "vitest";
import type { StepResult, TransactionStep } from "~/lib/types";
import { ERROR_CODES } from "~/lib/types";

// Mock AddressAvatar component that uses wagmi hooks
vi.mock("~/components/address/address-avatar", () => ({
  default: ({ className }: { className?: string }) => (
    <div className={className} data-testid="address-avatar">
      <img src="mock-avatar.png" alt="" />
    </div>
  ),
}));

// Mock AddressDisplay components that use wagmi hooks
vi.mock("~/components/address/address-display", () => ({
  AddressDisplayRoot: ({ children, address }: { children: React.ReactNode; address: string }) => (
    <div data-testid="address-display-root" data-address={address}>
      {children}
    </div>
  ),
  AddressDisplayAvatar: ({ className }: { className?: string }) => (
    <div className={className} data-testid="address-display-avatar">
      <img src="mock-avatar.png" alt="" />
    </div>
  ),
  AddressDisplayText: () => <span data-testid="address-display-text">0x1234...7890</span>,
}));

// Mock TokenDisplay components that use wagmi hooks
vi.mock("~/components/token/token-display", () => ({
  TokenDisplayRoot: ({
    children,
    tokenAddress,
    chainId,
    className,
  }: {
    children: React.ReactNode;
    tokenAddress: string;
    chainId: number;
    className?: string;
  }) => (
    <div className={className} data-testid="token-display-root" data-token={tokenAddress} data-chain={chainId}>
      {children}
    </div>
  ),
  TokenDisplayIcon: ({ className }: { className?: string }) => (
    <div className={className} data-testid="token-display-icon" />
  ),
  TokenDisplaySymbol: () => <span data-testid="token-display-symbol">TOKEN</span>,
  TokenDisplayAmount: ({ amount }: { amount: bigint }) => (
    <span data-testid="token-display-amount">{amount.toString()}</span>
  ),
}));

// Mock ChainIcon component
vi.mock("~/components/chain/chain-icon", () => ({
  ChainIcon: ({ chain, className }: { chain: string; className?: string }) => (
    <div className={className} data-testid="chain-icon">
      {chain}
    </div>
  ),
}));

import { PlanCard } from "./plan-card";

const WETH_ADDRESS = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" as const;

describe("PlanCard", () => {
  const mockStep: TransactionStep = makeStep({
    id: "step-1",
    status: "pending",
    inputTokens: [makeToken(USDC_ETHEREUM, 1000000n, 1, { walletAddress: WALLET })],
    outputToken: makeToken(WETH_ADDRESS, 500000000000000000n, 1, {
      walletAddress: WALLET,
      symbol: "WETH",
      decimals: 18,
    }),
  });

  test("renders error message when step has failed status", () => {
    const failedStep: TransactionStep = {
      ...mockStep,
      status: "failed",
      error: {
        code: ERROR_CODES.INSUFFICIENT_GAS,
        title: "Insufficient funds for gas",
        message: "Add more ETH and retry.",
        recoverable: true,
        timestamp: Date.now(),
      },
    };

    render(<PlanCard step={failedStep} stepNumber={1} />);

    expect(screen.getByText("Failed")).toBeInTheDocument();
  });

  test("displays error title and message in title attribute for hover", () => {
    const errorTitle = "Transaction cancelled";
    const errorMessage = "Click retry to try again.";
    const failedStep: TransactionStep = {
      ...mockStep,
      status: "failed",
      error: {
        code: ERROR_CODES.USER_REJECTED,
        title: errorTitle,
        message: errorMessage,
        recoverable: true,
        timestamp: Date.now(),
      },
    };

    render(<PlanCard step={failedStep} stepNumber={1} />);

    const errorElement = screen.getByText(/Failed/i);
    expect(errorElement).toHaveAttribute("title", `${errorTitle}. ${errorMessage}`);
  });

  test("does not show error message for successful step", () => {
    const successStep: TransactionStep = {
      ...mockStep,
      status: "success",
      transactionHash: "0xabc123",
    };

    const result: StepResult = {
      stepId: "step-1",
      status: "success",
      chainId: 1,
      transactionHash: "0xabc123",
      actualOutput: mockStep.outputToken,
    };

    render(<PlanCard step={successStep} stepNumber={1} result={result} />);

    expect(screen.queryByText(/Failed/i)).not.toBeInTheDocument();
    expect(screen.getByText("View tx")).toBeInTheDocument();
  });

  test("renders pending step without error", () => {
    render(<PlanCard step={mockStep} stepNumber={1} />);

    expect(screen.queryByText(/Failed/i)).not.toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument(); // Step number badge
  });

  test("renders gas cost icon when estimatedGas is present", () => {
    const stepWithGas: TransactionStep = {
      ...mockStep,
      estimatedGas: {
        gasUnits: 500000n,
        maxFeePerGas: 20000000000n,
        gasCostWei: 13000000000000000n, // ~0.013 ETH
        gasCostUsd: 26,
        nativeSymbol: "ETH",
      },
    };

    const { container } = render(<PlanCard step={stepWithGas} stepNumber={1} />);

    // The Fuel icon should be present (lucide renders as svg)
    const fuelIcon = container.querySelector("svg.lucide-fuel");
    expect(fuelIcon).toBeInTheDocument();
  });

  test("does not render gas cost icon when estimatedGas is absent", () => {
    const { container } = render(<PlanCard step={mockStep} stepNumber={1} />);

    const fuelIcon = container.querySelector("svg.lucide-fuel");
    expect(fuelIcon).not.toBeInTheDocument();
  });
});
