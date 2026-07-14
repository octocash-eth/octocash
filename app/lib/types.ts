import type { Address, Hex } from "viem";
import type { AccountsRecord } from "./accounts";
import type { Attestation } from "./cctp";
import type { GasRefuelRecord } from "./gas-refuel";
import type { OmnibridgeClaim, OmnibridgeDelivery } from "./omnibridge";

// ============================================================================
// Transaction Step Types (T001)
// ============================================================================

/**
 * Type of transaction operation in the consolidation plan
 */
export type TransactionType =
  | "swap" // Token swap using Delora
  | "bridge" // USDC bridge using CCTP
  | "attestation" // Wait for bridge attestation(s)
  | "claim" // Claim bridged tokens
  | "transfer" // Simple transfer (same token, same chain)
  | "gas-topup" // Send native token (Gas.zip, Delora fallback) to refuel destination chains
  | "gas-topup-wait" // Wait for refuel delivery on destination chains
  | "shield" // Deposit ERC20 into Railgun, credited to a private 0zk address
  | "gnosis-bridge" // Omnibridge relay between Gnosis and mainnet (either direction; USDC or a direct-route token)
  | "gnosis-wait" // Wait for AMB signatures (egress) or token delivery (ingress)
  | "gnosis-claim"; // executeSignatures on mainnet to release the Omnibridge token

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
  provenance?: string; // ID of step that produced this token (undefined for source tokens)
}

/**
 * Source token input for consolidation planning
 */
export type SourceToken = TokenAmount;

/**
 * Destination token for consolidation
 *
 * When `railgunAddress` is set, the consolidation ends with a `shield` step
 * that deposits the token into Railgun for that 0zk address. `walletAddress`
 * then holds the public wallet performing the shield: the UI passes
 * `zeroAddress` as a placeholder and planning rewrites it to the resolved
 * intermediate (connected) wallet.
 */
export type DestinationToken = Omit<TokenAmount, "amount"> & {
  railgunAddress?: string;
};

/**
 * Where a step's gas-unit figure came from, strongest to weakest:
 * `simulated` (eth_simulateV1 batch), `delora-hint` (quote's own gasLimit),
 * `estimate-gas` (per-op eth_estimateGas), `budget` (static upper bound).
 */
export type GasEstimateSource = "simulated" | "delora-hint" | "estimate-gas" | "budget";

/**
 * Estimated gas cost for a single transaction step.
 * Cost is tracked in native wei only; fiat conversion happens at the UI layer
 * via the shared token-price provider.
 */
export interface StepGasEstimate {
  gasUnits: bigint;
  maxFeePerGas: bigint;
  gasCostWei: bigint;
  nativeSymbol: string;
  /** Source of the largest per-op contribution; absent on estimates from older persisted plans. */
  source?: GasEstimateSource;
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

  // Replacement-tx hints captured when the prior attempt failed with
  // TX_NOT_BROADCAST or TIMEOUT. On retry, the executor reuses this nonce so
  // the new tx supersedes the pending one and bids `max(× 2, currentFast × 2)`.
  retryHints?: {
    nonce: number;
    maxFeePerGas: bigint;
    maxPriorityFeePerGas?: bigint;
  };

  // Gas top-up specific (only for gas-topup and gas-topup-wait steps)
  gasTopUpDestinations?: { chainId: number; address: Address; amountWei: string }[];

  // Shield specific (only for shield steps): the recipient 0zk address
  railgunAddress?: string;

  // Present when the step's calls execute through a smart-account path — a
  // Gnosis Safe transaction (proposed/signed/executed via the connected owner
  // EOA) or an ERC-4337 smart wallet's EIP-5792 bundle — instead of plain EOA
  // transactions. Claim steps for Safe recipients are deliberately NOT
  // tagged — they're permissionless and run from the owner EOA directly.
  execution?: StepExecution;
}

export type StepExecution = SafeStepExecution | SmartStepExecution;

/** Plan-time marker routing a step through the Safe submission path. */
export interface SafeStepExecution {
  via: "safe";
  safeAddress: Address;
  /** Connected owner EOA that signs, proposes, executes, and pays gas. */
  ownerAddress: Address;
  /** Signatures required; 1 ⇒ sign-and-execute immediately, no proposal wait. */
  threshold: number;
  safeVersion: string;
  /**
   * Steps sharing a batchId execute as ONE Safe MultiSend transaction (same
   * chain + Safe, no provenance dependency between members). They succeed,
   * fail, and retry together.
   */
  batchId: string;
}

/**
 * Plan-time marker routing a step through the EIP-5792 smart-account path:
 * the connected ERC-4337 wallet signs synchronously and submits its own
 * UserOperation; the app sends `wallet_sendCalls` bundles.
 */
export interface SmartStepExecution {
  via: "smart";
  smartAddress: Address;
  /** Plan-time snapshot: the chain reported atomic batching (supported/ready). */
  atomic: boolean;
  /**
   * Steps sharing a batchId go out as ONE wallet_sendCalls bundle. Multi-step
   * groups only form when `atomic` is true — sequential bundles can't give
   * the all-or-nothing semantics batch groups assume.
   */
  batchId: string;
}

/**
 * One wallet_sendCalls submission (per batch group; the sequential mode
 * overwrites it per sub-bundle). The bundle id is WALLET-SCOPED — only the
 * same wallet session can resolve it via wallet_getCallsStatus — so the
 * transactionHash is persisted the moment receipts appear as the
 * chain-verifiable fallback anchor for resume/reconcile.
 */
export interface SendCallsBundleRecord {
  id: string;
  chainId: number;
  account: Address;
  /** Step ids of the batch group this bundle executes. */
  stepIds: string[];
  /** Sub-call index in sequential (non-atomic) mode; absent for atomic bundles. */
  callIndex?: number;
  atomic: boolean;
  sentAt: number;
  status: "sent" | "confirmed" | "failed";
  transactionHash?: Hex;
}

/**
 * Persisted record of one Safe proposal (one per batch group), enough to
 * resume after a tab close: reconcile against the Transaction Service, keep
 * awaiting confirmations, or execute with the stored payload and signatures.
 */
export interface SafeProposalRecord {
  chainId: number;
  safeAddress: Address;
  /** Step ids of the batch group this proposal executes. */
  stepIds: string[];
  safeTxHash: Hex;
  safeNonce: number;
  /** Full SafeTx payload (bigints as strings for persistence). */
  tx: { to: Address; value: string; data: Hex; operation: 0 | 1 };
  threshold: number;
  /** Collected owner signatures (ours at minimum; merged from the service while polling). */
  confirmations: { owner: Address; signature: Hex }[];
  /** Owner EOA that executes (and pays gas for) execTransaction. */
  executor: Address;
  proposedAt: number;
  /** When the underlying swap calldata was quoted (staleness gate before exec). */
  quotedAt?: number;
  status: "proposed" | "executing" | "executed" | "superseded";
  executedTxHash?: Hex;
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

  // Patch the caller merges into ConsolidationState.metadata. Lets executeStep
  // describe state changes instead of mutating its parameter.
  metadataPatch?: Partial<NonNullable<ConsolidationState["metadata"]>>;
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

  // Account kinds snapshotted at plan time (Safe deployments per chain), so a
  // resumed execution doesn't depend on live discovery. Absent => all-EOA.
  accounts?: AccountsRecord;

  // Execution metadata (intermediate data between steps)
  metadata?: {
    attestations?: Attestation[];
    gasRefuels?: GasRefuelRecord[];
    omnibridge?: {
      claims?: OmnibridgeClaim[];
      deliveries?: OmnibridgeDelivery[];
    };
    safe?: {
      /** Safe proposal per batch group, keyed by the group's batchId. */
      proposals?: Record<string, SafeProposalRecord>;
    };
    smart?: {
      /** EIP-5792 bundle per batch group, keyed by the group's batchId. */
      bundles?: Record<string, SendCallsBundleRecord>;
    };
  };

  createdAt: number; // Timestamp
  updatedAt: number; // Timestamp
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
  TX_NOT_BROADCAST: "TX_NOT_BROADCAST",
  ATTESTATION_TIMEOUT: "ATTESTATION_TIMEOUT",
  OMNIBRIDGE_TIMEOUT: "OMNIBRIDGE_TIMEOUT",
  GAS_TOPUP_TIMEOUT: "GAS_TOPUP_TIMEOUT",
  SAFE_NOT_DEPLOYED: "SAFE_NOT_DEPLOYED",
  SMART_ACCOUNT_NOT_DEPLOYED: "SMART_ACCOUNT_NOT_DEPLOYED",
  BUNDLE_NOT_CONFIRMED: "BUNDLE_NOT_CONFIRMED",
  SAFE_CONFIRMATION_TIMEOUT: "SAFE_CONFIRMATION_TIMEOUT",
  SAFE_TX_SUPERSEDED: "SAFE_TX_SUPERSEDED",
  SAFE_NOT_OWNER: "SAFE_NOT_OWNER",
  SAFE_SERVICE_ERROR: "SAFE_SERVICE_ERROR",
  PLANNING_ERROR: "PLANNING_ERROR",
  UNSUPPORTED_ROUTE: "UNSUPPORTED_ROUTE",
  EXTERNAL_API_ERROR: "EXTERNAL_API_ERROR",
  EXECUTION_ERROR: "EXECUTION_ERROR",
  UNEXPECTED_ERROR: "UNEXPECTED_ERROR",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
