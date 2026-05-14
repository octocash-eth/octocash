import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTransactionError, ERROR_MESSAGES, getErrorMessage } from "./errors";
import { ERROR_CODES, type ErrorCode } from "./types";

describe("errors", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("ERROR_MESSAGES", () => {
    it("should have messages for all error codes", () => {
      for (const code of Object.values(ERROR_CODES)) {
        expect(ERROR_MESSAGES[code]).toBeDefined();
        expect(ERROR_MESSAGES[code]).toHaveLength(2);
        expect(typeof ERROR_MESSAGES[code][0]).toBe("string");
        expect(typeof ERROR_MESSAGES[code][1]).toBe("string");
      }
    });

    it("should have non-empty messages", () => {
      for (const [title, message] of Object.values(ERROR_MESSAGES)) {
        expect(title.length).toBeGreaterThan(0);
        expect(message.length).toBeGreaterThan(0);
      }
    });
  });

  describe("getErrorMessage", () => {
    it("should return correct message for USER_REJECTED", () => {
      const [title, message] = getErrorMessage(ERROR_CODES.USER_REJECTED);
      expect(title).toBe("Transaction cancelled");
      expect(message).toBe("Click retry to try again.");
    });

    it("should return correct message for INSUFFICIENT_GAS", () => {
      const [title, message] = getErrorMessage(ERROR_CODES.INSUFFICIENT_GAS);
      expect(title).toBe("Insufficient funds for gas");
      expect(message).toBe("Add more ETH and retry.");
    });

    it("should return correct message for SLIPPAGE_EXCEEDED", () => {
      const [title, message] = getErrorMessage(ERROR_CODES.SLIPPAGE_EXCEEDED);
      expect(title).toBe("Price changed too much");
      expect(message).toBe("Retry for new quote.");
    });

    it("should return correct message for RPC_ERROR", () => {
      const [title, message] = getErrorMessage(ERROR_CODES.RPC_ERROR);
      expect(title).toBe("Network error");
      expect(message).toBe("Check connection and retry.");
    });

    it("should return correct message for TIMEOUT", () => {
      const [title, message] = getErrorMessage(ERROR_CODES.TIMEOUT);
      expect(title).toBe("Transaction took too long");
      expect(message).toBe("It may still be processing, retry to override the transaction.");
    });

    it("should return correct message for ATTESTATION_TIMEOUT", () => {
      const [title, message] = getErrorMessage(ERROR_CODES.ATTESTATION_TIMEOUT);
      expect(title).toBe("Bridge attestation not received within 1 minute");
      expect(message).toBe("The money may be stuck in CCTPv2, use the history page to resume the transaction.");
    });

    it("should return correct message for PLANNING_ERROR", () => {
      const [title, message] = getErrorMessage(ERROR_CODES.PLANNING_ERROR);
      expect(title).toBe("Failed to plan transaction");
      expect(message).toBe("Please try again.");
    });

    it("should return correct message for UNSUPPORTED_ROUTE", () => {
      const [title, message] = getErrorMessage(ERROR_CODES.UNSUPPORTED_ROUTE);
      expect(title).toBe("This route is not supported");
      expect(message).toBe("Please try with different tokens.");
    });

    it("should return correct message for EXTERNAL_API_ERROR", () => {
      const [title, message] = getErrorMessage(ERROR_CODES.EXTERNAL_API_ERROR);
      expect(title).toBe("External service error");
      expect(message).toBe("Please retry.");
    });

    it("should return correct message for EXECUTION_ERROR", () => {
      const [title, message] = getErrorMessage(ERROR_CODES.EXECUTION_ERROR);
      expect(title).toBe("Transaction failed");
      expect(message).toBe("Please try again.");
    });

    it("should return correct message for UNEXPECTED_ERROR", () => {
      const [title, message] = getErrorMessage(ERROR_CODES.UNEXPECTED_ERROR);
      expect(title).toBe("An unexpected error occurred");
      expect(message).toBe("Please try again.");
    });

    it("should fallback to UNEXPECTED_ERROR for unknown code", () => {
      const [title, message] = getErrorMessage("UNKNOWN_CODE" as ErrorCode);
      expect(title).toBe("An unexpected error occurred");
      expect(message).toBe("Please try again.");
    });
  });

  describe("createTransactionError", () => {
    describe("error code detection", () => {
      it("should detect USER_REJECTED from message", () => {
        const error = new Error("user rejected the transaction");
        const result = createTransactionError(error);
        expect(result.code).toBe(ERROR_CODES.USER_REJECTED);
        expect(result.recoverable).toBe(true);
      });

      it("should detect USER_REJECTED from code in message (case-insensitive)", () => {
        const error = new Error("Error: USER_REJECTED");
        const result = createTransactionError(error);
        expect(result.code).toBe(ERROR_CODES.USER_REJECTED);
      });

      it("should detect INSUFFICIENT_GAS from message", () => {
        const error = new Error("insufficient funds for gas");
        const result = createTransactionError(error);
        expect(result.code).toBe(ERROR_CODES.INSUFFICIENT_GAS);
        expect(result.recoverable).toBe(true);
      });

      it("should detect INSUFFICIENT_GAS from code in message (case-insensitive)", () => {
        const error = new Error("Error: INSUFFICIENT_GAS");
        const result = createTransactionError(error);
        expect(result.code).toBe(ERROR_CODES.INSUFFICIENT_GAS);
      });

      it("should detect INSUFFICIENT_GAS from 'insufficient funds' phrase", () => {
        const error = new Error("transaction failed: insufficient funds");
        const result = createTransactionError(error);
        expect(result.code).toBe(ERROR_CODES.INSUFFICIENT_GAS);
      });

      it("should detect SLIPPAGE_EXCEEDED from message", () => {
        const error = new Error("slippage tolerance exceeded");
        const result = createTransactionError(error);
        expect(result.code).toBe(ERROR_CODES.SLIPPAGE_EXCEEDED);
        expect(result.recoverable).toBe(true);
      });

      it("should detect SLIPPAGE_EXCEEDED from 'slippage' keyword", () => {
        const error = new Error("transaction failed due to slippage");
        const result = createTransactionError(error);
        expect(result.code).toBe(ERROR_CODES.SLIPPAGE_EXCEEDED);
      });

      it("should detect RPC_ERROR from message", () => {
        const error = new Error("network connection failed");
        const result = createTransactionError(error);
        expect(result.code).toBe(ERROR_CODES.RPC_ERROR);
        expect(result.recoverable).toBe(true);
      });

      it("should detect RPC_ERROR from code in message (case-insensitive)", () => {
        const error = new Error("RPC_ERROR");
        const result = createTransactionError(error);
        expect(result.code).toBe(ERROR_CODES.RPC_ERROR);
      });

      it("should detect RPC_ERROR from MetaMask 'Internal JSON-RPC error'", () => {
        const error = new Error("MetaMask - RPC Error: Internal JSON-RPC error.");
        const result = createTransactionError(error);
        expect(result.code).toBe(ERROR_CODES.RPC_ERROR);
        expect(result.recoverable).toBe(true);
      });

      it("should detect RPC_ERROR from generic 'rpc error' message", () => {
        const error = new Error("An rpc error occurred");
        const result = createTransactionError(error);
        expect(result.code).toBe(ERROR_CODES.RPC_ERROR);
      });

      it("should detect ATTESTATION_TIMEOUT before general TIMEOUT (case-insensitive)", () => {
        const error = new Error("ATTESTATION_TIMEOUT occurred");
        const result = createTransactionError(error);
        // ATTESTATION_TIMEOUT is checked before TIMEOUT, so it matches first
        expect(result.code).toBe(ERROR_CODES.ATTESTATION_TIMEOUT);
        expect(result.recoverable).toBe(true);
      });

      it("should detect TIMEOUT from 'timed out' phrase", () => {
        const error = new Error("request timed out");
        const result = createTransactionError(error);
        expect(result.code).toBe(ERROR_CODES.TIMEOUT);
        expect(result.recoverable).toBe(true);
      });

      it("should detect TIMEOUT from 'timeout' keyword", () => {
        const error = new Error("connection timeout error");
        const result = createTransactionError(error);
        expect(result.code).toBe(ERROR_CODES.TIMEOUT);
      });

      it("should detect PLANNING_ERROR from PlanningError class name (case-insensitive)", () => {
        const error = new Error("PlanningError: failed to create plan");
        const result = createTransactionError(error);
        expect(result.code).toBe(ERROR_CODES.PLANNING_ERROR);
        expect(result.recoverable).toBe(true);
      });

      it("should detect UNSUPPORTED_ROUTE from UnsupportedRouteError class name (case-insensitive)", () => {
        const error = new Error("UnsupportedRouteError: cannot bridge token");
        const result = createTransactionError(error);
        expect(result.code).toBe(ERROR_CODES.UNSUPPORTED_ROUTE);
        expect(result.recoverable).toBe(false);
      });

      it("should detect EXTERNAL_API_ERROR from ExternalAPIError class name (case-insensitive)", () => {
        const error = new Error("ExternalAPIError: service unavailable");
        const result = createTransactionError(error);
        expect(result.code).toBe(ERROR_CODES.EXTERNAL_API_ERROR);
        expect(result.recoverable).toBe(true);
      });

      it("should detect EXECUTION_ERROR from ExecutionError class name (case-insensitive)", () => {
        const error = new Error("ExecutionError: transaction reverted");
        const result = createTransactionError(error);
        expect(result.code).toBe(ERROR_CODES.EXECUTION_ERROR);
        expect(result.recoverable).toBe(true);
      });

      it("should default to UNEXPECTED_ERROR for unknown error", () => {
        const error = new Error("something completely unexpected");
        const result = createTransactionError(error);
        expect(result.code).toBe(ERROR_CODES.UNEXPECTED_ERROR);
        expect(result.recoverable).toBe(true);
      });

      it("should use provided default code when error is unknown and contains matching keyword", () => {
        // If the error message contains "ExecutionError" it will match regardless of default
        const error = new Error("ExecutionError in transaction");
        const result = createTransactionError(error, ERROR_CODES.PLANNING_ERROR);
        expect(result.code).toBe(ERROR_CODES.EXECUTION_ERROR);
      });

      it("should use default code when no pattern matches", () => {
        const error = new Error("some completely random error xyz123");
        const result = createTransactionError(error, ERROR_CODES.PLANNING_ERROR);
        // When no pattern matches, it uses the provided default code
        expect(result.code).toBe(ERROR_CODES.PLANNING_ERROR);
      });
    });

    describe("error handling", () => {
      it("should handle Error objects", () => {
        const error = new Error("test error");
        const result = createTransactionError(error);
        expect(result.details).toBe(error);
        expect(result.code).toBe(ERROR_CODES.UNEXPECTED_ERROR);
      });

      it("should handle string errors", () => {
        const result = createTransactionError("string error message");
        expect(result.details).toBe("string error message");
        expect(result.code).toBe(ERROR_CODES.UNEXPECTED_ERROR);
      });

      it("should handle non-string, non-Error objects", () => {
        const error = { custom: "error object" };
        const result = createTransactionError(error);
        expect(result.details).toBe(error);
      });

      it("should handle null", () => {
        const result = createTransactionError(null);
        expect(result.details).toBe(null);
      });

      it("should handle undefined", () => {
        const result = createTransactionError(undefined);
        expect(result.details).toBe(undefined);
      });
    });

    describe("result structure", () => {
      it("should include all required fields", () => {
        const error = new Error("test error");
        const result = createTransactionError(error);

        expect(result).toHaveProperty("code");
        expect(result).toHaveProperty("title");
        expect(result).toHaveProperty("message");
        expect(result).toHaveProperty("details");
        expect(result).toHaveProperty("recoverable");
        expect(result).toHaveProperty("timestamp");
      });

      it("should have correct message from getErrorMessage", () => {
        const error = new Error("user rejected");
        const result = createTransactionError(error);
        const [expectedTitle, expectedMessage] = getErrorMessage(ERROR_CODES.USER_REJECTED);

        expect(result.title).toBe(expectedTitle);
        expect(result.message).toBe(expectedMessage);
      });

      it("should have timestamp near current time", () => {
        const before = Date.now();
        const result = createTransactionError(new Error("test"));
        const after = Date.now();

        expect(result.timestamp).toBeGreaterThanOrEqual(before);
        expect(result.timestamp).toBeLessThanOrEqual(after);
      });

      it("should set recoverable to true by default", () => {
        const error = new Error("user rejected");
        const result = createTransactionError(error);
        expect(result.recoverable).toBe(true);
      });

      it("should set recoverable to false for UNSUPPORTED_ROUTE", () => {
        const error = new Error("UnsupportedRouteError");
        const result = createTransactionError(error);
        expect(result.recoverable).toBe(false);
      });
    });

    describe("console logging", () => {
      it("should log unmatched errors to console", () => {
        const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        const error = new Error("completely unknown error type");

        createTransactionError(error);

        expect(consoleErrorSpy).toHaveBeenCalledWith(
          "[Error Detection] Unmatched error:",
          expect.objectContaining({
            errorType: "Error",
            message: "completely unknown error type",
            fullError: error,
            assignedCode: ERROR_CODES.UNEXPECTED_ERROR,
          }),
        );

        consoleErrorSpy.mockRestore();
      });

      it("should not log matched errors to console", () => {
        const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        const error = new Error("user rejected");

        createTransactionError(error);

        expect(consoleErrorSpy).not.toHaveBeenCalled();

        consoleErrorSpy.mockRestore();
      });

      it("should log with correct errorType for custom errors", () => {
        const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

        class CustomError extends Error {
          constructor(message: string) {
            super(message);
            this.name = "CustomError";
          }
        }

        const error = new CustomError("custom error");
        createTransactionError(error);

        expect(consoleErrorSpy).toHaveBeenCalledWith(
          "[Error Detection] Unmatched error:",
          expect.objectContaining({
            errorType: "CustomError",
          }),
        );

        consoleErrorSpy.mockRestore();
      });
    });

    describe("case insensitivity", () => {
      it("should detect errors based on lowercased message patterns", () => {
        const testCases = [
          { message: "user rejected transaction", code: ERROR_CODES.USER_REJECTED },
          { message: "insufficient funds for gas", code: ERROR_CODES.INSUFFICIENT_GAS },
          { message: "slippage tolerance exceeded", code: ERROR_CODES.SLIPPAGE_EXCEEDED },
          { message: "network connection failed", code: ERROR_CODES.RPC_ERROR },
          { message: "request timed out", code: ERROR_CODES.TIMEOUT },
        ];

        for (const { message, code } of testCases) {
          const error = new Error(message);
          const result = createTransactionError(error);
          expect(result.code).toBe(code);
        }
      });

      it("should handle mixed case input correctly", () => {
        // All messages are lowercased before checking
        const testCases = [
          { message: "User Rejected Transaction", code: ERROR_CODES.USER_REJECTED },
          { message: "INSUFFICIENT FUNDS for gas", code: ERROR_CODES.INSUFFICIENT_GAS },
          { message: "Slippage Exceeded", code: ERROR_CODES.SLIPPAGE_EXCEEDED },
          { message: "NETWORK ERROR", code: ERROR_CODES.RPC_ERROR },
          { message: "Request TIMED OUT", code: ERROR_CODES.TIMEOUT },
        ];

        for (const { message, code } of testCases) {
          const error = new Error(message);
          const result = createTransactionError(error);
          expect(result.code).toBe(code);
        }
      });
    });
  });
});
