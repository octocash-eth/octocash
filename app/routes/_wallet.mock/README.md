# Mock Transaction Plans Page

This page (`/mock`) showcases different transaction plan scenarios extracted from the test suite.

## Purpose

Provides a visual playground to view and understand how the `TransactionPlanView` component renders different consolidation scenarios without needing to execute actual blockchain transactions.

## Scenarios

### 1. Happy Path - Multi-Chain Consolidation
**Source:** `test/e2e/consolidation-happy-path.test.ts`

Complete successful consolidation flow:
- 0.2 ETH on Polygon + 1 USDC on Optimism
- Destination: WBTC on Ethereum
- All 6 steps succeed (swap, bridge, bridge, attestation, claim, swap)
- Status: **completed**

### 2. Partial Dependency Adaptation
**Source:** `test/e2e/consolidation-skip.test.ts`

Demonstrates partial dependency handling:
- Two swaps on different chains, one fails
- Bridge dependent on failed swap gets skipped
- Attestation/claim steps adapt to continue with successful bridge only
- Final amount is reduced but consolidation completes
- Status: **partial**

### 3. Paused State - Attestation Timeout
**Source:** `test/e2e/consolidation-recovery.test.ts`

Shows recovery UI for failed steps:
- Bridge succeeds
- Attestation times out
- Execution pauses
- User can retry or continue
- Status: **paused**

### 4. Simple Same-Chain Swap
**Source:** `app/lib/planning.test.ts`

Minimal scenario:
- Single swap: USDC → WBTC on Ethereum
- No cross-chain steps needed
- Status: **completed**

### 5. Executing State
**Source:** `app/lib/execution.test.ts`

Active execution in progress:
- One step completed
- One step currently executing (blue pulse animation)
- Remaining steps pending
- Status: **executing**

## Features

- **Scenario Selector**: Dropdown to switch between different use cases
- **Live Transaction Cards**: Full `TransactionPlanView` component with all states
- **Scenario Details**: Breakdown of steps, status, and test source reference
- **Visual State Indicators**: Color-coded step types and statuses

## Usage

1. Start the dev server: `bun run dev`
2. Navigate to `http://localhost:3000/mock`
3. Select different scenarios from the dropdown
4. Observe how the transaction cards render for each state

## Implementation Notes

- States are static (not executing real transactions)
- All mock data matches test case structures
- Demonstrates partial dependency adaptation (attestation/claim steps)
- Shows different error states and recovery options
