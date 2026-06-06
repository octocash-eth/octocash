import { render, type RenderOptions } from "@testing-library/react";
import type { ReactElement } from "react";
import type { Account, Address, Chain, HttpTransport, WalletClient } from "viem";
import { executeConsolidationPlan } from "../app/lib/execution";
import type { ConsolidationState, StepResult, TokenAmount, TransactionStep } from "../app/lib/types";
import { TokenPriceProvider } from "~/context/token-price-provider";
import { WalletProvider } from "~/context/wallet-provider";

// ============================================================================
// React Testing Library Utilities
// ============================================================================

/**
 * Custom render function that wraps components with WalletProvider and
 * TokenPriceProvider — the same provider chain real wallet-dependent pages
 * see via `app/routes/_wallet.tsx`.
 */
export function renderWithWallet(ui: ReactElement, options?: RenderOptions) {
  return render(ui, {
    wrapper: ({ children }) => (
      <WalletProvider>
        <TokenPriceProvider>{children}</TokenPriceProvider>
      </WalletProvider>
    ),
    ...options,
  });
}

// Re-export everything from testing-library
export * from "@testing-library/react";

// ============================================================================
// Test Data Constants
// ============================================================================

export const USDC_ETHEREUM = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address;
export const USDC_POLYGON = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359" as Address;
export const USDC_OPTIMISM = "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85" as Address;
export const WBTC_ADDRESS = "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599" as Address;
export const DAI_ADDRESS = "0x6B175474E89094C44Da98b954EedeAC495271d0F" as Address;
export const USDT_ADDRESS = "0xdAC17F958D2ee523a2206206994597C13D831ec7" as Address;
export const ETH_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;
export const WALLET = "0x1234567890123456789012345678901234567890" as Address;

// ============================================================================
// Factory Functions
// ============================================================================

export type MakeTokenOptions = {
  walletAddress?: Address;
  symbol?: string;
  decimals?: number;
  name?: string;
  provenance?: string;
};

/**
 * Helper to create test TokenAmount
 */
export const makeToken = (
  token: Address,
  amount: bigint,
  chainId: number,
  options?: MakeTokenOptions,
): TokenAmount => ({
  token,
  amount,
  chainId,
  walletAddress: options?.walletAddress || WALLET,
  symbol: options?.symbol || "USDC",
  decimals: options?.decimals || 6,
  name: options?.name,
  provenance: options?.provenance,
});

export type MakeStepOverrides = Partial<TransactionStep> & {
  id: string;
  inputTokens: TokenAmount[];
  outputToken: TokenAmount;
};

/**
 * Helper to create test TransactionStep with customizable fields
 */
export const makeStep = (overrides: MakeStepOverrides): TransactionStep => ({
  type: "swap",
  status: "success",
  chainId: overrides.inputTokens[0]?.chainId ?? 1,
  ...overrides,
});

export type MakeStateOverrides = Partial<ConsolidationState> & {
  plan: TransactionStep[];
  sourceTokens: TokenAmount[];
  destinationToken: Omit<TokenAmount, "amount">;
};

/**
 * Helper to create test ConsolidationState with auto-generated results from step statuses
 */
export const makeState = (overrides: MakeStateOverrides): ConsolidationState => {
  const results: Record<string, StepResult> = {};
  for (const step of overrides.plan) {
    if (step.status === "success") {
      results[step.id] = {
        stepId: step.id,
        status: "success",
        chainId: step.chainId,
        transactionHash: `0xhash-${step.id}`,
        actualOutput: step.outputToken,
      };
    } else if (step.status === "failed") {
      results[step.id] = {
        stepId: step.id,
        status: "failed",
        chainId: step.chainId,
      };
    } else if (step.status === "skipped") {
      results[step.id] = {
        stepId: step.id,
        status: "skipped",
        chainId: step.chainId,
        skipReason: "Depends on failed step",
      };
    }
  }

  return {
    id: "test-state",
    currentStepIndex: overrides.plan.length,
    status: "completed",
    results,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
};

// ============================================================================
// Async Utilities
// ============================================================================

/**
 * Helper to consume generator and collect all yielded values
 * @param generator - The generator instance to consume
 * @param maxValues - Optional limit on how many values to consume before stopping
 */
export async function consumeGenerator<TYield>(
  generator: AsyncGenerator<TYield>,
  maxValues?: number,
): Promise<{ finalValue: TYield; values: TYield[] }> {
  const values: TYield[] = [];

  let finalValue: TYield | undefined;
  for await (const value of generator) {
    values.push(value);
    finalValue = value;
    
    if (maxValues !== undefined && values.length >= maxValues) {
      break;
    }
  }

  if (finalValue === undefined) {
    throw new Error("Generator did not yield any values");
  }

  return { finalValue, values };
}

/**
 * Drives `executeConsolidationPlan` the way the UI does when the user keeps
 * clicking "Skip & Continue": run until the plan settles or pauses on a
 * failure; on a pause, mark the failed step `skipped`, resume just after it,
 * and re-run. Returns the terminal state (`completed` / `partial`).
 *
 * This mirrors `useConsolidationExecution.skipStep` and lets tests assert the
 * skip-one-at-a-time behavior without depending on the removed
 * `hasSubsequentExecution` "run unattended" flag.
 */
export async function executeWithSkips(
  state: ConsolidationState,
  walletClient: WalletClient<HttpTransport, Chain, Account>,
): Promise<{ finalValue: ConsolidationState; skips: number }> {
  let current = state;
  let skips = 0;

  // Bound the loop: at most one skip per step, plus a final settling pass.
  for (let i = 0; i <= current.plan.length; i++) {
    const { finalValue } = await consumeGenerator(executeConsolidationPlan(current, walletClient));
    if (finalValue.status !== "paused") {
      return { finalValue, skips };
    }

    const failedIndex = finalValue.plan.findIndex((s) => s.status === "failed");
    if (failedIndex === -1) {
      return { finalValue, skips };
    }

    const failed = finalValue.plan[failedIndex];
    skips += 1;
    current = {
      ...finalValue,
      plan: finalValue.plan.map((s) => (s.id === failed.id ? { ...s, status: "skipped" as const } : s)),
      results: {
        ...finalValue.results,
        [failed.id]: {
          stepId: failed.id,
          chainId: failed.chainId,
          status: "skipped",
          skipReason: "Skipped by user after failure",
        },
      },
      currentStepIndex: failedIndex + 1,
      status: "ready",
      updatedAt: Date.now(),
    };
  }

  throw new Error("executeWithSkips did not terminate");
}
