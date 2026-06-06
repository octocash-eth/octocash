import { render, screen, within } from "@testing-library/react";
import { makeState, makeToken } from "test/test-helpers";
import type { Address } from "viem";
import { describe, expect, test, vi } from "vitest";
import { ConsolidationTokensSummary } from "./consolidation-tokens-summary";

// The real TokenCard depends on wagmi / token-metadata hooks and renders null
// until that data resolves. This summary test only cares that one card is
// rendered per token inside a scroll area, so stub it with a marker element.
vi.mock("~/components/token", () => ({
  TokenCard: ({
    token,
    label,
  }: {
    token: { symbol: string; chainId: number; walletAddress: string };
    label?: string;
  }) => (
    <div
      data-testid="token-card"
      data-symbol={token.symbol}
      data-chain={token.chainId}
      data-wallet={token.walletAddress}
    >
      {token.symbol}
      {label ? <span data-testid="token-card-label">{label}</span> : null}
    </div>
  ),
}));

// Anonymized, made-up addresses. Digit-only hex is always a valid (checksum-safe)
// address, so we avoid pulling in real token addresses just to satisfy viem.
const addr = (n: number): Address => `0x${n.toString().padStart(40, "0")}` as Address;
const WALLET_A = addr(1001);
const WALLET_B = addr(1002);
const DESTINATION_TOKEN = addr(9999);

const CHAINS = [1, 137, 42161, 8453, 130];
const SOURCE_TOKEN_COUNT = 11;

// 11 source tokens (modeled on a real partial consolidation) spread across a
// few chains and wallets — more than fit without scrolling.
const sourceTokens = Array.from({ length: SOURCE_TOKEN_COUNT }, (_, i) =>
  makeToken(addr(i + 1), BigInt((i + 1) * 1_000_000), CHAINS[i % CHAINS.length], {
    walletAddress: i % 2 === 0 ? WALLET_A : WALLET_B,
    symbol: `TKN${i + 1}`,
  }),
);

describe("ConsolidationTokensSummary", () => {
  test("renders all 11 source tokens inside a scroll area", () => {
    const state = makeState({
      status: "partial",
      plan: [],
      sourceTokens,
      destinationToken: {
        token: DESTINATION_TOKEN,
        chainId: 137,
        walletAddress: WALLET_A,
        symbol: "aPolUSDC",
        decimals: 6,
      },
    });

    render(<ConsolidationTokensSummary state={state} />);

    // Scope to the "Source Tokens" column (the h4's wrapping <div>).
    const sourceSection = screen.getByText("Source Tokens").parentElement as HTMLElement;

    // Every source token gets a card — none are dropped past the 5th.
    expect(within(sourceSection).getAllByTestId("token-card")).toHaveLength(SOURCE_TOKEN_COUNT);

    // ...and they all live inside a height-capped scroll area so the overflow
    // is actually reachable.
    const scrollArea = sourceSection.querySelector('[data-slot="scroll-area"]') as HTMLElement | null;
    expect(scrollArea).not.toBeNull();
    expect(scrollArea?.className).toContain("max-h-[400px]");
    expect(within(scrollArea as HTMLElement).getAllByTestId("token-card")).toHaveLength(SOURCE_TOKEN_COUNT);

    // Regression guard: the scrollable viewport must inherit the Root's max-height
    // (`max-h-[inherit]`). Without it the viewport's height resolves to `auto`
    // under a max-height-only Root, so content is clipped instead of scrollable
    // and the last tokens become unreachable. (jsdom can't compute real scroll,
    // so we assert the mechanism rather than scrollTop.)
    const viewport = scrollArea?.querySelector('[data-slot="scroll-area-viewport"]') as HTMLElement | null;
    expect(viewport).not.toBeNull();
    expect(viewport?.className).toContain("max-h-[inherit]");
  });
});
