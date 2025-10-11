import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { ERROR_CODES, type TransactionError } from "~/lib/types";
import { ExecutionStatusAlert } from "./execution-status-alert";

describe("ExecutionStatusAlert", () => {
  test("shows custom error message when paused with error", () => {
    const error = {
      title: "Insufficient funds for gas",
      message: "Add more ETH and retry.",
      code: ERROR_CODES.INSUFFICIENT_GAS,
      recoverable: true,
      timestamp: Date.now(),
    };
    render(<ExecutionStatusAlert status="paused" error={error} />);

    expect(screen.getByText(error.title)).toBeInTheDocument();
    expect(screen.getByText(error.message)).toBeInTheDocument();
  });

  test("shows default message when paused without error", () => {
    render(<ExecutionStatusAlert status="paused" />);

    expect(screen.getByText(/A transaction failed\./i)).toBeInTheDocument();
    expect(screen.getByText(/You can retry it or skip and continue/i)).toBeInTheDocument();
  });

  test("renders completed status correctly", () => {
    render(<ExecutionStatusAlert status="completed" />);

    expect(screen.getByText(/Success!/i)).toBeInTheDocument();
    expect(screen.getByText(/All transactions completed successfully/i)).toBeInTheDocument();
  });

  test("renders partial status correctly", () => {
    render(<ExecutionStatusAlert status="partial" />);

    expect(screen.getByText(/Partially Completed/i)).toBeInTheDocument();
    expect(screen.getByText(/Some transactions failed or were skipped/i)).toBeInTheDocument();
  });

  test("renders nothing for non-alert statuses", () => {
    const { container } = render(<ExecutionStatusAlert status="ready" />);
    expect(container.firstChild).toBeNull();
  });

  test("renders nothing for executing status", () => {
    const { container } = render(<ExecutionStatusAlert status="executing" />);
    expect(container.firstChild).toBeNull();
  });

  test("shows error title and message separately", () => {
    const error: TransactionError = {
      title: "Price changed too much",
      message: "Retry for new quote.",
      code: ERROR_CODES.SLIPPAGE_EXCEEDED,
      recoverable: true,
      timestamp: Date.now(),
    };
    render(<ExecutionStatusAlert status="paused" error={error} />);

    // Title and message should be shown separately
    expect(screen.getByText("Price changed too much")).toBeInTheDocument();
    expect(screen.getByText("Retry for new quote.")).toBeInTheDocument();
  });
});
