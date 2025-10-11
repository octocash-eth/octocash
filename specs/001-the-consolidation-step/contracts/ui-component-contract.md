# Contract: Transaction Plan UI Components

## Overview

The transaction plan UI is built with a **modular component architecture** that separates concerns between planning, execution, display, and interaction. This document describes all UI components and their contracts.

## Component Hierarchy

```
TransactionPlanExecutor (NEW plan + execute)
  ├─ PlanningLoader (loading state)
  ├─ PlanError (error state)
  └─ [after planning]
      ├─ PlanList
      │   └─ PlanCard (×N steps)
      ├─ ExecutionStatusAlert
      └─ ExecutionActions | PausedActions

TransactionPlanViewer (EXISTING plan + execute)
  ├─ PlanList
  │   └─ PlanCard (×N steps)
  ├─ ExecutionStatusAlert
  └─ ExecutionActions | PausedActions
```

---

## 1. PlanCard Component

### Component Signature

```typescript
interface PlanCardProps {
  step: TransactionStep;
  stepNumber: number;
  result?: StepResult;
}

function PlanCard(props: PlanCardProps): JSX.Element
```

### Purpose
Displays a single transaction step as a compact horizontal row with status indicator and action text. Designed for minimal visual footprint in a list/timeline view.

## Props

### step: TransactionStep
- **Required**: Yes
- **Description**: The transaction step to display
- **Used for**: Type, amounts, chain info, status, input/output tokens

### stepNumber: number
- **Required**: Yes
- **Description**: The sequential number of this step in the transaction flow
- **Used for**: Displaying step number in pending state

### result?: StepResult
- **Required**: No
- **Description**: Execution result containing actual output amounts and transaction hash
- **Used for**: Showing actual output amounts in action text, providing transaction explorer link

## Visual Specification

### Layout
Simple horizontal row layout with hover effect:
- **Container**: Flex row with `items-center justify-between`
- **Padding**: `py-2 px-3`
- **Hover**: `hover:bg-gray-50` background
- **Border radius**: `rounded`
- **No borders or colored backgrounds** by default

### Left Side: Status Icon + Action Text

#### Status Icon (20x20px, flex-shrink-0)
- **Pending**: 
  - Circular badge with step number
  - Background: `bg-primary`, Text: `text-primary-foreground`
  - Or gray circle icon if no step number
- **Executing**: Blue spinning loader (`Loader2`, `text-primary animate-spin`)
- **Success**: Green checkmark (`Check`, `text-green-500`)
- **Failed**: Red X (`X`, `text-red-500`)

#### Action Text
- **Text style**: `text-sm text-gray-700 truncate`
- **Gap from icon**: `gap-3`
- **Format**: Dynamic based on transaction type and status

### Right Side: Action Link or Status Label

- **Success with tx hash**: 
  - Link to block explorer: "View tx" with external link icon
  - Style: `text-sm text-blue-600 hover:text-blue-700 hover:underline`
  - Icon: `ExternalLink` (12x12px)
- **Failed**: 
  - Text label: "Failed"
  - Style: `text-sm font-medium text-red-600`
- **Other states**: No right-side element

## Action Text Format

The component generates dynamic action text based on transaction type and status:

### Swap
- Pending: "Swap {inputAmount} {inputSymbol} to {outputAmount} {outputSymbol} in {chainName}"
- Executing: "Swapping {inputAmount} {inputSymbol} to {outputAmount} {outputSymbol} in {chainName}"
- Success: "Swapped {inputAmount} {inputSymbol} to {actualOutputAmount} {outputSymbol} in {chainName}"

### Bridge
- Pending: "Bridge {inputAmount} {inputSymbol} from {sourceChain} to {destChain}"
- Executing: "Bridging {inputAmount} {inputSymbol} from {sourceChain} to {destChain}"
- Success: "Bridged {inputAmount} {inputSymbol} from {sourceChain} to {destChain}"

### Attestation
- Pending: "Wait for attestation in {chainName}"
- Executing: "Waiting for attestation in {chainName}"
- Success: "Waited for attestation in {chainName}"

### Claim
- Pending: "Claim {outputAmount} {outputSymbol} in {chainName}"
- Executing: "Claiming {outputAmount} {outputSymbol} in {chainName}"
- Success: "Claimed {actualOutputAmount} {outputSymbol} in {chainName}"

### Transfer
- Pending: "Transfer {inputAmount} {inputSymbol} in {chainName}"
- Executing: "Transferring {inputAmount} {inputSymbol} in {chainName}"
- Success: "Transferred {inputAmount} {inputSymbol} in {chainName}"

## Behavior

### Click Interactions
- **Card hover**: Background changes to gray-50
- **Transaction hash link**: Opens block explorer in new tab (`target="_blank" rel="noopener noreferrer"`)

### Amount Formatting
- Uses `formatUnits()` from viem to convert bigint amounts
- Displays with `toLocaleString()` with max 6 decimal places
- Shows actual output amounts from `result.actualOutput` when available (success state)
- Falls back to estimated amounts from `step.outputToken` for pending/executing states

### Explorer URL Generation
- Reads chain config from `chains` data structure
- Uses `chain.blockExplorers.default.url` to construct tx URL
- Format: `{explorerUrl}/tx/{txHash}`

## Dependencies

### Icons (lucide-react)
- `Loader2` - executing spinner
- `Check` - success checkmark
- `X` - failed icon
- `Circle` - pending fallback icon
- `ExternalLink` - transaction hash link

### Utilities
- `formatUnits()` from viem - amount formatting
- `chains` from `~/data/supported-chains` - chain metadata
- `TransactionStep`, `StepResult` types from `~/lib/types`

## Design Decisions

### Why No Retry/Continue Buttons?
Transaction control (retry, skip, continue) is handled at a higher level in the UI, not at the individual card level. This keeps the card component simple and focused on display only.

### Why Minimal Styling?
The component prioritizes information density and list readability over individual card prominence. The hover effect provides enough visual feedback.

### Why No Error Messages?
Error handling and user actions are managed by parent components. The card only indicates failed status visually.

### Testing

#### Component Tests (plan-card.test.tsx)
1. **Render pending state**: Should show step number badge and action text ✅
2. **Render executing state**: Should show spinning loader ✅
3. **Render success state**: Should show checkmark and "View tx" link ✅
4. **Render failed state**: Should show X icon and "Failed" label ✅
5. **Action text formatting**: Verify correct text for each transaction type and status
6. **Amount formatting**: Should format bigint amounts correctly with proper decimals
7. **Explorer links**: Should generate correct block explorer URLs
8. **Responsive behavior**: Should truncate long text appropriately

### Performance

- **Render time**: Minimal - simple layout with no complex state logic
- **Re-render optimization**: Pure presentational component, naturally efficient
- **Large lists**: Lightweight design suitable for lists of 100+ items without virtualization

---

## 2. PlanList Component

### Component Signature

```typescript
interface PlanListProps {
  state: ConsolidationState;
  maxHeight?: string;
}

function PlanList(props: PlanListProps): JSX.Element
```

### Purpose
Renders a scrollable list of all transaction steps in a consolidation plan. Automatically maps steps to PlanCard components.

### Props

#### state: ConsolidationState
- **Required**: Yes
- **Description**: The full consolidation state containing plan and results
- **Used for**: Rendering all steps and their current status

#### maxHeight?: string
- **Required**: No
- **Default**: "400px"
- **Description**: Maximum height for the scrollable container
- **Used for**: Preventing extremely long lists from dominating the layout

### Behavior
- **Scrolling**: Vertical scroll with `overflow-y-auto` when content exceeds maxHeight
- **Spacing**: 12px gap between cards (`space-y-3`)
- **Padding**: Right padding (`pr-2`) to prevent scrollbar overlap

### Implementation File
`app/components/transaction-plan/plan-list.tsx`

---

## 3. TransactionPlanExecutor Component

### Component Signature

```typescript
interface ExecutorProps {
  planId: string;
  sourceTokens: SourceToken[];
  destinationToken: DestinationToken;
  showActions?: boolean;
  onComplete?: (state: ConsolidationState) => void;
  onBack?: () => void;
}

function TransactionPlanExecutor(props: ExecutorProps): JSX.Element
```

### Purpose
**High-level component** that generates a NEW consolidation plan from source/destination tokens, then executes it. Handles the full lifecycle: planning → display → execution → completion.

### Props

#### planId: string
- **Required**: Yes
- **Description**: Unique identifier for this planning session
- **Used for**: localStorage key, debugging, tracking

#### sourceTokens: SourceToken[]
- **Required**: Yes
- **Description**: Array of tokens to consolidate (from different chains/wallets)
- **Used for**: Planning phase input

#### destinationToken: DestinationToken
- **Required**: Yes
- **Description**: Target token and destination wallet
- **Used for**: Planning phase output target

#### showActions?: boolean
- **Required**: No
- **Default**: false
- **Description**: Whether to show Back/Execute/Retry/Skip buttons
- **Used for**: Modal vs page display (modal shows actions, preview doesn't)

#### onComplete?: (state: ConsolidationState) => void
- **Required**: No
- **Description**: Callback when consolidation finishes
- **Used for**: Navigation, notifications, cleanup

#### onBack?: () => void
- **Required**: No
- **Description**: Callback for "Back" button
- **Used for**: Navigation back to token selection

### Behavior

#### States
1. **Planning**: Shows `<PlanningLoader />` spinner
2. **Error**: Shows `<PlanError />` with retry option
3. **Ready**: Shows plan preview with "Confirm & Execute" button
4. **Executing**: Shows plan with progress updates
5. **Paused**: Shows plan with "Retry" and "Skip & Continue" buttons
6. **Completed/Partial**: Shows final status alert

#### Hooks Used
- `useConsolidationPlanning()` - Generates the plan
- `useConsolidationExecution()` - Executes the plan

### Implementation File
`app/components/transaction-plan/transaction-plan-executor.tsx`

---

## 4. TransactionPlanViewer Component

### Component Signature

```typescript
interface ViewerProps {
  state: ConsolidationState;
  showActions?: boolean;
  onComplete?: (state: ConsolidationState) => void;
  onBack?: () => void;
}

function TransactionPlanViewer(props: ViewerProps): JSX.Element
```

### Purpose
**High-level component** that displays an EXISTING consolidation plan (e.g., from history/recovery) with optional execution controls. Use when you already have a `ConsolidationState`.

### Props

#### state: ConsolidationState
- **Required**: Yes
- **Description**: Existing consolidation state to display/execute
- **Used for**: Recovery, history page resume

#### showActions?: boolean
- **Required**: No
- **Default**: false
- **Description**: Whether to show Execute/Retry/Skip buttons
- **Used for**: History page (shows actions) vs read-only display

#### onComplete?: (state: ConsolidationState) => void
- **Required**: No
- **Description**: Callback when execution finishes

#### onBack?: () => void
- **Required**: No
- **Description**: Callback for back navigation

### Behavior
- Simpler than Executor (no planning phase)
- Directly passes state to execution hook
- Shows paused/completed alerts
- Conditional action buttons based on state

### Hooks Used
- `useConsolidationExecution()` - Executes/resumes the plan

### Implementation File
`app/components/transaction-plan/transaction-plan-viewer.tsx`

---

## 5. ExecutionStatusAlert Component

### Component Signature

```typescript
interface ExecutionStatusAlertProps {
  status: ConsolidationStatusType;
  error?: TransactionError;
}

function ExecutionStatusAlert(props: ExecutionStatusAlertProps): JSX.Element
```

### Purpose
Displays status alerts for completed, partial, or paused consolidations with appropriate styling and messaging.

### Props

#### status: ConsolidationStatusType
- **Required**: Yes
- **Description**: Current consolidation status
- **Used for**: Determining which alert to show

#### error?: TransactionError
- **Required**: No
- **Description**: Error details if status is "paused"
- **Used for**: Displaying user-friendly error messages

### Behavior

#### Alert Types
1. **Completed (Success)**: Green alert with checkmark, "All transactions completed successfully"
2. **Partial (Warning)**: Yellow alert with info icon, "Some transactions were skipped. Your tokens have been partially consolidated."
3. **Paused (Error)**: Red alert with X icon, error title + message from error object

### Testing
Component has comprehensive tests in `execution-status-alert.test.tsx`:
- ✅ Renders completed status (7 tests)
- ✅ Renders partial status
- ✅ Renders paused status with error

### Implementation File
`app/components/transaction-plan/execution-status-alert.tsx`

---

## 6. ExecutionActions Component

### Component Signature

```typescript
interface ExecutionActionsProps {
  onBack?: () => void;
  onExecute: () => void;
  isExecuting: boolean;
  isCompleted: boolean;
}

function ExecutionActions(props: ExecutionActionsProps): JSX.Element
```

### Purpose
Action buttons for the "ready" state (before/during execution).

### Buttons
1. **Back**: Outline variant, disabled during execution/after completion
2. **Confirm & Execute**: Primary variant, shows spinner during execution, "Completed" when done

### Implementation File
`app/components/transaction-plan/actions/execution-actions.tsx`

---

## 7. PausedActions Component

### Component Signature

```typescript
interface PausedActionsProps {
  onSkip: () => void;
  onRetry: () => void;
  disabled: boolean;
}

function PausedActions(props: PausedActionsProps): JSX.Element
```

### Purpose
Action buttons for the "paused" state (after a step fails).

### Buttons
1. **Skip & Continue**: Outline variant, marks failed step as skipped
2. **Retry**: Primary variant, retries the failed step, shows spinner during retry

### Implementation File
`app/components/transaction-plan/actions/paused-actions.tsx`

---

## 8. PlanningLoader Component

### Purpose
Loading state shown during plan generation.

### Behavior
- Displays spinner with "Generating transaction plan..." message
- Prevents user interaction during planning

### Implementation File
`app/components/transaction-plan/loading-states/planning-loader.tsx`

---

## 9. PlanError Component

### Purpose
Error state shown when plan generation fails.

### Behavior
- Displays error message
- Provides retry/back options

### Implementation File
`app/components/transaction-plan/loading-states/plan-error.tsx`

---

## Component Index

All components are exported from `app/components/transaction-plan/index.ts`:

```typescript
// High-level containers
export { TransactionPlanExecutor } from "./transaction-plan-executor";
export { TransactionPlanViewer } from "./transaction-plan-viewer";

// Display components
export { PlanList } from "./plan-list";
export { PlanCard } from "./plan-card";
export { ExecutionStatusAlert } from "./execution-status-alert";

// Action components
export { ExecutionActions } from "./actions/execution-actions";
export { PausedActions } from "./actions/paused-actions";

// Loading states
export { PlanningLoader } from "./loading-states/planning-loader";
export { PlanError } from "./loading-states/plan-error";

// Types
export type { ExecutorProps, ViewerProps, ConsolidationStatusType } from "./types";
```

---

## Design Decisions

### Why Two High-Level Components?
- **TransactionPlanExecutor**: For NEW consolidations (generates plan first)
- **TransactionPlanViewer**: For EXISTING consolidations (history/recovery)
- Separation of concerns: planning vs displaying

### Why Separate Action Components?
- Different button sets for different states
- Cleaner testing and maintenance
- Easier to customize per state

### Why No Retry/Continue in PlanCard?
Transaction control is handled at the container level (Executor/Viewer), not at individual card level. Keeps cards simple and focused on display.

### Why Minimal Card Styling?
Prioritizes information density and list readability. The hover effect provides sufficient visual feedback.

---

## Usage Examples

### Example 1: New Consolidation (with planning)

```tsx
import { TransactionPlanExecutor } from "~/components/transaction-plan";

<TransactionPlanExecutor
  planId={`consolidation-${Date.now()}`}
  sourceTokens={selectedTokens}
  destinationToken={targetToken}
  showActions={true}
  onComplete={(state) => navigate("/history")}
  onBack={() => setStep("select-tokens")}
/>
```

### Example 2: Resume from History

```tsx
import { TransactionPlanViewer } from "~/components/transaction-plan";

<TransactionPlanViewer
  state={savedConsolidationState}
  showActions={true}
  onComplete={(state) => toast.success("Completed!")}
  onBack={() => navigate("/history")}
/>
```

### Example 3: Read-Only Preview

```tsx
import { PlanList } from "~/components/transaction-plan";

<PlanList state={previewState} maxHeight="300px" />
```
