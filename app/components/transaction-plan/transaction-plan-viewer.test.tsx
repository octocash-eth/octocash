import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { makeState, makeStep, makeToken, USDC_ETHEREUM, WALLET } from "test/test-helpers";
import type { Hex } from "viem";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { ConsolidationState, TransactionStep } from "~/lib/types";

// ---------------------------------------------------------------------------
// Mocks (must be defined before importing the SUT)
// ---------------------------------------------------------------------------

const mockWalletClient = { account: { address: WALLET }, chain: { id: 1 } };

// Partial mock: keep wagmi's real exports (the WalletProvider transitively
// imported via test-helpers needs `createConfig` etc.), but stub the one
// hook the execution path actually consumes. The string form sidesteps the
// fully-typed factory so we don't have to satisfy wagmi's heavily-generic
// `UseWalletClientReturnType`.
vi.mock("wagmi", async () => {
  const actual = (await vi.importActual("wagmi")) as Record<string, unknown>;
  return {
    ...actual,
    useWalletClient: () => ({ data: mockWalletClient }),
  };
});

const mockSaveConsolidation = vi.fn();
vi.mock("~/hooks/use-consolidation-records", () => ({
  useConsolidationRecords: () => ({ saveConsolidation: mockSaveConsolidation }),
}));

const mockExecuteConsolidationPlan = vi.fn();
vi.mock("~/lib/execution", () => ({
  executeConsolidationPlan: (...args: unknown[]) => mockExecuteConsolidationPlan(...args),
}));

// PlanCard relies on a few visual sub-components that pull data from wagmi.
// Stub them out so we can render the viewer in jsdom without spinning up a
// full wagmi/Wallet provider.
vi.mock("~/components/address/address-avatar", () => ({
  default: ({ className }: { className?: string }) => <div className={className} data-testid="address-avatar" />,
}));
vi.mock("~/components/address/address-display", () => ({
  AddressDisplayRoot: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="address-display-root">{children}</div>
  ),
  AddressDisplayAvatar: ({ className }: { className?: string }) => (
    <div className={className} data-testid="address-display-avatar" />
  ),
  AddressDisplayText: () => <span data-testid="address-display-text">0x1234…7890</span>,
}));
vi.mock("~/components/token/token-display", () => ({
  TokenDisplayRoot: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div className={className} data-testid="token-display-root">
      {children}
    </div>
  ),
  TokenDisplayIcon: ({ className }: { className?: string }) => (
    <div className={className} data-testid="token-display-icon" />
  ),
  TokenDisplaySymbol: () => <span data-testid="token-display-symbol">USDC</span>,
  TokenDisplayAmount: ({ amount }: { amount: bigint }) => (
    <span data-testid="token-display-amount">{amount.toString()}</span>
  ),
}));
vi.mock("~/components/chain/chain-icon", () => ({
  ChainIcon: ({ chain, className }: { chain: string; className?: string }) => (
    <div className={className} data-testid="chain-icon">
      {chain}
    </div>
  ),
}));

import { TransactionPlanViewer } from "./transaction-plan-viewer";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createDeferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

interface MockStallInfo {
  stepId: string;
  txId: string;
  stepIndex: number;
  hash: Hex;
  nonce: number | undefined;
  kind: "resend" | "retry";
  trigger: () => void;
}

interface MockHashSentInfo {
  stepId: string;
  hash: Hex;
  nonce: number | undefined;
  account: typeof WALLET;
  chainId: number;
}

interface MockExecutionCallbacks {
  onStepStall?: (info: MockStallInfo) => void;
  onStepHashSent?: (info: MockHashSentInfo) => void;
}

const STEP_ID = "step-1";
const ORIGINAL_HASH = "0xoriginalhash000000000000000000000000000000000000000000000000abcd" as Hex;
const RESEND_HASH = "0xresendhash00000000000000000000000000000000000000000000000000abcd" as Hex;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const initialStep: TransactionStep = makeStep({
  id: STEP_ID,
  status: "pending",
  inputTokens: [makeToken(USDC_ETHEREUM, 1_000_000n, 1, { walletAddress: WALLET })],
  outputToken: makeToken(USDC_ETHEREUM, 1_000_000n, 1, { walletAddress: WALLET }),
});

const baseState: ConsolidationState = makeState({
  plan: [initialStep],
  sourceTokens: [],
  destinationToken: {
    token: USDC_ETHEREUM,
    chainId: 1,
    walletAddress: WALLET,
    symbol: "USDC",
    decimals: 6,
  },
  status: "ready",
  currentStepIndex: 0,
  // Drop the auto-generated success result the helper provides for "success"
  // steps — we want a clean "not yet executed" baseline.
  results: {},
});

const executingState: ConsolidationState = {
  ...baseState,
  plan: [{ ...initialStep, status: "executing" }],
  status: "executing",
  currentStepIndex: 0,
};

function successState(canonicalHash: Hex, attemptHashes: Hex[]): ConsolidationState {
  return {
    ...baseState,
    plan: [
      {
        ...initialStep,
        status: "success",
        transactionHash: canonicalHash,
        pendingTx: { account: WALLET, nonce: 7, hashes: attemptHashes },
      },
    ],
    results: {
      [STEP_ID]: {
        stepId: STEP_ID,
        chainId: 1,
        status: "success",
        transactionHash: canonicalHash,
        actualOutput: initialStep.outputToken,
      },
    },
    status: "completed",
    currentStepIndex: 1,
  };
}

const RESEND_BUTTON_NAME = /Resend transaction with bumped gas/i;
const RETRY_BUTTON_NAME = /Retry transaction with refreshed calldata/i;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TransactionPlanViewer — stalled tx + Resend race outcomes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("if the original tx confirms BEFORE the user clicks Resend, the CTA disappears and the canonical View tx link takes its place", async () => {
    // The "real" wait-with-resend layer would never invoke this — the original
    // landed first. We assert that below.
    const resendFn = vi.fn();

    // Generator parks at this deferred so the UI can settle into the
    // "stalled, executing" state for inspection before we let the original
    // tx land.
    const release = createDeferred<void>();

    mockExecuteConsolidationPlan.mockImplementation((_state, _wc, callbacks: MockExecutionCallbacks | undefined) => {
      return (async function* () {
        yield executingState;
        // Wallet returned a hash for the original send, persisted via the
        // pendingTx audit trail.
        callbacks?.onStepHashSent?.({
          stepId: STEP_ID,
          hash: ORIGINAL_HASH,
          nonce: 7,
          account: WALLET,
          chainId: 1,
        });
        // …and the public RPC never saw the broadcast within stallAfterMs:
        // executor reports a stall with a unified Resend/Retry handle.
        callbacks?.onStepStall?.({
          stepId: STEP_ID,
          txId: STEP_ID,
          stepIndex: 0,
          hash: ORIGINAL_HASH,
          nonce: 7,
          kind: "resend",
          trigger: resendFn,
        });
        await release.promise;
        // The original tx eventually lands of its own accord.
        yield successState(ORIGINAL_HASH, [ORIGINAL_HASH]);
      })();
    });

    render(<TransactionPlanViewer state={baseState} showActions />);

    fireEvent.click(screen.getByRole("button", { name: /Confirm & Execute/i }));

    // The CTA appears once the executor reports the stall.
    await screen.findByRole("button", { name: RESEND_BUTTON_NAME });

    // Now the in-flight original confirms — without any user input.
    release.resolve();

    await waitFor(() => {
      // Step is no longer executing → the Resend CTA is dropped automatically.
      expect(screen.queryByRole("button", { name: RESEND_BUTTON_NAME })).not.toBeInTheDocument();
      // …and the canonical View tx link replaces it.
      expect(screen.getByRole("link", { name: /View tx/i })).toBeInTheDocument();
    });

    expect(resendFn).not.toHaveBeenCalled();
    // The per-step in-flight hash audit trail is intentionally never
    // surfaced in the UI (multi-call steps would otherwise read like
    // multiple "attempts" of the same op even when nothing went wrong).
    expect(screen.queryByText(/^Attempts:/)).not.toBeInTheDocument();
  });

  test("user clicks Resend; the ORIGINAL tx wins the race → View tx points at the original hash, no Attempts disclosure is rendered", async () => {
    let capturedCallbacks: MockExecutionCallbacks | undefined;
    const release = createDeferred<void>();

    // Models wait-with-resend's short-circuit: when the on-chain nonce has
    // already advanced past ours, the resend layer refuses to broadcast a
    // replacement (no second onHashSent fires).
    const resendFn = vi.fn();

    mockExecuteConsolidationPlan.mockImplementation((_state, _wc, callbacks: MockExecutionCallbacks | undefined) => {
      capturedCallbacks = callbacks;
      return (async function* () {
        yield executingState;
        capturedCallbacks?.onStepHashSent?.({
          stepId: STEP_ID,
          hash: ORIGINAL_HASH,
          nonce: 7,
          account: WALLET,
          chainId: 1,
        });
        capturedCallbacks?.onStepStall?.({
          stepId: STEP_ID,
          txId: STEP_ID,
          stepIndex: 0,
          hash: ORIGINAL_HASH,
          nonce: 7,
          kind: "resend",
          trigger: resendFn,
        });
        await release.promise;
        yield successState(ORIGINAL_HASH, [ORIGINAL_HASH]);
      })();
    });

    render(<TransactionPlanViewer state={baseState} showActions />);
    fireEvent.click(screen.getByRole("button", { name: /Confirm & Execute/i }));

    const resendBtn = await screen.findByRole("button", { name: RESEND_BUTTON_NAME });
    fireEvent.click(resendBtn);

    expect(resendFn).toHaveBeenCalledTimes(1);
    // Optimistic clear: the CTA hides immediately on click, before any
    // generator activity, so the user can't double-fire.
    expect(screen.queryByRole("button", { name: RESEND_BUTTON_NAME })).not.toBeInTheDocument();

    release.resolve();

    const link = await screen.findByRole("link", { name: /View tx/i });
    // viem's replacement detection surfaces whichever hash actually mined
    // under (from, nonce); here that's the original.
    expect(link.getAttribute("href")).toContain(ORIGINAL_HASH);
    // The per-step audit trail is never surfaced in the UI.
    expect(screen.queryByText(/^Attempts:/)).not.toBeInTheDocument();
  });

  test("user clicks Resend; the RESEND tx wins the race → View tx points at the resend hash, both hashes are persisted but never rendered", async () => {
    let capturedCallbacks: MockExecutionCallbacks | undefined;
    const release = createDeferred<void>();

    // Models the resend layer succeeding: it broadcasts a same-nonce,
    // gas-bumped replacement and reports the new hash via onHashSent.
    const resendFn = vi.fn(() => {
      capturedCallbacks?.onStepHashSent?.({
        stepId: STEP_ID,
        hash: RESEND_HASH,
        nonce: 7,
        account: WALLET,
        chainId: 1,
      });
    });

    mockExecuteConsolidationPlan.mockImplementation((_state, _wc, callbacks: MockExecutionCallbacks | undefined) => {
      capturedCallbacks = callbacks;
      return (async function* () {
        yield executingState;
        capturedCallbacks?.onStepHashSent?.({
          stepId: STEP_ID,
          hash: ORIGINAL_HASH,
          nonce: 7,
          account: WALLET,
          chainId: 1,
        });
        capturedCallbacks?.onStepStall?.({
          stepId: STEP_ID,
          txId: STEP_ID,
          stepIndex: 0,
          hash: ORIGINAL_HASH,
          nonce: 7,
          kind: "resend",
          trigger: resendFn,
        });
        await release.promise;
        // The replacement landed; canonical hash is the resend's.
        yield successState(RESEND_HASH, [ORIGINAL_HASH, RESEND_HASH]);
      })();
    });

    render(<TransactionPlanViewer state={baseState} showActions />);
    fireEvent.click(screen.getByRole("button", { name: /Confirm & Execute/i }));

    const resendBtn = await screen.findByRole("button", { name: RESEND_BUTTON_NAME });
    fireEvent.click(resendBtn);

    expect(resendFn).toHaveBeenCalledTimes(1);
    release.resolve();

    const link = await screen.findByRole("link", { name: /View tx/i });
    expect(link.getAttribute("href")).toContain(RESEND_HASH);

    // The audit trail is intentionally NOT rendered in the UI: a multi-call
    // step (approval + swap, approval + bridge) would otherwise read like
    // multiple "attempts" of the same op.
    expect(screen.queryByText(/^Attempts:/)).not.toBeInTheDocument();
    // …but the data must still be persisted so it survives a tab close and
    // can be inspected on a block explorer. Verify the latest persisted
    // snapshot recorded both broadcasts under `pendingTx.hashes`.
    const persistedStates = mockSaveConsolidation.mock.calls.map((args) => args[0] as ConsolidationState);
    const finalPersisted = persistedStates[persistedStates.length - 1];
    expect(finalPersisted.plan[0].pendingTx?.hashes).toEqual([ORIGINAL_HASH, RESEND_HASH]);
    expect(finalPersisted.plan[0].pendingTx?.account).toBe(WALLET);
    expect(finalPersisted.plan[0].pendingTx?.nonce).toBe(7);
  });

  test("renders the Retry CTA (not Resend) when the executor reports kind: 'retry' (sim revert)", async () => {
    let capturedCallbacks: MockExecutionCallbacks | undefined;
    const release = createDeferred<void>();
    const triggerFn = vi.fn();

    mockExecuteConsolidationPlan.mockImplementation((_state, _wc, callbacks: MockExecutionCallbacks | undefined) => {
      capturedCallbacks = callbacks;
      return (async function* () {
        yield executingState;
        capturedCallbacks?.onStepHashSent?.({
          stepId: STEP_ID,
          hash: ORIGINAL_HASH,
          nonce: 7,
          account: WALLET,
          chainId: 1,
        });
        // Simulation reverted in the lib → kind: "retry" surfaces a Retry CTA
        // whose tooltip / icon / label come from STALL_CTA_COPY.retry.
        capturedCallbacks?.onStepStall?.({
          stepId: STEP_ID,
          txId: STEP_ID,
          stepIndex: 0,
          hash: ORIGINAL_HASH,
          nonce: 7,
          kind: "retry",
          trigger: triggerFn,
        });
        await release.promise;
        yield successState(ORIGINAL_HASH, [ORIGINAL_HASH]);
      })();
    });

    render(<TransactionPlanViewer state={baseState} showActions />);
    fireEvent.click(screen.getByRole("button", { name: /Confirm & Execute/i }));

    // Retry CTA visible; the Resend CTA is NOT (it's the same button slot,
    // but PlanCard switches the label / aria-label / icon based on kind).
    const retryBtn = await screen.findByRole("button", { name: RETRY_BUTTON_NAME });
    expect(screen.queryByRole("button", { name: RESEND_BUTTON_NAME })).not.toBeInTheDocument();

    fireEvent.click(retryBtn);
    expect(triggerFn).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: RETRY_BUTTON_NAME })).not.toBeInTheDocument();

    release.resolve();
    await screen.findByRole("link", { name: /View tx/i });
  });
});
