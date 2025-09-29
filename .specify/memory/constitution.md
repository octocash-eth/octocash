<!--
Sync Impact Report:
- Version: 0.0.0 → 1.0.0 (Initial constitution ratification)
- Modified principles: N/A (initial version)
- Added sections:
  * Core Principles (I-V): Professional UI, Integration Constraints, User Safety, Performance, Type Safety
  * Technical Constraints: Tech stack, supported chains, external dependencies
  * Development Standards: Code organization, commit practices, error handling
  * Governance: Amendment process, constitutional review, versioning policy
- Removed sections: N/A
- Templates requiring updates:
  ✅ Updated: .specify/templates/plan-template.md (Constitution Check section with all 5 principles, updated structure for React Router 7, version reference updated)
  ✅ Updated: .specify/templates/tasks-template.md (Path conventions for app/ structure, example tasks updated for TypeScript/React, constitutional compliance tasks added)
  ✅ Updated: .specify/templates/spec-template.md (verified - requirements alignment compatible)
  ✅ Updated: .specify/templates/agent-file-template.md (verified - generic template, no updates needed)
  ✅ Updated: README.md (no constitution references, no updates needed)
- Chain support updated: Added Unichain, Linea, Sonic to intersection (user amendment)
- Structure correction: Tests are co-located in app/lib/*.test.ts, not separate tests/ directory
- Follow-up TODOs: None
-->

# Octocash Constitution

## Core Principles

### I. Professional & Reliable UI (NON-NEGOTIABLE)
The application MUST project professionalism and reliability through its user interface. Every visual element, interaction pattern, and user flow must inspire confidence when users are managing their crypto assets.

**Requirements**:
- Modern, clean design using established UI frameworks (Radix UI, Tailwind CSS)
- Professional color schemes and typography
- Clear, unambiguous UI states (loading, success, error)
- Consistent spacing, alignment, and visual hierarchy
- Responsive design that works flawlessly across devices
- No placeholder text, broken images, or development artifacts in production

**Rationale**: Users are entrusting the app with their financial assets. A polished, professional interface builds trust and reduces user anxiety during transactions.

### II. Integration Dependency Constraint
The application MUST only support blockchain networks that are supported by BOTH Odos (for swapping) AND Circle's CCTP v2 (for bridging), as the entire consolidation flow depends on these integrations.

**Requirements**:
- Chain support verification MUST check both Odos and CCTP v2 compatibility
- New chain additions MUST confirm availability in both services before implementation
- Feature development MUST NOT assume chain support beyond the intersection of these services
- Documentation MUST clearly state supported chains and their dependencies

**Rationale**: The consolidation flow requires reliable swapping (Odos) and USDC bridging (CCTP v2). Supporting chains outside this intersection would break the core functionality or require significant architectural changes.

### III. User Safety First
All user interactions involving transaction signing, wallet connections, or asset transfers MUST be transparent, reversible where possible, and clearly communicated.

**Requirements**:
- Transaction preview MUST show all fees, slippage, and final amounts before confirmation
- Error messages MUST be actionable and user-friendly (no raw error codes)
- Failed transactions MUST preserve user assets and provide recovery guidance
- Wallet connection states MUST be clearly indicated
- Never auto-execute transactions without explicit user confirmation

**Rationale**: Crypto transactions are irreversible and costly. Users must understand exactly what will happen before they commit.

### IV. Performance & Reliability
The application MUST maintain responsive performance and graceful error handling, especially during blockchain interactions which can be slow or fail.

**Requirements**:
- Loading states for all async operations (swaps, bridges, attestations)
- Timeout handling with retry mechanisms
- Gas estimation with buffer to prevent transaction failures
- Optimistic UI updates where safe, with rollback on error
- Page load time < 3s on modern connections

**Rationale**: Blockchain operations are inherently unpredictable. The app must handle delays and failures without degrading user experience.

### V. Type Safety & Testing
All code MUST be strictly typed (TypeScript) and critical paths MUST have test coverage.

**Requirements**:
- TypeScript strict mode enabled (`strict: true`)
- No `any` types except for unavoidable third-party library compatibility
- Integration tests for consolidation flow (swap, bridge, mint)
- Unit tests for calculation logic (amounts, fees, slippage)
- Contract tests for external API integrations (Odos, CCTP)

**Rationale**: Financial applications cannot afford type errors or untested code paths. Strict typing catches errors at compile time; tests catch them before production.

## Technical Constraints

### Technology Stack (FIXED)
- **Framework**: React Router 7 (file-based routing)
- **Language**: TypeScript 5.8+ (strict mode)
- **Blockchain**: Viem + Wagmi (v2) + RainbowKit
- **UI**: Radix UI + Tailwind CSS 4
- **Testing**: Vitest + jsdom
- **Build**: Bun 1.2+
- **Linting**: Biome (no ESLint/Prettier)

**Rationale**: Stack is already established and battle-tested for web3 applications. Changes would require significant migration effort.

### Supported Chains
Only chains available in BOTH:
- Odos swap API (`https://api.odos.xyz/info/chains`). Currently supported: Ethereum, Unichain, zkSync Era, Base, Mantle, Polygon, Optimism, Mode, Avalanche, Linea, Scroll, Arbitrum, Sonic, BNB Chain, Fantom, and Fraxtal.
- Circle CCTP v2 (`https://developers.circle.com/cctp/evm-smart-contracts`). Currently supported: Ethereum, Avalanche, OP Mainnet, Arbitrum, Base, Polygon PoS, Unichain, Linea, Codex, Sonic, World Chain, Sei, XDC, HyperEVM, Ink, Plume.

**Current Intersection**: Ethereum, Arbitrum, Optimism, Base, Polygon, Unichain, Avalanche, Linea

### External Dependencies
- **Odos API**: For token swaps (`https://api.odos.xyz/sor/*`)
- **CCTP Attestation API**: For bridge attestations (`https://iris-api.circle.com/v1/attestations`)
- **CCTP Contracts**: Circle's MessageTransmitter and TokenMessenger
- **RPC Providers**: Reliable RPC endpoints for all supported chains

## Development Standards

### Code Organization
```
app/
├── components/     # Reusable UI components
├── hooks/          # Custom React hooks
├── lib/            # Core business logic (consolidation, cctp, odos, gas)
│   └── *.test.ts   # Tests co-located with source files
├── data/           # Static data (contract addresses, chain configs)
├── e2e/            # End-to-end test utilities
└── routes/         # File-based routing (React Router 7)
```

### Commit Practices
- Conventional commits: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`
- Atomic commits (one logical change per commit)
- All tests passing before commit (Husky pre-commit hook)

### Error Handling
- User-facing errors: Clear messages with suggested actions
- Developer errors: Detailed context in console (dev mode only)
- Transaction errors: Include transaction hash, chain, and recovery steps
- Network errors: Retry logic with exponential backoff

## Governance

### Amendment Process
1. Propose changes via discussion (GitHub issue or team review)
2. Document impact on existing features and architecture
3. Update constitution version:
   - MAJOR: Backward incompatible changes (e.g., removing a principle)
   - MINOR: New principle or significant expansion
   - PATCH: Clarifications, wording fixes
4. Update all dependent templates and documentation
5. Commit with message: `docs: amend constitution to vX.Y.Z (summary)`

### Constitutional Review
- All feature specs MUST verify constitutional compliance
- Implementation plans MUST document any principle conflicts
- Code reviews MUST flag constitutional violations
- Violations require explicit justification or design change

### Versioning Policy
This document follows semantic versioning. Breaking changes to core principles require MAJOR version bump. New principles or significant clarifications require MINOR bump. Typos and rewordings are PATCH.

**Version**: 1.0.0 | **Ratified**: 2025-09-29 | **Last Amended**: 2025-09-29