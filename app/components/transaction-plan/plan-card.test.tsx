import { render, screen } from "@testing-library/react";
import type { Address } from "viem";
import { describe, expect, test, vi } from "vitest";
import type { StepResult, TransactionStep } from "~/lib/types";
import { ERROR_CODES } from "~/lib/types";

// Mock AddressAvatar component that uses wagmi hooks
vi.mock("~/components/address-avatar", () => ({
  default: ({ className }: { addressOrEns: string; className?: string }) => (
    <div className={className} data-testid="address-avatar">
      <img src="mock-avatar.png" alt="" />
    </div>
  ),
}));

import { PlanCard } from "./plan-card";

describe("PlanCard", () => {
  const mockStep: TransactionStep = {
    id: "step-1",
    type: "swap",
    status: "pending",
    chainId: 1,
    inputTokens: [
      {
        token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address,
        amount: 1000000n,
        chainId: 1,
        walletAddress: "0x1234567890123456789012345678901234567890" as Address,
        symbol: "USDC",
        decimals: 6,
      },
    ],
    outputToken: {
      token: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" as Address,
      amount: 500000000000000000n,
      chainId: 1,
      walletAddress: "0x1234567890123456789012345678901234567890" as Address,
      symbol: "WETH",
      decimals: 18,
    },
    dependsOn: [],
    partialDependency: false,
  };

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
});
