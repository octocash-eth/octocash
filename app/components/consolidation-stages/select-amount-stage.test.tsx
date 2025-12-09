import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { parseUnits } from "viem";
import { beforeAll, describe, expect, test, vi } from "vitest";
import type { TokenWithConsolidateAmount } from "~/components/consolidate-tokens-modal";
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
vi.mock("~/components/address/address-avatar", () => ({
  default: ({ addressOrEns, className }: { addressOrEns: string; className: string }) => (
    <div className={className} data-testid="address-avatar">
      {addressOrEns}
    </div>
  ),
}));

// Mock AddressDisplay components to avoid WagmiProvider requirement
vi.mock("~/components/address/address-display", () => ({
  AddressDisplayRoot: ({ children, address }: { children: React.ReactNode; address: string }) => (
    <div data-testid="address-display-root" data-address={address}>
      {children}
    </div>
  ),
  AddressDisplayAvatar: ({ className }: { className?: string }) => (
    <div className={className} data-testid="address-display-avatar" />
  ),
  AddressDisplayText: () => <span data-testid="address-display-text">0x1234...7890</span>,
}));

// Mock ChainIcon to simplify rendering
vi.mock("~/components/chain/chain-icon", () => ({
  ChainIcon: ({ chain, className }: { chain: string; className: string }) => (
    <div className={className} data-testid="chain-icon">
      {chain}
    </div>
  ),
}));

// Mock TokenIcon to simplify rendering
vi.mock("~/components/token/token-icon", () => ({
  TokenIcon: ({ token, className }: { token: string; className: string }) => (
    <div className={className} data-testid="token-icon">
      {token}
    </div>
  ),
}));

// Mock TokenDisplay components to avoid WagmiProvider requirement
vi.mock("~/components/token/token-display", () => ({
  TokenDisplayRoot: ({
    children,
    tokenAddress,
    chainId,
    className,
  }: {
    children: React.ReactNode;
    tokenAddress: string;
    chainId: number;
    className?: string;
  }) => (
    <div className={className} data-testid="token-display-root" data-token={tokenAddress} data-chain={chainId}>
      {children}
    </div>
  ),
  TokenDisplayIcon: ({ className }: { className?: string }) => (
    <div className={className} data-testid="token-display-icon" />
  ),
  TokenDisplaySymbol: () => <span data-testid="token-display-symbol">TEST</span>,
}));

describe("SelectAmountStage", () => {
  const createMockToken = (overrides: Partial<TokenWithConsolidateAmount> = {}): TokenWithConsolidateAmount => {
    const decimals = overrides.decimals ?? 6;
    const amountStr = overrides.amountToConsolidate ?? "1.5";
    return {
      token: "0x0000000000000000000000000000000000000001" as `0x${string}`,
      amount: parseUnits(amountStr, decimals),
      chainId: 1,
      walletAddress: "0x1234567890123456789012345678901234567890" as `0x${string}`,
      symbol: "USDC",
      decimals,
      name: "USD Coin",
      unitaryPrice: 1,
      amountToConsolidate: amountStr,
      ...overrides,
    };
  };

  describe("high precision amount handling", () => {
    test("clamps slider value to exact max amount", () => {
      const onAmountsChange = vi.fn();
      const maxAmount = "0.974325570775807518";

      const token = createMockToken({
        amount: parseUnits(maxAmount, 18),
        amountToConsolidate: maxAmount,
        decimals: 18,
        unitaryPrice: 1000,
      });

      render(<SelectAmountStage tokens={[token]} onAmountsChange={onAmountsChange} />);

      // The component should initialize with the max amount
      // Token ID is derived from walletAddress-token-chainId
      const tokenId = `${token.walletAddress}-${token.token}-${token.chainId}`;
      expect(onAmountsChange).toHaveBeenCalledWith({
        [tokenId]: maxAmount,
      });
    });

    test("max button sets exact token amount", async () => {
      const user = userEvent.setup();
      const onAmountsChange = vi.fn();
      const maxAmount = "0.974325570775807518";

      const token = createMockToken({
        amount: parseUnits(maxAmount, 18),
        amountToConsolidate: "0.5",
        decimals: 18,
      });

      render(<SelectAmountStage tokens={[token]} onAmountsChange={onAmountsChange} />);

      const maxButton = screen.getByRole("button", { name: /max/i });
      await user.click(maxButton);

      // Should set to exact max amount, not a precision-lost version
      const tokenId = `${token.walletAddress}-${token.token}-${token.chainId}`;
      expect(onAmountsChange).toHaveBeenLastCalledWith({
        [tokenId]: maxAmount,
      });
    });

    test("input value is clamped to max on blur", async () => {
      const user = userEvent.setup();
      const onAmountsChange = vi.fn();
      const maxAmount = "0.974325570775807518";

      const token = createMockToken({
        amount: parseUnits(maxAmount, 18),
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
      const tokenId = `${token.walletAddress}-${token.token}-${token.chainId}`;
      expect(onAmountsChange).toHaveBeenLastCalledWith({
        [tokenId]: maxAmount,
      });
    });

    test("handles multiple tokens with different precision", () => {
      const onAmountsChange = vi.fn();

      const token1 = createMockToken({
        token: "0x0000000000000000000000000000000000000001" as `0x${string}`,
        amount: parseUnits("0.974325570775807518", 18),
        amountToConsolidate: "0.974325570775807518",
        decimals: 18,
        symbol: "DAI",
      });

      const token2 = createMockToken({
        token: "0x0000000000000000000000000000000000000002" as `0x${string}`,
        amount: parseUnits("1000.123456", 6),
        amountToConsolidate: "1000.123456",
        decimals: 6,
        symbol: "USDC",
      });

      render(<SelectAmountStage tokens={[token1, token2]} onAmountsChange={onAmountsChange} />);

      // Both tokens should preserve their exact amounts
      const tokenId1 = `${token1.walletAddress}-${token1.token}-${token1.chainId}`;
      const tokenId2 = `${token2.walletAddress}-${token2.token}-${token2.chainId}`;
      expect(onAmountsChange).toHaveBeenCalledWith({
        [tokenId1]: "0.974325570775807518",
        [tokenId2]: "1000.123456",
      });
    });
  });
});
