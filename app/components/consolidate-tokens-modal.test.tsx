import { act, fireEvent, render, screen } from "@testing-library/react";
import * as React from "react";
import type { Address } from "viem";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { ConsolidateTokensModal } from "./consolidate-tokens-modal";
import type { DestinationSelection } from "./consolidation-stages/select-destination-stage";

// Controllable mock for the connected wallet addresses so each test can
// simulate the user switching the active account in their wallet (e.g. Rabby).
const mockConnectedAddresses = vi.fn<() => readonly Address[]>(() => []);
vi.mock("~/hooks/use-connected-addresses", () => ({
  useConnectedAddresses: () => mockConnectedAddresses(),
}));

// Stub out currency/pricing context — they aren't relevant for the reset
// behavior under test and would otherwise need a provider tree.
vi.mock("~/context/currency-provider", () => ({
  useFormatFiat: () => (value: number) => `$${value.toFixed(2)}`,
}));
vi.mock("~/context/token-price-provider", () => ({
  useRegisterPrices: () => {},
  usePriceMap: () => ({ priceFor: () => undefined, isPending: () => false }),
}));

// Auto-fill amounts on mount so navigation to stage 2 is permitted by the
// modal's `canNavigateToStage` check without requiring a real slider/input.
vi.mock("./consolidation-stages/select-amount-stage", () => ({
  SelectAmountStage: ({ onAmountsChange }: { onAmountsChange: (a: Record<string, string>) => void }) => {
    React.useEffect(() => {
      onAmountsChange({ token: "1.0" });
    }, [onAmountsChange]);
    return <div data-testid="select-amount-stage" />;
  },
}));
vi.mock("./consolidation-stages/confirm-plan-stage", () => ({
  ConfirmPlanStage: () => <div data-testid="confirm-plan-stage" />,
}));
vi.mock("./consolidation-stages/completion-stage", () => ({
  CompletionStage: () => <div data-testid="completion-stage" />,
}));

// Expose the destination value/onChange so the test can read & mutate it
// without going through real form widgets.
vi.mock("./consolidation-stages/select-destination-stage", () => ({
  SelectDestinationStage: ({
    value,
    onChange,
  }: {
    value: DestinationSelection;
    onChange: (next: DestinationSelection) => void;
  }) => (
    <div data-testid="select-destination-stage">
      <span data-testid="current-destination">{value.walletAddress ?? "<empty>"}</span>
      <button
        type="button"
        data-testid="set-destination"
        onClick={() =>
          onChange({
            walletAddress: "0x1111111111111111111111111111111111111111" as Address,
            chainId: 1,
            tokenInfo: {
              address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address,
              decimals: 6,
              symbol: "USDC",
            },
          })
        }
      >
        Set destination
      </button>
    </div>
  ),
}));

const TOKEN = {
  token: "0xAAAA000000000000000000000000000000000000" as Address,
  chainId: 1,
  walletAddress: "0x1111111111111111111111111111111111111111" as Address,
  amount: 1_000_000n,
  decimals: 6,
  symbol: "USDC",
  name: "USD Coin",
};

// Mirrors `getTokenId` in app/lib/tokens.ts. We hard-code it here so the test
// can build a rowSelection map without importing from the lib.
const TOKEN_ID = `${TOKEN.walletAddress}-${TOKEN.token}-${TOKEN.chainId}`;
const ROW_SELECTION = { [TOKEN_ID]: true };

const renderModal = () =>
  render(<ConsolidateTokensModal tokens={[TOKEN]} rowSelection={ROW_SELECTION} selectedRows={1} />);

const openModal = () => fireEvent.click(screen.getByRole("button", { name: /consolidate tokens/i }));

const advanceToDestinationStage = () => {
  // Stage 1 -> Stage 2. The "Next" button is enabled because the
  // SelectAmountStage mock has already populated valid amounts.
  fireEvent.click(screen.getByRole("button", { name: /^next$/i }));
};

describe("ConsolidateTokensModal", () => {
  beforeEach(() => {
    mockConnectedAddresses.mockReset();
    mockConnectedAddresses.mockReturnValue([
      "0x1111111111111111111111111111111111111111" as Address,
      "0x2222222222222222222222222222222222222222" as Address,
    ]);
  });

  test("closes the modal when the connected addresses change", () => {
    const { rerender } = renderModal();
    openModal();
    expect(screen.getByTestId("select-amount-stage")).toBeInTheDocument();

    mockConnectedAddresses.mockReturnValue(["0x3333333333333333333333333333333333333333" as Address]);
    act(() => {
      rerender(<ConsolidateTokensModal tokens={[TOKEN]} rowSelection={ROW_SELECTION} selectedRows={1} />);
    });

    expect(screen.queryByTestId("select-amount-stage")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  test("clears the previously selected destination on address change", () => {
    const { rerender } = renderModal();
    openModal();
    advanceToDestinationStage();

    fireEvent.click(screen.getByTestId("set-destination"));
    expect(screen.getByTestId("current-destination")).toHaveTextContent("0x1111111111111111111111111111111111111111");

    mockConnectedAddresses.mockReturnValue(["0x3333333333333333333333333333333333333333" as Address]);
    act(() => {
      rerender(<ConsolidateTokensModal tokens={[TOKEN]} rowSelection={ROW_SELECTION} selectedRows={1} />);
    });

    openModal();
    advanceToDestinationStage();
    expect(screen.getByTestId("current-destination")).toHaveTextContent("<empty>");
  });

  test("does not reset when the connected addresses are unchanged", () => {
    const { rerender } = renderModal();
    openModal();
    advanceToDestinationStage();
    fireEvent.click(screen.getByTestId("set-destination"));

    // Re-render with the same addresses (just a new array reference).
    mockConnectedAddresses.mockReturnValue([
      "0x1111111111111111111111111111111111111111" as Address,
      "0x2222222222222222222222222222222222222222" as Address,
    ]);
    act(() => {
      rerender(<ConsolidateTokensModal tokens={[TOKEN]} rowSelection={ROW_SELECTION} selectedRows={1} />);
    });

    // Modal is still open on stage 2 with the previously chosen destination.
    expect(screen.getByTestId("current-destination")).toHaveTextContent("0x1111111111111111111111111111111111111111");
  });

  test("treats address-list order and case as the same set", () => {
    const { rerender } = renderModal();
    openModal();
    advanceToDestinationStage();
    fireEvent.click(screen.getByTestId("set-destination"));

    mockConnectedAddresses.mockReturnValue([
      "0x2222222222222222222222222222222222222222" as Address,
      "0x1111111111111111111111111111111111111111".toUpperCase() as Address,
    ]);
    act(() => {
      rerender(<ConsolidateTokensModal tokens={[TOKEN]} rowSelection={ROW_SELECTION} selectedRows={1} />);
    });

    expect(screen.getByTestId("current-destination")).toHaveTextContent("0x1111111111111111111111111111111111111111");
  });
});
