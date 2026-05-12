import type { Address } from "viem";
import type { Attestation } from "./cctp";

// ============================================================================
// Transaction Step Types (T001)
// ============================================================================

/**
 * Type of transaction operation in the consolidation plan
 */
export type TransactionType =
  | "swap" // Token swap using Odos
  | "bridge" // USDC bridge using CCTP
  | "attestation" // Wait for bridge attestation(s)
  | "claim" // Claim bridged tokens
  | "transfer"; // Simple transfer (same token, same chain)

/**
 * Execution status of a transaction step
 */
export type StepStatus =
  | "pending" // Not yet started
  | "executing" // Currently executing
  | "success" // Completed successfully
  | "failed" // Failed with error
  | "skipped"; // Skipped due to dependency failure

/**
 * Token amount with chain and wallet context
 */
export interface TokenAmount {
  token: Address; // Token contract address
  amount: bigint; // Amount in smallest unit (wei, etc.)
  chainId: number; // Chain ID
  walletAddress: Address; // Wallet holding the token
  symbol: string; // Token symbol (ETH, USDC, etc.)
  decimals: number; // Token decimals
  name?: string; // Token name (e.g., "USD Coin")
  unitaryPrice?: number; // Price per token in USD
  provenance?: string; // ID of step that produced this token (undefined for source tokens)
}

/**
 * Source token input for consolidation planning
 */
export type SourceToken = TokenAmount;

/**
 * Destination token for consolidation
 */
export type DestinationToken = Omit<TokenAmount, "amount">;

/**
 * Estimated gas cost for a single transaction step
 */
export interface StepGasEstimate {
  gasUnits: bigint;
  maxFeePerGas: bigint;
  gasCostWei: bigint;
  gasCostUsd: number;
  nativeSymbol: string;
}

/**
 * Single operation in the consolidation plan
 */
export interface TransactionStep {
  id: string; // Unique identifier for this step
  type: TransactionType; // Type of operation
  status: StepStatus; // Current execution status
  chainId: number; // Chain where this transaction executes

  // Input/Output
  inputTokens: [TokenAmount, ...TokenAmount[]]; // Tokens consumed by this step (minimum one)
  outputToken: TokenAmount; // Token produced (estimated pre-exec, actual post-exec)

  // Gas estimation (populated during planning, omitted for attestation steps)
  estimatedGas?: StepGasEstimate;

  // Execution details
  transactionHash?: string; // Blockchain tx hash (after execution)
  error?: TransactionError; // Error details if failed
  executedAt?: number; // Timestamp of execution
  quotedAt?: number; // When the quote was obtained (for swap steps)
}

// ============================================================================
// Consolidation State Types (T002)
// ============================================================================

/**
 * Overall status of the consolidation process
 */
export type ConsolidationStatus =
  | "planning" // Generating transaction plan
  | "ready" // Plan ready, waiting for user confirmation
  | "executing" // Executing transactions
  | "paused" // Paused on failure (waiting for retry/continue)
  | "completed" // All transactions successful
  | "partial"; // Completed with some skipped transactions

/**
 * Result of a single step execution
 */
export interface StepResult {
  stepId: string;
  status: "success" | "failed" | "skipped";
  chainId: number;

  // Success data
  actualOutput?: TokenAmount; // Actual token amount received
  transactionHash?: string;

  // Failure data
  error?: TransactionError;
  skipReason?: string; // Reason for skipping (e.g., "Depends on failed step X")
}

/**
 * Main state object for consolidation (persisted to localStorage)
 */
export interface ConsolidationState {
  id: string; // Unique consolidation session ID
  plan: TransactionStep[]; // Array of transaction steps
  currentStepIndex: number; // Index of currently executing step

  // Overall status
  status: ConsolidationStatus;

  // Results
  results: Record<string, StepResult>; // stepId -> result mapping

  // Metadata
  sourceTokens: SourceToken[]; // Original input tokens
  destinationToken: DestinationToken; // Target token/wallet

  // Execution metadata (intermediate data between steps)
  metadata?: {
    attestations?: Attestation[];
  };

  createdAt: number; // Timestamp
  updatedAt: number; // Timestamp

  // Retry tracking
  hasSubsequentExecution: boolean; // True if user continued past failure
}

// ============================================================================
// Error Types (T003)
// ============================================================================

/**
 * Error details for failed transactions
 */
export interface TransactionError {
  code: string; // Error code
  title: string; // User-friendly title
  message: string; // User-friendly message
  details?: unknown; // Technical details for debugging
  recoverable: boolean; // Can user retry?
  timestamp: number;
}

/**
 * Error codes for transaction failures
 */
export const ERROR_CODES = {
  USER_REJECTED: "USER_REJECTED",
  INSUFFICIENT_GAS: "INSUFFICIENT_GAS",
  INSUFFICIENT_INPUT_BALANCE: "INSUFFICIENT_INPUT_BALANCE",
  SLIPPAGE_EXCEEDED: "SLIPPAGE_EXCEEDED",
  RPC_ERROR: "RPC_ERROR",
  TIMEOUT: "TIMEOUT",
  ATTESTATION_TIMEOUT: "ATTESTATION_TIMEOUT",
  PLANNING_ERROR: "PLANNING_ERROR",
  UNSUPPORTED_ROUTE: "UNSUPPORTED_ROUTE",
  EXTERNAL_API_ERROR: "EXTERNAL_API_ERROR",
  EXECUTION_ERROR: "EXECUTION_ERROR",
  UNEXPECTED_ERROR: "UNEXPECTED_ERROR",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
