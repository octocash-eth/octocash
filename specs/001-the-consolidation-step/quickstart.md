# Quickstart: Dynamic Transaction Plan UI

**Feature**: 001-the-consolidation-step  
**Purpose**: Validate implementation through manual and automated test scenarios

## Prerequisites

- Development environment running (`bun run dev`)
- Wallet extension installed (MetaMask, Rainbow, etc.)
- Test wallets with tokens on multiple chains:
  - Optimism: 1 USDC
  - Polygon: 0.2 ETH
  - Ethereum: gas for transactions
- RPC endpoints configured for test chains

## Test Scenarios

### Scenario 1: Happy Path - Multi-Chain Consolidation

**Given**: User has 1 USDC (Optimism) + 0.2 ETH (Polygon)  
**Destination**: WBTC on Ethereum

**Steps**:
1. Connect wallet
2. Navigate to consolidation page
3. Select source tokens:
   - ✓ 1 USDC (Optimism, wallet 0x123...)
   - ✓ 0.2 ETH (Polygon, wallet 0x123...)
4. Select destination:
   - Token: WBTC
   - Chain: Ethereum
   - Wallet: 0x123...
5. Click "Generate Plan"
6. **Verify Plan Display**:
   - ✓ 6 transaction cards shown
   - ✓ Card 1: Swap 0.2 ETH → ~800 USDC (Polygon) - Pending
   - ✓ Card 2: Bridge 1 USDC (Optimism → Ethereum) - Pending
   - ✓ Card 3: Bridge ~800 USDC (Polygon → Ethereum) - Pending (depends on Card 1)
   - ✓ Card 4: Wait for attestations - Pending (depends on Cards 2,3)
   - ✓ Card 5: Claim ~801 USDC (Ethereum) - Pending (depends on Card 4)
   - ✓ Card 6: Swap ~801 USDC → ~0.008 WBTC - Pending (depends on Card 5)
   - ✓ All amounts show estimated values
   - ✓ Gas costs shown in native token + USD
7. Click "Execute Plan"
8. **Verify Execution**:
   - ✓ Card 1 shows executing state (blue pulse)
   - ✓ Wallet prompts for approval
   - ✓ After approval, card turns green
   - ✓ Actual amount displayed: "0.2 ETH → 798.45 USDC"
   - ✓ Cards 2 & 3 begin executing
   - ✓ Both complete successfully (green borders)
   - ✓ Card 4 (attestation) shows "Waiting..." with countdown
   - ✓ After <60 seconds, Card 4 completes
   - ✓ Card 5 executes and completes
   - ✓ Card 6 shows final swap, completes
   - ✓ Final amount: ~0.008 WBTC in destination wallet
9. **Verify State Persistence** (if browser closed mid-execution):
   - Close browser tab during execution
   - Reopen application → Navigate to History page
   - ✓ Incomplete consolidation visible in history
   - Click "Resume"
   - ✓ All completed steps show green
   - ✓ Execution resumes from last incomplete step

**Expected Outcome**: All cards green, WBTC successfully consolidated

---

### Scenario 2: Transaction Failure with Retry

**Given**: User has tokens to consolidate  
**Simulate**: Network error on step 3

**Steps**:
1. Follow Scenario 1 steps 1-7
2. Card 1 & 2 complete successfully
3. **Simulate failure** on Card 3:
   - Network disconnects / user rejects transaction
4. **Verify Failure State**:
   - ✓ Card 3 shows red border
   - ✓ Error message: "Transaction failed: User rejected"
   - ✓ Retry button enabled
   - ✓ Continue button shown
5. Click "Retry"
6. **Verify Retry**:
   - ✓ Card 3 returns to executing state
   - ✓ Wallet prompts again
   - ✓ After approval, card turns green
   - ✓ Execution continues automatically
   - ✓ Cards 4,5,6 execute normally
7. **Verify Final State**:
   - ✓ All cards green
   - ✓ Consolidation successful

**Expected Outcome**: Retry successful, all steps complete

---

### Scenario 3: Continue Past Failure with Partial Dependency Adaptation

**Given**: User has 1 USDT (Optimism) + 1 DAI (Polygon) → USDC (Ethereum)

**Plan**:
- Step 1: Swap 1 USDT → ~1 USDC (Optimism) [independent]
- Step 2: Swap 1 DAI → ~1 USDC (Polygon) [independent]
- Step 3: Bridge 1 USDC from Optimism [depends on Step 1]
- Step 4: Bridge 1 USDC from Polygon [depends on Step 2]
- Step 5: Wait for attestations [depends on Steps 3,4] **partialDependency=true**
- Step 6: Claim USDC (Ethereum) [depends on Step 5] **partialDependency=true**

**Steps**:
1. Generate plan (verify 6 steps shown)
2. Execute plan
3. Step 1 completes successfully (green)
4. **Step 2 fails** (simulate: slippage exceeded)
5. **Verify Failure State**:
   - ✓ Step 2: red border, error message
   - ✓ Retry and Continue buttons shown
6. Click "Continue"
7. **Verify Dialog**:
   - ✓ Warning: "This will skip step 4 which depends on this transaction"
   - Confirm
8. **Verify Skipping and Adaptation Logic**:
   - ✓ Step 2: remains failed (red)
   - ✓ Step 3: executes successfully (independent)
   - ✓ Step 4: automatically skipped (gray border)
   - ✓ Step 4 message: "Skipped: Depends on failed step 2"
   - ✓ **Step 5 ADAPTS** (not skipped!):
     - Shows "adapted" badge
     - Message: "Originally: 2 bridges, Now waiting: 1 bridge (Optimism)"
     - Waits only for Step 3 attestation
     - Executes successfully (green)
   - ✓ **Step 6 ADAPTS**:
     - Recalculates to claim only 1 USDC (from Step 3)
     - Shows adapted amount
     - Executes successfully (green)
9. **Verify Final State**:
   - ✓ Steps 1,3,5,6: green (success, steps 5 & 6 adapted)
   - ✓ Step 2: red (failed)
   - ✓ Step 4: gray (skipped)
   - ✓ Status: "Partial completion - some steps were skipped"
   - ✓ Only 1 USDC consolidated (from Step 1 path)
   - ✓ Step 5 shows it adapted from 2 bridges to 1
   - ✓ Step 6 shows it claimed 1 USDC instead of 2

**Expected Outcome**: Partial success with attestation/claim steps adapting to available bridges, not skipping entirely

---

### Scenario 4: Retry Disabled After Continue

**Given**: Continuation of Scenario 3, Step 8

**Steps**:
1. After clicking "Continue" on Step 2
2. Attempt to click "Retry" on Step 2
3. **Verify**:
   - ✓ Retry button disabled (grayed out)
   - ✓ Tooltip: "Cannot retry after continuing to next transaction"
   - ✓ Continue button hidden (already continued)

**Expected Outcome**: Retry correctly prevented after continuation

---

### Scenario 5: Amount Recalculation

**Given**: User consolidating tokens

**Steps**:
1. Generate plan with estimated amounts
2. Execute first swap
3. **Verify actual amount differs from estimate**:
   - Estimated: 800 USDC
   - Actual: 798.45 USDC
4. **Verify recalculation**:
   - ✓ Card 1 shows: "~800 USDC (estimated)" crossed out
   - ✓ Card 1 shows: "798.45 USDC" actual
   - ✓ Card 3 (bridge) updates: input now 798.45 USDC (was 800)
   - ✓ Card 6 (final swap) updates: input now ~799.45 USDC total (was ~801)
   - ✓ All dependent cards show updated estimates
5. Continue execution
6. **Verify**:
   - ✓ All steps use recalculated amounts
   - ✓ No failures due to insufficient amounts
   - ✓ Final output matches actual inputs

**Expected Outcome**: Plan dynamically adjusts to actual amounts

---

### Scenario 6: Attestation Timeout

**Given**: Bridge transaction initiated

**Steps**:
1. Execute plan through bridge step
2. **Simulate slow attestation** (>60 seconds)
3. After 60 seconds:
   - ✓ Attestation step shows red border
   - ✓ Error: "Attestation not received within 1 minute"
   - ✓ Retry button enabled
4. Click "Retry"
5. **Verify**:
   - ✓ Re-checks for attestation
   - ✓ If now available: succeeds and continues
   - ✓ If still unavailable: fails again after 60s

**Expected Outcome**: Timeout handled gracefully, retry works

---

### Scenario 7: Bundled Transactions

**Given**: Multiple swaps on same chain can be bundled

**Steps**:
1. Select 3 tokens on Ethereum → USDC (Ethereum)
2. Generate plan
3. **Verify Bundling**:
   - ✓ Single card shows "Bundled Transaction" badge
   - ✓ Lists: "Swap ETH → USDC, Swap DAI → USDC, Swap USDT → USDC"
   - ✓ Single gas estimate shown
4. Execute plan
5. **Verify Execution**:
   - ✓ Single wallet prompt for all 3 swaps
   - ✓ All operations in one transaction
   - ✓ Single transaction hash shown
   - ✓ All operations show actual amounts

**Expected Outcome**: Efficient bundling, single transaction

---

### Scenario 8: Browser Recovery

**Given**: Consolidation in progress

**Steps**:
1. Start consolidation
2. Complete 2 of 6 steps
3. **Close browser** (hard close, no cleanup)
4. Reopen application
5. Navigate to **History page**
6. **Verify Recovery from History**:
   - ✓ Incomplete consolidation shown in history list
   - ✓ Status badge: "In Progress" or "Paused"
   - ✓ Shows completed steps (2/6)
   - ✓ Button: "Resume"
7. Click "Resume" on the incomplete consolidation
8. **Verify State Restored**:
   - ✓ Redirected to consolidation page
   - ✓ Steps 1-2: green (completed)
   - ✓ Step 3: pending
   - ✓ Actual amounts from Steps 1-2 preserved
   - ✓ Recalculated amounts for Steps 3-6
9. Execution automatically resumes (or click "Execute")
10. **Verify**:
   - ✓ Execution resumes from Step 3
   - ✓ No re-execution of completed steps
   - ✓ Continues to completion

**Expected Outcome**: Full recovery via History page, seamless resume

---

## Automated Test Checklist

### Integration Tests (`app/lib/consolidation.test.ts`)
- [ ] Plan generation for various token combinations
- [ ] Dependency tracking and skipping logic
- [ ] Amount recalculation after each step
- [ ] State persistence to localStorage
- [ ] Recovery from saved state

### Component Tests (`app/components/transaction-card.test.tsx`)
- [ ] Renders all 5 states correctly
- [ ] Retry button enabled/disabled based on `canRetry`
- [ ] Continue button shows confirmation dialog
- [ ] Amount display (estimated vs actual)
- [ ] Bundled transaction display

### E2E Tests (`app/e2e/consolidation.test.ts`)
- [ ] Full happy path (Scenario 1)
- [ ] Failure and retry (Scenario 2)
- [ ] Continue with dependency skip (Scenario 3)
- [ ] Browser recovery (Scenario 8)

## Performance Validation

- [ ] Plan generation: <2 seconds for 10 tokens
- [ ] UI updates: <16ms per state change (60fps)
- [ ] localStorage writes: non-blocking
- [ ] Attestation polling: efficient (not excessive requests)

## Accessibility Validation

- [ ] Keyboard navigation works for all buttons
- [ ] Screen reader announces status changes
- [ ] Color contrast meets WCAG AA
- [ ] Focus indicators visible

## Success Criteria

✅ All manual test scenarios pass  
✅ All automated tests pass  
✅ No console errors during execution  
✅ Performance targets met  
✅ Accessibility requirements met  
✅ Constitutional compliance verified (professional UI, user safety)
