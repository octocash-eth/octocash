import type { ErrorCode, TransactionError } from "./types";
import { ERROR_CODES } from "./types";

/**
 * User-friendly error messages for each error code (T021)
 */
export const ERROR_MESSAGES: Record<ErrorCode, [string, string]> = {
  [ERROR_CODES.USER_REJECTED]: ["Transaction cancelled", "Click retry to try again."],
  [ERROR_CODES.INSUFFICIENT_GAS]: ["Insufficient funds for gas", "Add more ETH and retry."],
  [ERROR_CODES.INSUFFICIENT_INPUT_BALANCE]: [
    "Not enough tokens to execute this step",
    "The wallet's balance is below the planned input amount. Top up and retry, or skip this step.",
  ],
  [ERROR_CODES.SLIPPAGE_EXCEEDED]: ["Price changed too much", "Retry for new quote."],
  [ERROR_CODES.RPC_ERROR]: ["Network error", "Check connection and retry."],
  [ERROR_CODES.TIMEOUT]: [
    "Transaction took too long",
    "It may still be processing, retry to override the transaction.",
  ],
  [ERROR_CODES.TX_NOT_BROADCAST]: [
    "Transaction wasn't broadcast",
    "Your wallet signed the transaction, but it wasn't broadcast to the network. Please try again.",
  ],
  [ERROR_CODES.ATTESTATION_TIMEOUT]: [
    "Bridge attestation not received within 20 minutes",
    "The money may be stuck in CCTPv2, use the history page to resume the transaction.",
  ],
  [ERROR_CODES.GAS_TOPUP_TIMEOUT]: [
    "Gas delivery timed out",
    "The gas refuel may still be processing. Retry to check again.",
  ],
  [ERROR_CODES.PLANNING_ERROR]: ["Failed to plan transaction", "Please try again."],
  [ERROR_CODES.UNSUPPORTED_ROUTE]: ["This route is not supported", "Please try with different tokens."],
  [ERROR_CODES.EXTERNAL_API_ERROR]: ["External service error", "Please retry."],
  [ERROR_CODES.EXECUTION_ERROR]: ["Transaction failed", "Please try again."],
  [ERROR_CODES.UNEXPECTED_ERROR]: ["An unexpected error occurred", "Please try again."],
};

/**
 * Get user-friendly error message from error code
 * @param code - Error code
 * @returns User-friendly message
 */
export function getErrorMessage(code: ErrorCode): [string, string] {
  return ERROR_MESSAGES[code] || ERROR_MESSAGES[ERROR_CODES.UNEXPECTED_ERROR];
}

/**
 * Create a TransactionError from an unknown error
 * @param error - Error object
 * @param defaultCode - Default error code if cannot be determined
 * @returns Transaction error object
 */
export function createTransactionError(
  error: unknown,
  defaultCode: ErrorCode = ERROR_CODES.UNEXPECTED_ERROR,
): TransactionError {
  const errMessage = error instanceof Error ? error.message : String(error);

  // Attempt to extract error code from message
  let code: ErrorCode = defaultCode;
  let recoverable = true;

  const messageIncludes = (str: string) => errMessage.toLowerCase().includes(str.toLowerCase());

  const errName = (error as { name?: string } | null | undefined)?.name;
  if (errName === "InsufficientInputBalanceError") {
    code = ERROR_CODES.INSUFFICIENT_INPUT_BALANCE;
  } else if (errName === "TransactionNotBroadcastError") {
    code = ERROR_CODES.TX_NOT_BROADCAST;
  } else if (messageIncludes("USER_REJECTED") || messageIncludes("user rejected")) {
    code = ERROR_CODES.USER_REJECTED;
  } else if (messageIncludes("INSUFFICIENT_GAS") || messageIncludes("insufficient funds")) {
    code = ERROR_CODES.INSUFFICIENT_GAS;
  } else if (messageIncludes("SLIPPAGE_EXCEEDED") || messageIncludes("slippage")) {
    code = ERROR_CODES.SLIPPAGE_EXCEEDED;
  } else if (
    messageIncludes("RPC_ERROR") ||
    messageIncludes("JSON-RPC") ||
    messageIncludes("rpc error") ||
    messageIncludes("network")
  ) {
    code = ERROR_CODES.RPC_ERROR;
  } else if (messageIncludes("ATTESTATION_TIMEOUT")) {
    code = ERROR_CODES.ATTESTATION_TIMEOUT;
  } else if (messageIncludes("GAS_TOPUP_TIMEOUT")) {
    code = ERROR_CODES.GAS_TOPUP_TIMEOUT;
  } else if (messageIncludes("TIMEOUT") || messageIncludes("timed out")) {
    code = ERROR_CODES.TIMEOUT;
  } else if (messageIncludes("PlanningError")) {
    code = ERROR_CODES.PLANNING_ERROR;
  } else if (messageIncludes("UnsupportedRouteError")) {
    code = ERROR_CODES.UNSUPPORTED_ROUTE;
    recoverable = false; // Cannot recover from unsupported routes
  } else if (messageIncludes("ExternalAPIError")) {
    code = ERROR_CODES.EXTERNAL_API_ERROR;
  } else if (messageIncludes("ExecutionError")) {
    code = ERROR_CODES.EXECUTION_ERROR;
  }

  // Log unmatched errors to help debug error detection
  if (code === ERROR_CODES.UNEXPECTED_ERROR) {
    console.error("[Error Detection] Unmatched error:", {
      errorType: error?.constructor?.name,
      message: errMessage,
      fullError: error,
      assignedCode: code,
    });
  }

  const [title, message] = getErrorMessage(code);

  return {
    code,
    title,
    message,
    details: error,
    recoverable,
    timestamp: Date.now(),
  };
}
