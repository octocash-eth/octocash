# Contract: Transaction Execution Function

## Function Signature

```typescript
function executeConsolidationPlan(
  state: ConsolidationState,
  onProgress: (step: TransactionStep, status: StepStatus) => void
): Promise<ConsolidationState>
```

## Purpose
Executes a transaction plan, handling failures, retries, dependency skipping, and real-time progress updates.

## Input

### state: ConsolidationState
- **Required**: Yes
- **Constraints**:
  - Must have valid `plan` array
  - `status` must be 'ready' or 'paused'
  - If 'paused', must have failed step to retry or continue from
- **Mutations**: Function updates state in place AND returns updated state

### onProgress: Callback Function
- **Required**: Yes
- **Signature**: `(step: TransactionStep, status: StepStatus) => void`
- **Called**: Every time a step changes status
- **Purpose**: Update UI in real-time

## Output

### Returns: Promise<ConsolidationState>
- **Type**: Updated ConsolidationState
- **Status Values**:
  - `'executing'`: In progress
  - `'paused'`: Stopped on failure (waiting for user action)
  - `'completed'`: All steps successful
  - `'partial'`: Completed with some skipped steps

## Behavior

### Normal Execution Flow
1. Set `status = 'executing'`
2. For each step in `plan` order:
   - Check if step should be skipped (using `shouldSkipStep()`)
     - If yes: mark step 'skipped', record reason, continue to next
   - **Adapt step if partial dependency** (using `adaptStepForPartialDependencies()`)
     - If step has `partialDependency=true` and some deps failed:
       - Filter to only successful dependencies
       - Store original deps in `adaptedFrom` for display
   - Execute step based on type:
     - `swap`: Call Odos, get actual output amount
     - `bridge`: Call CCTP burn, get transaction hash
     - `attestation`: Poll for attestations (only from successful bridge steps), max 60 seconds
     - `claim`: Call CCTP mint with available attestations (from successful bridges only)
     - `transfer`: Simple token transfer
   - On success:
     - Update step status to 'success'
     - Store actual amounts in results
     - Recalculate remaining steps with actual amounts
     - Call `onProgress(step, 'success')`
     - Persist state to localStorage
   - On failure:
     - Update step status to 'failed'
     - Store error in step.error
     - Set `status = 'paused'`
     - Call `onProgress(step, 'failed')`
     - Persist state and RETURN (wait for user action)
3. If all steps complete: set `status = 'completed'`
4. If some skipped: set `status = 'partial'`
5. Return updated state

### Recalculation After Success
After each successful step:
1. Extract actual output amount
2. Find all dependent steps
3. For each dependent step:
   - Update input amounts to use actual (not estimated)
   - Call planning helper to re-quote swap/bridge amounts
   - Update estimated output amounts
4. Persist updated plan

### Retry Behavior
When resuming from 'paused' status:
1. Find failed step at `currentStepIndex`
2. Check `state.hasSubsequentExecution`:
   - If true: Cannot retry, must continue
   - If false: Retry allowed
3. Reset step status to 'executing'
4. Re-execute step with same parameters
5. On success: resume normal flow
6. On failure: return to 'paused'

### Continue Behavior
When user chooses continue (called separately):
1. Set `state.hasSubsequentExecution = true`
2. Mark failed step as final state 'failed'
3. Walk dependency graph:
   - For each step after failed step:
     - If depends on failed step: mark 'skipped'
     - Record skip reason: "Depends on failed step {id}"
4. Find next independent step
5. Resume execution from that step

### Dependency Skipping Logic
```typescript
function shouldSkipStep(step: TransactionStep, results: Record<string, StepResult>): boolean {
  // Partial dependency steps can execute with subset of dependencies
  if (step.partialDependency) {
    // Check if at least one dependency succeeded
    const hasAnySuccess = step.dependsOn.some(depId => {
      const depResult = results[depId];
      return depResult?.status === 'success';
    });
    return !hasAnySuccess; // Skip only if ALL dependencies failed/skipped
  }
  
  // Regular steps require ALL dependencies to succeed
  for (const depId of step.dependsOn) {
    const depResult = results[depId];
    if (depResult?.status === 'failed' || depResult?.status === 'skipped') {
      return true; // Skip if ANY dependency failed or was skipped
    }
  }
  return false;
}

function adaptStepForPartialDependencies(
  step: TransactionStep, 
  results: Record<string, StepResult>
): TransactionStep {
  if (!step.partialDependency) {
    return step; // No adaptation needed
  }
  
  // Filter dependencies to only successful ones
  const successfulDeps = step.dependsOn.filter(depId => {
    const depResult = results[depId];
    return depResult?.status === 'success';
  });
  
  return {
    ...step,
    dependsOn: successfulDeps,
    adaptedFrom: step.dependsOn, // Keep original for display
  };
}
```

## Error Cases

### Execution Errors
- **Throws**: `ExecutionError`
- **When**:
  - Wallet not connected
  - User rejected transaction
  - Insufficient gas
  - Slippage exceeded
  - RPC error

**Behavior**: Store error in step, set status='paused', return state (don't throw)

### Timeout Errors
- **Attestation timeout** (>60 seconds):
  - Store TimeoutError in step
  - Set status='failed'
  - Set state status='paused'
  - Allow retry (will check attestation again)

### Unexpected Errors
- **Throws**: `UnexpectedError`
- **When**: Unhandled exception, corrupted state
- **Behavior**: Log to console, attempt to preserve state, surface to user

## Dependencies

### Execution Functions
The execution engine uses the following functions from `odos.ts` and `cctp.ts`:
- `executeSwapOrTransfer` - Executes swaps via Odos or transfers
- `executeCCTPBurn` - Executes CCTP burn step
- `executeCCTPMint` - Executes CCTP mint step
- `retrieveAttestations` - Retrieves CCTP attestations

### State Persistence
```typescript
// In app/lib/storage.ts
function saveConsolidationState(state: ConsolidationState): void
function loadConsolidationState(id: string): ConsolidationState | null
```

## Progress Callback Examples

### UI Integration
```typescript
const onProgress = (step: TransactionStep, status: StepStatus) => {
  // Update React state to re-render card
  setTransactionSteps(prev => 
    prev.map(s => s.id === step.id ? { ...s, status } : s)
  );
  
  // Show toast notification
  if (status === 'success') {
    toast.success(`${step.type} completed`);
  } else if (status === 'failed') {
    toast.error(`${step.type} failed: ${step.error?.message}`);
  }
};
```

## Performance

### Execution Time
- **Per step**: 5-30 seconds (blockchain dependent)
- **Typical plan**: 30 seconds - 5 minutes
- **Attestation**: 30-60 seconds (slowest step)

### Optimization
- Execute independent steps in parallel where safe
- Batch RPC calls when possible
- Cache gas estimates to avoid repeated calls

## Testing

### Contract Test Cases
1. **All steps succeed**: Should return status='completed' with all results
2. **Middle step fails**: Should pause at failed step, preserve state
3. **Retry successful**: Should resume execution from retry point
4. **Continue after failure**: Should skip dependent steps, execute independent ones
5. **Attestation timeout**: Should fail step, allow retry
6. **User rejects transaction**: Should fail gracefully, allow retry
7. **Dependency chain skip**: If step 2 fails and steps 4,6 depend on it, they should skip; step 5 (independent) executes
8. **Recalculation**: After step with different actual amount, verify subsequent steps updated

### Edge Cases
- All steps independent (parallel execution possible)
- Long dependency chain (A→B→C→D→E)
- Multiple failures (different independent branches)
- Browser close mid-execution (test recovery)

## State Persistence Strategy

### Save Points
- Before each step execution
- After each step completion
- On failure
- On status change

### Recovery
- Incomplete consolidations (status='executing' or 'paused') persist in localStorage
- User navigates to History page to view all consolidations
- Incomplete consolidations display with "Resume" button
- On resume: validate wallet still connected to correct account/chain
- Resume execution from `currentStepIndex`
