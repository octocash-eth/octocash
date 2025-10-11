# Research: Dynamic Transaction Plan UI

**Feature**: 001-the-consolidation-step  
**Date**: 2025-09-29

## Overview
This document consolidates research findings for implementing a dynamic transaction planning and visualization system for crypto consolidation.

## Key Research Areas

### 1. Dynamic Transaction Planning

**Decision**: Implement planning function in `app/lib/consolidation.ts` that generates transaction steps based on input tokens rather than fixed steps.

**Rationale**:
- Current fixed flow (swap→bridge→wait→claim→swap back) doesn't handle all scenarios efficiently
- Different token combinations require different steps (e.g., tokens already on destination chain skip bridging)
- Dynamic planning allows optimization and clearer user communication

**Alternatives Considered**:
- Keep fixed steps, skip unnecessary ones → Rejected: Less clear, harder to maintain, doesn't handle complex dependency chains
- Separate planning service → Rejected: Adds unnecessary complexity for synchronous operation

**Implementation Approach**:
- Create `planConsolidation()` function that analyzes source/destination tokens
- Return array of transaction steps with dependencies tracked
- Each step includes: type, estimated amounts, dependencies, chain info

### 2. Transaction Dependency Tracking

**Decision**: Implement dependency graph where each transaction knows which previous transaction's output it consumes, with support for partial dependencies.

**Rationale**:
- Enables intelligent skipping when failures occur (FR-017)
- Allows independent transactions to continue while dependent ones skip
- Critical for user safety (FR-013) - clear consequence communication
- **Partial dependencies** allow attestation/claim steps to adapt rather than skip entirely

**Alternatives Considered**:
- Sequential-only execution → Rejected: Wastes time, doesn't handle partial failures well
- Manual user selection of which to skip → Rejected: Too complex for users
- All-or-nothing dependencies → Rejected: Too rigid, would skip attestation even if some bridges succeeded

**Implementation Approach**:
- Each transaction step has `dependsOn` field referencing previous step IDs
- New `partialDependency` boolean flag:
  - `false` (default): Step requires ALL dependencies to succeed, skip if ANY fails
  - `true` (attestation/claim only): Step can execute with subset of dependencies
- On failure + continue:
  - Regular steps: Skip if any dependency failed
  - Partial dependency steps: Adapt to execute with only successful dependencies
  - Track `adaptedFrom` to show user what was originally planned vs. what executed

**Example**: 
- Bridge from Network 1 succeeds, Bridge from Network 2 fails
- Attestation step adapts: waits only for Network 1 attestation (not skipped)
- Claim step adapts: claims only USDC from Network 1 (not skipped)

### 3. State Persistence Strategy

**Decision**: Use browser localStorage with structured consolidation state object.

**Rationale**:
- FR-019-021 require full recovery after browser close
- localStorage provides synchronous access needed for UI responsiveness
- Sufficient for storing plan state, transaction results, and current progress

**Alternatives Considered**:
- IndexedDB → Rejected: Async complexity not needed for small state object
- Session storage → Rejected: Doesn't persist across browser close
- Backend storage → Rejected: Adds server dependency, unnecessary for client-side operation

**Data Structure**:
```typescript
interface ConsolidationState {
  id: string;
  plan: TransactionStep[];
  currentStepIndex: number;
  results: Map<stepId, TransactionResult>;
  status: 'pending' | 'executing' | 'paused' | 'completed' | 'failed';
  createdAt: number;
  updatedAt: number;
}
```

### 4. Real-time Amount Recalculation

**Decision**: After each successful transaction, recalculate all pending steps using actual amounts (FR-015).

**Rationale**:
- Slippage and fees cause actual amounts to differ from estimates
- Subsequent transactions must use correct amounts to avoid failures
- Clarification confirmed: ANY difference triggers recalc (not just significant)

**Alternatives Considered**:
- Only recalc on >5% difference → Rejected: Clarification specified always recalc
- Re-plan entire consolidation → Rejected: Too disruptive, loses progress

**Implementation Approach**:
- After transaction success: update step result with actual amounts
- Walk forward through plan, update estimated amounts for dependent steps
- Use Odos quote API to get fresh estimates with new amounts
- Persist updated plan to localStorage

### 5. Visual State Management

**Decision**: Use React state + localStorage for transaction card states with 5 states: pending, executing, success, failed, skipped.

**Rationale**:
- FR-005-009 require clear visual feedback
- Cards need to update in real-time as transactions progress
- Skipped state needed for dependency failures (clarification)

**UI Components**:
- `TransactionCard` - Individual card with border color based on state
- `TransactionPlanView` - List of cards with progress indicator
- `TransactionActions` - Retry/Continue buttons (FR-010-011)

**State Mapping**:
- Pending: Default border, estimated amounts shown
- Executing: Pulsing/animated border, loading indicator
- Success: Green border (#10b981), actual amounts shown
- Failed: Red border (#ef4444), error message + retry/continue buttons
- Skipped: Gray border, dependency failure explanation


### 6. Bundled Transaction Handling

**Decision**: Detect bundle opportunities in planning phase, display as single card (FR-003-004).

**Rationale**:
- Multiple operations in one transaction save gas and time
- Current Odos integration may already bundle (research needed)
- Single card simplifies UI, shows efficiency

**Implementation Approach**:
- Planning function identifies bundle opportunities
- Bundle represented as single step with multiple operations listed
- Card shows all operations but single transaction hash on completion

### 7. Retry Mechanism Constraints

**Decision**: Disable retry once any subsequent transaction executes (FR-012 clarification).

**Rationale**:
- Retrying after state changes could cause inconsistency
- Amounts may have changed, making retry with old parameters incorrect
- Clear user expectation: retry immediately or accept failure and continue

**Implementation**:
- Track `hasSubsequentExecution` flag when user clicks continue
- If subsequent step executes, set flag to true
- Disable retry button, show "Cannot retry after continuing" message

## Technical Stack Confirmation

All technologies align with constitutional constraints:
- **TypeScript 5.8+ strict mode** - Type safety principle (V)
- **React Router 7** - Existing stack
- **Viem + Wagmi** - Existing blockchain integration
- **Radix UI + Tailwind** - Professional UI principle (I)
- **Vitest + jsdom** - Testing requirement (V)
- **localStorage** - Browser-native, no new dependencies

## Performance Considerations

- **1-minute attestation timeout** (FR-022 clarification) - Shorter than typical CCTP times, will require polling optimization
- **Page load <3s** - Consolidation UI should lazy load, not block main app
- **Responsive during blockchain ops** - Use optimistic UI updates, show loading states

## Risk Mitigation

1. **Browser Storage Limits** - localStorage has 5-10MB limit. Consolidation state is <100KB, well within limits.
2. **Complex Dependency Chains** - Limit consolidation to reasonable token count (existing app likely has limits)

## Next Steps

Phase 1 will define:
- Data models for TransactionStep, ConsolidationState, TransactionResult
- API contracts for planning function
- Integration test scenarios
- Quickstart validation steps
