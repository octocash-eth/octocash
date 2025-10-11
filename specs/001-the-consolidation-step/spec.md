# Feature Specification: Dynamic Transaction Plan UI

**Feature Branch**: `001-the-consolidation-step`  
**Created**: 2025-09-29  
**Status**: Draft  
**Input**: User description: "the consolidation step should show a list of cards with the transactions that will be performed (sometimes many transactions happen in the same call because they are bundled). As the transactions are confirmed, the card border turns green. If a transaction fails, the border turns red and two buttons appear within the card, retry or continue. Currently we implement a fixed amount of steps (swap, bridge, wait, claim, swap back), but the idea is to implement a planning strategy function within consolidation.ts that given the token it gives back an un-predetermined amout of steps. It may need to implement a set of helpers in odos.ts and cctp.ts."

---

## ⚡ Quick Guidelines
- ✅ Focus on WHAT users need and WHY
- ❌ Avoid HOW to implement (no tech stack, APIs, code structure)
- 👥 Written for business stakeholders, not developers

---

## Clarifications

### Session 2025-09-29
- Q: When a user chooses "continue" after a transaction failure, can they still retry that failed transaction later? → A: Only if no subsequent transactions have executed yet
- Q: Should consolidation progress be persisted and recoverable if the user closes their browser mid-consolidation? → A: Yes - full recovery via History page with ability to resume from last completed step
- Q: What is the timeout threshold for bridge attestations before the system should alert the user or take action? → A: 1 minute
- Q: What constitutes a "significant" difference between estimated and actual transaction amounts that would require plan adaptation? → A: Any difference always triggers recalculation
- Q: When continuing past a failed transaction, how should dependent transactions be handled? → A: System must skip transactions that depend on the failed transaction's output, but execute independent transactions (e.g., if DAI→USDC swap fails, skip bridging that USDC, but still bridge USDC from successful USDT→USDC swap)

---

## User Scenarios & Testing *(mandatory)*

### Primary User Story
When a user initiates token consolidation, they need to understand what transactions will occur before committing. As consolidation progresses, they need real-time visibility into which transactions have succeeded or failed. If a transaction fails, they should be able to retry it or proceed despite the failure.

The system should intelligently plan the optimal sequence of transactions based on the specific tokens being consolidated, rather than forcing all consolidations through a rigid set of steps.

### Acceptance Scenarios

1. **Given** a user has selected tokens to consolidate, **When** they confirm the consolidation, **Then** they see a visual plan showing all transactions that will be executed, including estimated amounts

2. **Given** a transaction plan is displayed, **When** each transaction completes successfully, **Then** its visual indicator updates to show success and displays actual amounts received

3. **Given** a transaction has failed, **When** the user views the failed transaction, **Then** they see clear visual feedback of the failure and options to either retry the transaction or continue with remaining transactions

4. **Given** a transaction has failed and user chooses to continue, **When** the plan includes transactions dependent on the failed output, **Then** those dependent transactions are automatically skipped while independent transactions still execute

5. **Given** a transaction completes with an actual amount different from estimated, **When** subsequent transactions execute, **Then** those transactions use the actual amounts from previous steps rather than original estimates

6. **Given** multiple transactions are bundled into a single blockchain call, **When** that call executes, **Then** the user sees a single card representing all bundled transactions

7. **Given** a user is consolidating tokens on the same chain where no bridging is needed (e.g., WETH to WBTC on Ethereum), **When** the plan is generated, **Then** the system plans a direct swap without intermediate conversions to USDC

### Edge Cases
- What happens when a user wants to consolidate tokens that don't require all typical steps (e.g., already on destination chain)?
- How does the system handle if the user closes the browser during consolidation? System must persist progress in localStorage and allow full recovery via History page, resuming from the last completed step.
- What happens when estimated amounts are significantly different from actual amounts received? System recalculates all subsequent steps.
- What happens when a transaction fails and subsequent transactions depend on its output? Dependent transactions are automatically skipped while independent ones execute.
- How should the system behave if the user has insufficient gas on an intermediate chain? Wallet will reject the transaction with a gas error. System shows user-friendly error message "Insufficient [TOKEN] for gas on [CHAIN]". User can add funds and retry, or continue to skip this chain's transactions.
- What if a bridge attestation takes longer than expected? System must alert user if attestation not received within 1 minute.

## Requirements *(mandatory)*

### Functional Requirements

#### Transaction Planning
- **FR-001**: System MUST generate a transaction plan dynamically based on the specific source tokens, source chains, and destination token/chain combination
- **FR-002**: System MUST display estimated amounts for each transaction before execution begins
- **FR-003**: System MUST identify when multiple operations can be bundled into a single blockchain transaction
- **FR-004**: System MUST show which transactions are bundled together as a single unit
- **FR-005A**: System MUST optimize same-chain consolidations by planning direct swaps when bridging is not needed (e.g., WETH to WBTC on Ethereum should swap directly, not through USDC)
- **FR-005B**: System MUST batch multiple tokens from the same chain and wallet into single swap transactions (up to 6 tokens per transaction) to optimize gas efficiency
- **FR-005C**: System MUST split token batches into multiple transactions when more than 6 tokens need to be swapped together, with each transaction handling at most 6 tokens

#### Visual Feedback
- **FR-006**: System MUST display each transaction or transaction bundle as a distinct visual card
- **FR-007**: System MUST update card appearance to indicate pending state during execution
- **FR-008**: System MUST update card appearance to indicate success (green border) when transaction confirms
- **FR-009**: System MUST update card appearance to indicate failure (red border) when transaction fails
- **FR-010**: System MUST display actual amounts received after each successful transaction

#### Error Recovery
- **FR-011**: System MUST provide a "retry" option for any failed transaction
- **FR-012**: System MUST provide a "continue" option to proceed with remaining transactions despite a failure
- **FR-013**: System MUST allow retry of a failed transaction only if no subsequent transactions have executed yet; once execution continues and a new transaction runs, the failed transaction can no longer be retried
- **FR-014**: System MUST clearly communicate to users the consequences of continuing despite a failure (e.g., "800 USDC will not be consolidated if you continue")

#### Dynamic Execution
- **FR-015**: System MUST recalculate subsequent transaction amounts based on actual results from completed transactions, not original estimates
- **FR-016**: System MUST always recalculate the transaction plan when any difference exists between estimated and actual amounts, updating all subsequent steps with the new actual values
- **FR-017**: System MUST track transaction dependencies (which transactions consume outputs from other transactions)
- **FR-018**: System MUST automatically skip transactions that depend on a failed transaction's output when user continues past a failure
- **FR-019**: System MUST continue executing transactions that are independent of failed transactions

#### Persistence & Recovery
- **FR-020**: System MUST persist consolidation progress to allow recovery if browser is closed
- **FR-021**: System MUST display incomplete consolidations in History page with ability to resume from last completed step
- **FR-022**: System MUST preserve transaction plan state including completed, failed, skipped, and pending transactions
- **FR-023**: System MUST alert user if bridge attestation is not received within 1 minute timeout threshold

#### Transaction Transparency
- **FR-024**: System MUST show transaction details including token amounts, source and destination chains for each step
- **FR-025**: System MUST indicate which transactions require user wallet confirmation vs automatic execution
- **FR-026**: System MUST visually indicate when transactions are skipped due to failed dependencies with clear explanation

### Key Entities *(include if feature involves data)*

- **Transaction Plan**: A dynamically generated sequence of operations required to consolidate specific tokens. Contains estimated amounts that may differ from actual execution results.

- **Transaction Card**: Visual representation of a single transaction or bundle of transactions. Has states: pending, executing, confirmed (success), failed, skipped. May display estimated amounts (pre-execution) and actual amounts (post-execution). Skipped state occurs when a dependency fails and user continues.

- **Bundled Transaction**: Multiple operations combined into a single blockchain transaction for efficiency. Displayed as one card but represents multiple logical steps.

- **Transaction Step**: An individual operation (swap, bridge, attestation wait, claim) within the consolidation process. The number and type of steps vary based on the specific tokens being consolidated.

---

## Review & Acceptance Checklist
*GATE: Automated checks run during main() execution*

### Content Quality
- [x] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

### Requirement Completeness
- [x] No [NEEDS CLARIFICATION] markers remain
- [x] Requirements are testable and unambiguous  
- [x] Success criteria are measurable
- [x] Scope is clearly bounded
- [x] Dependencies and assumptions identified

---

## Execution Status
*Updated by main() during processing*

- [x] User description parsed
- [x] Key concepts extracted
- [x] Ambiguities marked
- [x] User scenarios defined
- [x] Requirements generated
- [x] Entities identified
- [x] Review checklist passed

---

## Next Steps

All critical ambiguities have been resolved through the clarification session. The specification is now complete and ready for implementation planning.

**Proceed with**: `/plan` command to generate the technical implementation plan including architecture, testing strategy, and task breakdown.