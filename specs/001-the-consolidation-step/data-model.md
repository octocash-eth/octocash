# Data Model: Dynamic Transaction Plan UI

**Feature**: 001-the-consolidation-step  
**Date**: 2025-09-29

## Overview
This document defines the data structures for dynamic transaction planning, state management, and UI representation.

## Core Entities

### TransactionStep

Represents a single operation in the consolidation plan.

```typescript
interface TransactionStep {
  id: string;                    // Unique identifier for this step
  type: TransactionType;         // Type of operation
  status: StepStatus;            // Current execution status
  chainId: number;               // Chain where this transaction executes
  
  // Input/Output
  inputTokens: TokenAmount[];    // Tokens consumed by this step
  outputToken: TokenAmount;      // Token produced (estimated pre-exec, actual post-exec)
  
  // Execution details
  transactionHash?: string;      // Blockchain tx hash (after execution)
  error?: TransactionError;      // Error details if failed
  executedAt?: number;           // Timestamp of execution
}
```

### TransactionType

```typescript
type TransactionType = 
  | 'swap'           // Token swap using Odos
  | 'bridge'         // USDC bridge using CCTP
  | 'attestation'    // Wait for bridge attestation(s)
  | 'claim'          // Claim bridged tokens
  | 'transfer';      // Simple transfer (same token, same chain)
```

### StepStatus

```typescript
type StepStatus = 
  | 'pending'        // Not yet started
  | 'executing'      // Currently executing
  | 'success'        // Completed successfully
  | 'failed'         // Failed with error
  | 'skipped';       // Skipped due to dependency failure
```

### TokenAmount

```typescript
interface TokenAmount {
  token: Address;              // Token contract address
  amount: bigint;              // Amount in smallest unit (wei, etc.)
  chainId: number;             // Chain ID
  walletAddress: Address;      // Wallet holding the token
  symbol?: string;             // Token symbol (ETH, USDC, etc.)
  decimals?: number;           // Token decimals
}
```

### ConsolidationState

Main state object persisted to localStorage.

```typescript
interface ConsolidationState {
  id: string;                    // Unique consolidation session ID
  plan: TransactionStep[];       // Array of transaction steps
  currentStepIndex: number;      // Index of currently executing step
  
  // Overall status
  status: ConsolidationStatus;
  
  // Results
  results: Record<string, StepResult>;  // stepId -> result mapping
  
  // Metadata
  sourceTokens: TokenAmount[];   // Original input tokens
  destinationToken: {            // Target token/wallet
    token: Address;
    chainId: number;
    walletAddress: Address;
  };
  
  createdAt: number;             // Timestamp
  updatedAt: number;             // Timestamp
  
  // Retry tracking
  hasSubsequentExecution: boolean;  // True if user continued past failure
}
```

### ConsolidationStatus

```typescript
type ConsolidationStatus = 
  | 'planning'       // Generating transaction plan
  | 'ready'          // Plan ready, waiting for user confirmation
  | 'executing'      // Executing transactions
  | 'paused'         // Paused on failure (waiting for retry/continue)
  | 'completed'      // All transactions successful
  | 'partial';       // Completed with some skipped transactions
```

### StepResult

```typescript
interface StepResult {
  stepId: string;
  status: 'success' | 'failed' | 'skipped';
  
  // Success data
  actualOutput?: TokenAmount;    // Actual token amount received
  transactionHash?: string;
  
  // Failure data
  error?: TransactionError;
  skipReason?: string;           // Reason for skipping (e.g., "Depends on failed step X")
}
```

### TransactionError

```typescript
interface TransactionError {
  code: string;                  // Error code
  message: string;               // User-friendly message
  details?: unknown;             // Technical details for debugging
  recoverable: boolean;          // Can user retry?
  timestamp: number;
}
```

## Validation Rules

### TransactionStep
- `id` must be unique within a plan
- `inputTokens` with `provenance` must reference valid step IDs earlier in the plan
- `chainId` must be in supported chains (Ethereum, Arbitrum, Optimism, Base, Polygon, Unichain, Avalanche, Linea)
- `outputToken.amount` starts as estimate, updated to actual after execution

### ConsolidationState
- `plan` array order determines execution sequence
- `currentStepIndex` must be valid index in plan or -1 (not started)
- `results` keys must match step IDs in plan
- `sourceTokens` must have at least one token
- `destinationToken.chainId` must be supported

### StepStatus Transitions
Valid state transitions:
- `pending` → `executing` → `success` | `failed`
- `pending` → `skipped` (if all input token provenance steps fail/skip)
- `failed` → `executing` (retry, only if no subsequent execution)
- Steps skip only when ALL input tokens come from failed/skipped steps
- Steps continue if at least ONE input token has successful provenance

## State Transitions

### Plan Generation
1. User selects source tokens and destination
2. System creates ConsolidationState with status='planning'
3. Planning function generates TransactionStep[]
4. Status changes to 'ready'

### Execution Flow
1. Status: 'ready' → 'executing'
2. For each step in plan order:
   - Check dependencies satisfied
   - If dependency failed: mark 'skipped', continue
   - Else: execute step
   - On success: update result with actual amounts, recalculate remaining steps
   - On failure: status='paused', wait for user action (retry/continue)

### Retry Flow
1. User clicks retry on failed step
2. Check `hasSubsequentExecution` is false
3. If true: show error "Cannot retry after continuing"
4. Else: set step status='executing', retry transaction
5. On success: update results, recalculate plan, resume execution
6. On failure: return to paused state

### Continue Flow
1. User clicks continue on failed step
2. Set `hasSubsequentExecution=true`
3. Walk dependency graph: mark all dependent steps as 'skipped'
4. Resume execution with next independent step
5. If no more independent steps: status='partial'

### Recovery Flow (Browser Closed)
1. User navigates to History page
2. History page displays all consolidations including incomplete ones
3. Incomplete consolidations show "Resume" button with progress indicator (e.g., "2/6 steps")
4. User clicks "Resume" on incomplete consolidation
5. System restores ConsolidationState from localStorage
6. Redirects to consolidation page with state loaded
7. Verify wallet still connected to correct account
8. Continue execution from currentStepIndex

## Relationships

```
ConsolidationState 1 ─── N TransactionStep
                          │
                          ├─── N TokenAmount (input)
                          ├─── 1 TokenAmount (output)
                          └─── 0..1 TransactionError

ConsolidationState 1 ─── N StepResult
                          └─── 0..1 TransactionError
```

## Storage Schema

### localStorage Key
```
octocash:consolidation:{stateId}
```

### Storage Size
- TransactionStep: ~500 bytes each
- Typical plan: 5-10 steps = 2.5-5KB
- Results: ~300 bytes per step
- Total per consolidation: ~5-10KB
- localStorage limit: 5-10MB (sufficient for 500-1000 consolidations)

### Cleanup Strategy
- No automatic cleanup - data persists in localStorage
- Users can manually delete consolidations from History page
- Each consolidation record has a delete button/action
- Localhost data persists until explicitly deleted by user


## Index & Performance

### Lookup Patterns
- By step ID: `O(1)` via results Record
- By status: `O(n)` filter (acceptable for <20 steps)
- Current step: `O(1)` via currentStepIndex

### Update Frequency
- During execution: 1 update per transaction (~1-30 seconds apart)
- Recalculation: After each successful step
- localStorage write: After each state change (async, non-blocking)

## Error Handling

### Invalid State Detection
- On load: validate state structure matches interfaces
- If invalid: clear storage, start fresh
- Log corruption to console for debugging

### Concurrency
- localStorage is synchronous, no race conditions within tab
- Multiple tabs: last write wins (acceptable, user likely in one tab)
- Wallet changes: detect account/chain mismatch, pause execution
