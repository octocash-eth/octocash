# Tasks: [FEATURE NAME]

**Input**: Design documents from `/specs/[###-feature-name]/`
**Prerequisites**: plan.md (required), research.md, data-model.md, contracts/

## Execution Flow (main)
```
1. Load plan.md from feature directory
   → If not found: ERROR "No implementation plan found"
   → Extract: tech stack, libraries, structure
2. Load optional design documents:
   → data-model.md: Extract entities → model tasks
   → contracts/: Each file → contract test task
   → research.md: Extract decisions → setup tasks
3. Generate tasks by category:
   → Setup: project init, dependencies, linting
   → Tests: contract tests, integration tests
   → Core: models, services, CLI commands
   → Integration: DB, middleware, logging
   → Polish: unit tests, performance, docs
4. Apply task rules:
   → Different files = mark [P] for parallel
   → Same file = sequential (no [P])
   → Tests before implementation (TDD)
5. Number tasks sequentially (T001, T002...)
6. Generate dependency graph
7. Create parallel execution examples
8. Validate task completeness:
   → All contracts have tests?
   → All entities have models?
   → All endpoints implemented?
9. Return: SUCCESS (tasks ready for execution)
```

## Format: `[ID] [P?] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- Include exact file paths in descriptions

## Path Conventions
- **Octocash structure**: All code in `app/`, tests co-located with source
- `app/components/` - Reusable UI components
- `app/hooks/` - Custom React hooks  
- `app/lib/` - Core business logic
- `app/lib/*.test.ts` - Tests co-located with logic files
- `app/e2e/` - End-to-end test utilities
- `app/routes/` - File-based routing (React Router 7)

## Phase 3.1: Setup
- [ ] T001 Create feature structure in app/ directory
- [ ] T002 Install dependencies (if new packages needed)
- [ ] T003 [P] Verify TypeScript strict mode enabled

## Phase 3.2: Tests First (TDD) ⚠️ MUST COMPLETE BEFORE 3.3
**CRITICAL: These tests MUST be written and MUST FAIL before ANY implementation**
- [ ] T004 [P] Test file app/lib/[feature].test.ts for core logic
- [ ] T005 [P] Test file app/lib/[calculations].test.ts for amount/fee calculations
- [ ] T006 [P] Integration tests co-located with implementation
- [ ] T007 [P] E2E test utilities in app/e2e/ if needed

## Phase 3.3: Core Implementation (ONLY after tests are failing)
- [ ] T008 [P] Core logic in app/lib/[feature].ts
- [ ] T009 [P] React hook in app/hooks/use-[feature].ts
- [ ] T010 [P] UI component in app/components/[Feature].tsx
- [ ] T011 Route handler in app/routes/[route].tsx (if applicable)
- [ ] T012 Error handling with user-friendly messages
- [ ] T013 Loading states and transaction previews
- [ ] T014 TypeScript strict typing (no `any` types)

## Phase 3.4: Integration
- [ ] T015 Integrate with Odos API (verify chain support)
- [ ] T016 Integrate with CCTP (verify chain support)
- [ ] T017 Gas estimation with safety buffer
- [ ] T018 Chain compatibility validation

## Phase 3.5: Polish
- [ ] T019 [P] Additional unit tests for edge cases
- [ ] T020 Verify UI is professional and responsive (Constitution I)
- [ ] T021 [P] Ensure error messages are user-friendly (Constitution III)
- [ ] T022 Performance validation (loading states, timeouts)
- [ ] T023 Final constitutional compliance check

## Dependencies
- Tests (T004-T007) before implementation (T008-T014)
- T008 blocks T009, T015
- T016 blocks T018
- Implementation before polish (T019-T023)

## Parallel Example
```
# Launch T004-T007 together:
Task: "Create test file app/lib/consolidation.test.ts for consolidation logic"
Task: "Create test file app/lib/calculations.test.ts for amount calculations"
Task: "Create test file app/lib/odos.test.ts for Odos API integration"
Task: "Create test file app/lib/cctp.test.ts for CCTP flow"
```

## Notes
- [P] tasks = different files, no dependencies
- Verify tests fail before implementing
- Commit after each task
- Avoid: vague tasks, same file conflicts

## Task Generation Rules
*Applied during main() execution*

1. **From Contracts**:
   - Each contract file → contract test task [P]
   - Each endpoint → implementation task
   
2. **From Data Model**:
   - Each entity → model creation task [P]
   - Relationships → service layer tasks
   
3. **From User Stories**:
   - Each story → integration test [P]
   - Quickstart scenarios → validation tasks

4. **Ordering**:
   - Setup → Tests → Models → Services → Endpoints → Polish
   - Dependencies block parallel execution

## Validation Checklist
*GATE: Checked by main() before returning*

- [ ] All contracts have corresponding tests
- [ ] All entities have model tasks
- [ ] All tests come before implementation
- [ ] Parallel tasks truly independent
- [ ] Each task specifies exact file path
- [ ] No task modifies same file as another [P] task