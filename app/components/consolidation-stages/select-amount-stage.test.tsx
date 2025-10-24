import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, test, vi } from "vitest";
import type { WalletData } from "~/components/wallet-table/columns";
import { SelectAmountStage } from "./select-amount-stage";

// Mock ResizeObserver for Radix UI components
beforeAll(() => {
  global.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

// Mock AddressAvatar to avoid WagmiProvider requirement
vi.mock("~/components/address-avatar", () => ({
  default: ({ addressOrEns, className }: { addressOrEns: string; className: string }) => (
    <div className={className} data-testid="address-avatar">
      {addressOrEns}
    </div>
  ),
}));

// Mock ChainIcon to simplify rendering
vi.mock("~/components/chain-icon", () => ({
  ChainIcon: ({ chain, className }: { chain: string; className: string }) => (
    <div className={className} data-testid="chain-icon">
      {chain}
    </div>
  ),
}));

// Mock TokenIcon to simplify rendering
vi.mock("~/components/token-icon", () => ({
  TokenIcon: ({ token, className }: { token: string; className: string }) => (
    <div className={className} data-testid="token-icon">
      {token}
    </div>
  ),
}));

interface TokenWithAmount extends WalletData {
  amountToConsolidate: string;
}

describe("SelectAmountStage", () => {
  const createMockToken = (overrides: Partial<TokenWithAmount> = {}): TokenWithAmount => ({
    id: "test-token-1",
    wallet: "0x1234567890123456789012345678901234567890" as `0x${string}`,
    chain: "Ethereum",
    token: "USDC",
    tokenName: "USD Coin",
    tokenAddress: "0x0000000000000000000000000000000000000001" as `0x${string}`,
    amount: "1.5",
    amountInUsd: 1.5,
    decimals: 6,
    iconUrl: "https://example.com/icon.png",
    amountToConsolidate: "1.5",
    ...overrides,
  });

  describe("high precision amount handling", () => {
    test("clamps slider value to exact max amount", () => {
      const onAmountsChange = vi.fn();
      const maxAmount = "0.974325570775807518";

      const token = createMockToken({
        amount: maxAmount,
        amountToConsolidate: maxAmount,
        decimals: 18,
        amountInUsd: 1000,
      });

      render(<SelectAmountStage tokens={[token]} onAmountsChange={onAmountsChange} />);

      // The component should initialize with the max amount
      expect(onAmountsChange).toHaveBeenCalledWith({
        [token.id]: maxAmount,
      });
    });

    test("max button sets exact token amount", async () => {
      const user = userEvent.setup();
      const onAmountsChange = vi.fn();
      const maxAmount = "0.974325570775807518";

      const token = createMockToken({
        amount: maxAmount,
        amountToConsolidate: "0.5",
        decimals: 18,
      });

      render(<SelectAmountStage tokens={[token]} onAmountsChange={onAmountsChange} />);

      const maxButton = screen.getByRole("button", { name: /max/i });
      await user.click(maxButton);

      // Should set to exact max amount, not a precision-lost version
      expect(onAmountsChange).toHaveBeenLastCalledWith({
        [token.id]: maxAmount,
      });
    });

    test("input value is clamped to max on blur", async () => {
      const user = userEvent.setup();
      const onAmountsChange = vi.fn();
      const maxAmount = "0.974325570775807518";

      const token = createMockToken({
        amount: maxAmount,
        amountToConsolidate: "0",
        decimals: 18,
      });

      render(<SelectAmountStage tokens={[token]} onAmountsChange={onAmountsChange} />);

      const input = screen.getByRole("textbox");

      // Clear and type a value that exceeds max
      await user.clear(input);
      await user.type(input, "0.974325570775807519");
      await user.tab();

      // Should clamp to exact max
      expect(onAmountsChange).toHaveBeenLastCalledWith({
        [token.id]: maxAmount,
      });
    });

    test("handles multiple tokens with different precision", () => {
      const onAmountsChange = vi.fn();

      const token1 = createMockToken({
        id: "token-1",
        amount: "0.974325570775807518",
        amountToConsolidate: "0.974325570775807518",
        decimals: 18,
        token: "DAI",
      });

      const token2 = createMockToken({
        id: "token-2",
        amount: "1000.123456",
        amountToConsolidate: "1000.123456",
        decimals: 6,
        token: "USDC",
      });

      render(<SelectAmountStage tokens={[token1, token2]} onAmountsChange={onAmountsChange} />);

      // Both tokens should preserve their exact amounts
      expect(onAmountsChange).toHaveBeenCalledWith({
        [token1.id]: "0.974325570775807518",
        [token2.id]: "1000.123456",
      });
    });
  });
});
