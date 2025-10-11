
# Implementation Plan: Dynamic Transaction Plan UI

**Branch**: `001-the-consolidation-step` | **Date**: 2025-09-29 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/home/sem/Projects/octocash/specs/001-the-consolidation-step/spec.md`

## Execution Flow (/plan command scope)
```
1. Load feature spec from Input path
   → If not found: ERROR "No feature spec at {path}"
2. Fill Technical Context (scan for NEEDS CLARIFICATION)
   → Detect Project Type from file system structure or context (web=frontend+backend, mobile=app+api)
   → Set Structure Decision based on project type
3. Fill the Constitution Check section based on the content of the constitution document.
4. Evaluate Constitution Check section below
   → If violations exist: Document in Complexity Tracking
   → If no justification possible: ERROR "Simplify approach first"
   → Update Progress Tracking: Initial Constitution Check
5. Execute Phase 0 → research.md
   → If NEEDS CLARIFICATION remain: ERROR "Resolve unknowns"
6. Execute Phase 1 → contracts, data-model.md, quickstart.md, agent-specific template file (e.g., `CLAUDE.md` for Claude Code, `.github/copilot-instructions.md` for GitHub Copilot, `GEMINI.md` for Gemini CLI, `QWEN.md` for Qwen Code or `AGENTS.md` for opencode).
7. Re-evaluate Constitution Check section
   → If new violations: Refactor design, return to Phase 1
   → Update Progress Tracking: Post-Design Constitution Check
8. Plan Phase 2 → Describe task generation approach (DO NOT create tasks.md)
9. STOP - Ready for /tasks command
```

**IMPORTANT**: The /plan command STOPS at step 7. Phases 2-4 are executed by other commands:
- Phase 2: /tasks command creates tasks.md
- Phase 3-4: Implementation execution (manual or via tools)

## Summary
Implement a dynamic transaction planning and visualization system that:
1. Generates transaction plans dynamically based on source tokens/chains and destination token/chain (not fixed steps)
2. Displays transaction cards with visual state indicators (pending, success/green, failed/red, skipped)
3. Handles transaction failures with retry/continue options and intelligent dependency skipping
4. Persists progress for browser recovery
5. Recalculates plans based on actual vs estimated amounts
6. Shows bundled transactions as single cards when operations are combined

## Technical Context
**Language/Version**: TypeScript 5.8+ (strict mode)  
**Primary Dependencies**: React Router 7, Viem 2.x, Wagmi 2.x, RainbowKit, Radix UI, Tailwind CSS 4  
**Storage**: Browser localStorage for consolidation progress persistence  
**Testing**: Vitest + jsdom for unit/integration tests  
**Target Platform**: Modern web browsers (Chrome, Firefox, Safari, Edge)
**Project Type**: Web SPA (React Router 7 file-based routing)  
**Performance Goals**: Page load <3s, UI responsive during blockchain operations, 1min attestation timeout  
**Constraints**: Must work with existing Odos/CCTP integrations, co-located tests in app/lib/  
**Scale/Scope**: Single-page consolidation flow UI, support for 8 chains (Ethereum, Arbitrum, Optimism, Base, Polygon, Unichain, Avalanche, Linea)

## Constitution Check
*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

### I. Professional & Reliable UI
- [x] Design includes modern, professional UI components (Radix UI + Tailwind) - Transaction cards with visual state indicators
- [x] All UI states clearly defined (loading, success, error) - pending, executing, success (green), failed (red), skipped
- [x] Responsive design verified across device sizes - Web SPA responsive requirement
- [x] No development artifacts in user-facing code - Production-ready UI requirement

### II. Integration Dependency Constraint
- [x] All chains used are supported by BOTH Odos AND CCTP v2 - Uses existing integrations only
- [x] Chain compatibility verified before implementation - 8 chains from verified intersection
- [x] Current supported: Ethereum, Arbitrum, Optimism, Base, Polygon, Unichain, Avalanche, Linea

### III. User Safety First
- [x] Transaction previews show all fees, slippage, amounts - FR-002, FR-023
- [x] Error messages are actionable and user-friendly - FR-025 clear explanations for skipped transactions
- [x] No auto-execution without explicit confirmation - Retry/continue buttons, user choice required
- [x] Wallet states clearly communicated - FR-024 indicates wallet confirmation vs auto-execution

### IV. Performance & Reliability
- [x] Loading states for all async operations - FR-006 pending/executing states
- [x] Timeout and retry mechanisms planned - FR-022 1-minute attestation timeout, FR-010 retry option
- [x] Gas estimation with buffer planned - App checks sufficient gas during transaction planning
- [x] Graceful error handling defined - FR-010-013 retry/continue/skip logic

### V. Type Safety & Testing
- [x] TypeScript strict mode enforced - Technical Context specifies TS 5.8+ strict
- [x] No `any` types (except unavoidable third-party cases) - Constitutional requirement maintained
- [x] Test coverage planned for critical paths - Planning phase will define test strategy
- [x] Integration tests for consolidation flow - Required for dynamic plan execution

## Project Structure

### Documentation (this feature)
```
specs/[###-feature]/
├── plan.md              # This file (/plan command output)
├── research.md          # Phase 0 output (/plan command)
├── data-model.md        # Phase 1 output (/plan command)
├── quickstart.md        # Phase 1 output (/plan command)
├── contracts/           # Phase 1 output (/plan command)
└── tasks.md             # Phase 2 output (/tasks command - NOT created by /plan)
```

### Source Code (repository root)
<!--
  ACTION REQUIRED: Octocash uses React Router 7 with file-based routing.
  Expand the structure below for this specific feature.
-->
```
app/
├── components/         # Reusable UI components
├── hooks/             # Custom React hooks
├── lib/               # Core logic (consolidation, cctp, odos, gas)
│   └── *.test.ts      # Tests co-located with source files
├── data/              # Static data (contracts, chain configs)
└── routes/            # File-based routing (React Router 7)

test/
└── e2e/               # End-to-end integration tests
```

**Structure Decision**: React Router 7 single-page application. All source in `app/`, tests co-located with source files (*.test.ts).

## Phase 0: Outline & Research
1. **Extract unknowns from Technical Context** above:
   - For each NEEDS CLARIFICATION → research task
   - For each dependency → best practices task
   - For each integration → patterns task

2. **Generate and dispatch research agents**:
   ```
   For each unknown in Technical Context:
     Task: "Research {unknown} for {feature context}"
   For each technology choice:
     Task: "Find best practices for {tech} in {domain}"
   ```

3. **Consolidate findings** in `research.md` using format:
   - Decision: [what was chosen]
   - Rationale: [why chosen]
   - Alternatives considered: [what else evaluated]

**Output**: research.md with all NEEDS CLARIFICATION resolved

## Phase 1: Design & Contracts
*Prerequisites: research.md complete*

1. **Extract entities from feature spec** → `data-model.md`:
   - Entity name, fields, relationships
   - Validation rules from requirements
   - State transitions if applicable

2. **Generate API contracts** from functional requirements:
   - For each user action → endpoint
   - Use standard REST/GraphQL patterns
   - Output OpenAPI/GraphQL schema to `/contracts/`

3. **Generate contract tests** from contracts:
   - One test file per endpoint
   - Assert request/response schemas
   - Tests must fail (no implementation yet)

4. **Extract test scenarios** from user stories:
   - Each story → integration test scenario
   - Quickstart test = story validation steps

5. **Update agent file incrementally** (O(1) operation):
   - Run `.specify/scripts/bash/update-agent-context.sh cursor`
     **IMPORTANT**: Execute it exactly as specified above. Do not add or remove any arguments.
   - If exists: Add only NEW tech from current plan
   - Preserve manual additions between markers
   - Update recent changes (keep last 3)
   - Keep under 150 lines for token efficiency
   - Output to repository root

**Output**: data-model.md, /contracts/*, failing tests, quickstart.md, agent-specific file

## Phase 2: Task Planning Approach
*This section describes what the /tasks command will do - DO NOT execute during /plan*

**Task Generation Strategy**:
1. **From data-model.md** - Generate TypeScript interfaces:
   - T001 [P]: TransactionStep, TransactionType, StepStatus types in `app/lib/types.ts`
   - T002 [P]: ConsolidationState, StepResult types in `app/lib/types.ts`
   - T003 [P]: TokenAmount, TransactionError types in `app/lib/types.ts`

2. **From planning-contract.md** - Planning function implementation:
   - T004: Test file `app/lib/planning.test.ts` with all contract test cases
   - T005: Helper functions in `app/lib/odos.ts`: `getSwapQuote()`
   - T006: Helper functions in `app/lib/cctp.ts`: `getBridgeFee()`, `estimateBridgeGas()`
   - T007: Core planning function `planConsolidation()` in `app/lib/consolidation.ts`

3. **From execution-contract.md** - Execution engine:
   - T009: Test file `app/lib/execution.test.ts` with all contract test cases
   - T010: State persistence functions in `app/lib/storage.ts`
   - T011: Execution function `executeConsolidationPlan()` in `app/lib/consolidation.ts`
   - T012: Dependency skipping logic `shouldSkipStep()` in `app/lib/consolidation.ts`
   - T013: Recalculation logic after each step in `app/lib/consolidation.ts`

4. **From ui-component-contract.md** - React components:
   - T014 [P]: `TransactionCard` component in `app/components/transaction-card.tsx`
   - T015 [P]: `TransactionPlanView` container in `app/components/transaction-plan-view.tsx`
   - T016: [CANCELLED] Recovery handled from History page instead

5. **From quickstart.md** - Integration & E2E tests:
   - T017 [P]: Integration test for Scenario 1 (happy path) in `test/e2e/consolidation-happy-path.test.ts`
   - T018 [P]: Integration test for Scenario 3 (dependency skip) in `test/e2e/consolidation-skip.test.ts`
   - T019 [P]: Integration test for Scenario 8 (recovery) in `test/e2e/consolidation-recovery.test.ts`

6. **Integration & Polish**:
   - T020: Delete functionality for consolidation history in History page (no automatic cleanup)
   - T021: Error message mapping (user-friendly)
   - T022: Accessibility audit (keyboard nav, ARIA labels)
   - T023: Performance validation (plan generation <2s)
   - T024: Final constitutional compliance check

**Ordering Strategy**:
- **Phase 3.1 Setup**: T001-T003 (type definitions) - Foundation for all code
- **Phase 3.2 Tests First**: T004, T009, T017-T019 [P] - TDD requirement
- **Phase 3.3 Core Logic**: T005-T008 (planning), T010-T013 (execution) - Make tests pass
- **Phase 3.4 UI**: T014-T016 [P] - Components (independent files)
- **Phase 3.5 Polish**: T020-T024 - Integration and quality

**Parallelization**:
- T001-T003 [P]: Different type groups, same file (careful)
- T004 & T009 [P]: Different test files
- T017-T019 [P]: Independent E2E scenarios
- T014-T016 [P]: Independent component files

**Estimated Output**: 24 numbered tasks in tasks.md

**Dependencies**:
- T001-T003 must complete before T004-T016 (types needed)
- T004 must complete before T005-T008 (TDD)
- T009 must complete before T010-T013 (TDD)
- T005-T013 must complete before T014-T016 (logic needed for UI)
- All implementation before T020-T024 (polish)

**IMPORTANT**: This phase is executed by the /tasks command, NOT by /plan

## Phase 3+: Future Implementation
*These phases are beyond the scope of the /plan command*

**Phase 3**: Task execution (/tasks command creates tasks.md)  
**Phase 4**: Implementation (execute tasks.md following constitutional principles)  
**Phase 5**: Validation (run tests, execute quickstart.md, performance validation)

## Complexity Tracking
*Fill ONLY if Constitution Check has violations that must be justified*

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| [e.g., 4th project] | [current need] | [why 3 projects insufficient] |
| [e.g., Repository pattern] | [specific problem] | [why direct DB access insufficient] |


## Progress Tracking
*This checklist is updated during execution flow*

**Phase Status**:
- [x] Phase 0: Research complete (/plan command) - ✓ research.md created
- [x] Phase 1: Design complete (/plan command) - ✓ data-model.md, contracts/, quickstart.md, agent file updated
- [x] Phase 2: Task planning complete (/plan command - describe approach only) - ✓ 24 tasks described above
- [x] Phase 3: Tasks generated (/tasks command) - ✓ tasks.md created with 24 executable tasks
- [ ] Phase 4: Implementation complete
- [ ] Phase 5: Validation passed

**Gate Status**:
- [x] Initial Constitution Check: PASS - All principles satisfied
- [x] Post-Design Constitution Check: PASS - Design aligns with all constitutional requirements
- [x] All NEEDS CLARIFICATION resolved - Spec has clarifications from /clarify session
- [x] Complexity deviations documented - No violations, no deviations

---
*Based on Constitution v1.1.0 - See `.specify/memory/constitution.md`*
