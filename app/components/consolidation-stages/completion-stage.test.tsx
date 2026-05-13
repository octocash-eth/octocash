import { screen } from "@testing-library/react";
import {
  DAI_ADDRESS,
  makeState,
  makeStep,
  makeToken,
  renderWithWallet as render,
  USDC_ETHEREUM,
  WBTC_ADDRESS,
} from "test/test-helpers";
import type { Address } from "viem";
import { describe, expect, test, vi } from "vitest";
import { CompletionStage } from "./completion-stage";

// Mock useToken hook
vi.mock("~/hooks/use-token", () => ({
  useToken: () => ({
    data: {
      address: "0x0000000000000000000000000000000000000000" as Address,
      decimals: 6,
      name: "Mock Token",
      symbol: "MOCK",
    },
  }),
}));

// Mock ChainIcon component
vi.mock("~/components/chain/chain-icon", () => ({
  ChainIcon: ({ chain }: { chain: string }) => <div data-testid="chain-icon">{chain}</div>,
}));

// Mock AddressDisplay components
vi.mock("~/components/address/address-display", () => {
  const React = require("react");
  const AddressContext = React.createContext("");

  return {
    AddressDisplayRoot: ({
      children,
      address,
      className,
    }: {
      children: React.ReactNode;
      address: string;
      className?: string;
    }) => (
      <AddressContext.Provider value={address}>
        <div className={className} data-testid="address-display-root" data-address={address}>
          {children}
        </div>
      </AddressContext.Provider>
    ),
    AddressDisplayAvatar: ({ className }: { className?: string }) => (
      <div className={className} data-testid="address-display-avatar" />
    ),
    AddressDisplayText: () => {
      const address = React.useContext(AddressContext);
      return (
        <span data-testid="address-display-text">{address ? `${address.slice(0, 6)}...${address.slice(-4)}` : ""}</span>
      );
    },
  };
});

// Mock TokenDisplay components
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
  TokenDisplayFiat: ({ amount, price }: { amount: bigint; price?: number }) =>
    price === undefined ? null : <span data-testid="token-display-fiat">{(Number(amount) * price).toString()}</span>,
}));

describe("CompletionStage", () => {
  test("completed state - shows single destination token with final amount", () => {
    const step1 = makeStep({
      id: "step-1",
      inputTokens: [makeToken(DAI_ADDRESS, 1000000n, 1, { symbol: "DAI", decimals: 18 })],
      outputToken: makeToken(USDC_ETHEREUM, 500000n, 1),
    });

    const state = makeState({
      plan: [step1],
      sourceTokens: [makeToken(DAI_ADDRESS, 1000000n, 1, { symbol: "DAI", decimals: 18 })],
      destinationToken: makeToken(USDC_ETHEREUM, 0n, 1),
    });

    render(<CompletionStage state={state} onClose={vi.fn()} />);

    expect(screen.getByText("Consolidation Successful!")).toBeInTheDocument();
    expect(screen.getByText("Source Tokens").parentElement).toBeInTheDocument();
    expect(screen.getByText("Final Token").parentElement).toBeInTheDocument();
  });

  test("partial state - simple dependency failure, shows remaining token", () => {
    const step1 = makeStep({
      id: "step-1",
      status: "failed",
      inputTokens: [makeToken(DAI_ADDRESS, 1000000n, 1, { symbol: "DAI", decimals: 18 })],
      outputToken: makeToken(USDC_ETHEREUM, 500000n, 1),
    });

    const step2 = makeStep({
      id: "step-2",
      type: "bridge",
      status: "skipped",
      inputTokens: [makeToken(USDC_ETHEREUM, 500000n, 1, { provenance: "step-1" })],
      outputToken: makeToken(USDC_ETHEREUM, 500000n, 10),
    });

    const step3 = makeStep({
      id: "step-3",
      chainId: 10,
      inputTokens: [makeToken(WBTC_ADDRESS, 100000n, 10, { symbol: "WBTC", decimals: 8 })],
      outputToken: makeToken(USDC_ETHEREUM, 300000n, 10),
    });

    const state = makeState({
      status: "partial",
      plan: [step1, step2, step3],
      sourceTokens: [
        makeToken(DAI_ADDRESS, 1000000n, 1, { symbol: "DAI", decimals: 18 }),
        makeToken(WBTC_ADDRESS, 100000n, 10, { symbol: "WBTC", decimals: 8 }),
      ],
      destinationToken: makeToken(USDC_ETHEREUM, 0n, 10),
      hasSubsequentExecution: true,
    });

    render(<CompletionStage state={state} onClose={vi.fn()} />);

    expect(screen.getByText("Consolidation Partially Completed")).toBeInTheDocument();
    expect(screen.getByText("Final Token").parentElement).toBeInTheDocument();
  });

  test("partial state - complex branching with multiple final steps", () => {
    // Branch A: step-1 -> step-2 (step-1 fails, step-2 skipped)
    const step1 = makeStep({
      id: "step-1",
      status: "failed",
      inputTokens: [makeToken(DAI_ADDRESS, 1000000n, 1, { symbol: "DAI", decimals: 18 })],
      outputToken: makeToken(USDC_ETHEREUM, 500000n, 1),
    });

    const step2 = makeStep({
      id: "step-2",
      type: "bridge",
      status: "skipped",
      inputTokens: [makeToken(USDC_ETHEREUM, 500000n, 1, { provenance: "step-1" })],
      outputToken: makeToken(USDC_ETHEREUM, 500000n, 10),
    });

    // Branch B: step-3 -> step-4 (both succeed, step-4 is final)
    const step3 = makeStep({
      id: "step-3",
      chainId: 137,
      inputTokens: [makeToken(DAI_ADDRESS, 2000000n, 137, { symbol: "DAI", decimals: 18 })],
      outputToken: makeToken(USDC_ETHEREUM, 800000n, 137),
    });

    const step4 = makeStep({
      id: "step-4",
      type: "bridge",
      chainId: 137,
      inputTokens: [makeToken(USDC_ETHEREUM, 800000n, 137, { provenance: "step-3" })],
      outputToken: makeToken(USDC_ETHEREUM, 800000n, 10),
    });

    // Branch C: step-5 (succeeds, is final)
    const step5 = makeStep({
      id: "step-5",
      chainId: 10,
      inputTokens: [makeToken(WBTC_ADDRESS, 100000n, 10, { symbol: "WBTC", decimals: 8 })],
      outputToken: makeToken(USDC_ETHEREUM, 300000n, 10),
    });

    const state = makeState({
      status: "partial",
      plan: [step1, step2, step3, step4, step5],
      sourceTokens: [
        makeToken(DAI_ADDRESS, 1000000n, 1, { symbol: "DAI", decimals: 18 }),
        makeToken(DAI_ADDRESS, 2000000n, 137, { symbol: "DAI", decimals: 18 }),
        makeToken(WBTC_ADDRESS, 100000n, 10, { symbol: "WBTC", decimals: 8 }),
      ],
      destinationToken: makeToken(USDC_ETHEREUM, 0n, 10),
      hasSubsequentExecution: true,
    });

    render(<CompletionStage state={state} onClose={vi.fn()} />);

    expect(screen.getByText("Consolidation Partially Completed")).toBeInTheDocument();
    expect(screen.getByText("Final Token").parentElement).toBeInTheDocument();
    expect(screen.getAllByTestId("token-display-root").length).toBeGreaterThanOrEqual(4);
  });

  test("no successful steps - shows empty destination tokens", () => {
    const step1 = makeStep({
      id: "step-1",
      status: "failed",
      inputTokens: [makeToken(DAI_ADDRESS, 1000000n, 1, { symbol: "DAI", decimals: 18 })],
      outputToken: makeToken(USDC_ETHEREUM, 500000n, 1),
    });

    const step2 = makeStep({
      id: "step-2",
      type: "bridge",
      status: "skipped",
      inputTokens: [makeToken(USDC_ETHEREUM, 500000n, 1, { provenance: "step-1" })],
      outputToken: makeToken(USDC_ETHEREUM, 500000n, 10),
    });

    const state = makeState({
      status: "partial",
      plan: [step1, step2],
      sourceTokens: [makeToken(DAI_ADDRESS, 1000000n, 1, { symbol: "DAI", decimals: 18 })],
      destinationToken: makeToken(USDC_ETHEREUM, 0n, 10),
      hasSubsequentExecution: true,
    });

    render(<CompletionStage state={state} onClose={vi.fn()} />);

    expect(screen.getByText("Consolidation Partially Completed")).toBeInTheDocument();
    expect(screen.getByText("Source Tokens").parentElement).toBeInTheDocument();
    expect(screen.getByText("Final Token").parentElement).toBeInTheDocument();
  });

  test("bridge and claim with failed final swap - shows only claim output, not attestation", () => {
    // When bridging and swapping fails, show only the claim step's output, not attestation
    const step1 = makeStep({
      id: "step-1",
      inputTokens: [makeToken(DAI_ADDRESS, 1000000n, 1, { symbol: "DAI", decimals: 18 })],
      outputToken: makeToken(USDC_ETHEREUM, 500000n, 1, { provenance: "step-1" }),
    });

    const step2 = makeStep({
      id: "step-2",
      type: "bridge",
      inputTokens: [makeToken(USDC_ETHEREUM, 500000n, 1, { provenance: "step-1" })],
      outputToken: makeToken(USDC_ETHEREUM, 500000n, 10, { provenance: "step-2" }),
    });

    const step3 = makeStep({
      id: "step-3",
      type: "attestation",
      chainId: 10,
      inputTokens: [makeToken(USDC_ETHEREUM, 500000n, 10, { provenance: "step-2" })],
      outputToken: makeToken(USDC_ETHEREUM, 500000n, 10, { provenance: "step-3" }),
    });

    const step4 = makeStep({
      id: "step-4",
      type: "claim",
      chainId: 10,
      inputTokens: [makeToken(USDC_ETHEREUM, 500000n, 10, { provenance: "step-2" })],
      outputToken: makeToken(USDC_ETHEREUM, 500000n, 10, { provenance: "step-4" }),
    });

    const step5 = makeStep({
      id: "step-5",
      status: "failed",
      chainId: 10,
      inputTokens: [makeToken(USDC_ETHEREUM, 500000n, 10, { provenance: "step-4" })],
      outputToken: makeToken(WBTC_ADDRESS, 800000n, 10, { symbol: "WBTC", decimals: 8 }),
    });

    const state = makeState({
      status: "partial",
      plan: [step1, step2, step3, step4, step5],
      sourceTokens: [makeToken(DAI_ADDRESS, 1000000n, 1, { symbol: "DAI", decimals: 18 })],
      destinationToken: makeToken(WBTC_ADDRESS, 0n, 10, { symbol: "WBTC", decimals: 8 }),
      hasSubsequentExecution: true,
    });

    render(<CompletionStage state={state} onClose={vi.fn()} />);

    expect(screen.getByText("Consolidation Partially Completed")).toBeInTheDocument();
    expect(screen.getByText("Final Tokens").parentElement).toBeInTheDocument();
    // 1 source token + 2 final tokens (0 WBTC destination + USDC unintended) = 3
    expect(screen.getAllByTestId("token-display-root")).toHaveLength(3);
  });

  test("bridge USDC and swap to WBTC - bridge succeeds, swap fails - shows 0 WBTC and USDC unintended", () => {
    // Bridge USDC (arb) -> USDC (pol) works, swap to WBTC (pol) fails
    // Should show: 0 WBTC (destination) first, then USDC (unintended)
    const step1 = makeStep({
      id: "step-1",
      type: "bridge",
      chainId: 42161,
      inputTokens: [makeToken(USDC_ETHEREUM, 1000000n, 42161)],
      outputToken: makeToken(USDC_ETHEREUM, 1000000n, 137, { provenance: "step-1" }),
    });

    const step2 = makeStep({
      id: "step-2",
      type: "attestation",
      chainId: 137,
      inputTokens: [makeToken(USDC_ETHEREUM, 1000000n, 137, { provenance: "step-1" })],
      outputToken: makeToken(USDC_ETHEREUM, 1000000n, 137, { provenance: "step-2" }),
    });

    const step3 = makeStep({
      id: "step-3",
      type: "claim",
      chainId: 137,
      inputTokens: [makeToken(USDC_ETHEREUM, 1000000n, 137, { provenance: "step-1" })],
      outputToken: makeToken(USDC_ETHEREUM, 1000000n, 137, { provenance: "step-3" }),
    });

    const step4 = makeStep({
      id: "step-4",
      status: "failed",
      chainId: 137,
      inputTokens: [makeToken(USDC_ETHEREUM, 1000000n, 137, { provenance: "step-3" })],
      outputToken: makeToken(WBTC_ADDRESS, 50000n, 137, { symbol: "WBTC", decimals: 8 }),
    });

    const state = makeState({
      status: "partial",
      plan: [step1, step2, step3, step4],
      sourceTokens: [makeToken(USDC_ETHEREUM, 1000000n, 42161)],
      destinationToken: makeToken(WBTC_ADDRESS, 0n, 137, { symbol: "WBTC", decimals: 8 }),
      hasSubsequentExecution: true,
    });

    render(<CompletionStage state={state} onClose={vi.fn()} />);

    expect(screen.getByText("Consolidation Partially Completed")).toBeInTheDocument();
    expect(screen.getByText("Final Tokens").parentElement).toBeInTheDocument();
    // 1 source + 2 final tokens (0 WBTC destination + 1 USDC unintended) = 3
    expect(screen.getAllByTestId("token-display-root")).toHaveLength(3);
    expect(screen.getByText("Unintended")).toBeInTheDocument();
  });

  test("simple transfer - same chain USDC transfer completes successfully", () => {
    // Transfer USDC from wallet 2 to wallet 1 on Arbitrum
    // Should show the consolidated USDC amount at the destination
    const WALLET_1 = "0x1111111111111111111111111111111111111111" as Address;
    const WALLET_2 = "0x2222222222222222222222222222222222222222" as Address;

    const step1 = makeStep({
      id: "step-1",
      type: "transfer",
      chainId: 42161,
      inputTokens: [makeToken(USDC_ETHEREUM, 500000n, 42161, { walletAddress: WALLET_2 })],
      outputToken: makeToken(USDC_ETHEREUM, 500000n, 42161, { walletAddress: WALLET_1, provenance: "step-1" }),
    });

    const state = makeState({
      plan: [step1],
      sourceTokens: [
        makeToken(USDC_ETHEREUM, 1000000n, 42161, { walletAddress: WALLET_1 }), // 1 USDC already at wallet 1
        makeToken(USDC_ETHEREUM, 500000n, 42161, { walletAddress: WALLET_2 }), // 0.5 USDC from wallet 2
      ],
      destinationToken: makeToken(USDC_ETHEREUM, 0n, 42161, { walletAddress: WALLET_1 }),
    });

    render(<CompletionStage state={state} onClose={vi.fn()} />);

    expect(screen.getByText("Consolidation Successful!")).toBeInTheDocument();
    expect(screen.getByText("Source Tokens").parentElement).toBeInTheDocument();
    expect(screen.getByText("Final Token").parentElement).toBeInTheDocument();
    expect(screen.getAllByTestId("token-display-root")).toHaveLength(3);

    // Final token should show TOTAL: 1 USDC + 0.5 USDC transferred = 1.5 USDC
    const tokenAmounts = screen.getAllByTestId("token-display-amount");
    expect(tokenAmounts[2].textContent).toBe("1500000");
  });

  test("bridge+claim and swap both producing USDC - shows total consolidated amount", () => {
    // Bridge 1 USDC into Arbitrum and swap 0.00001 WBTC to 1 USDC on Arbitrum
    // Final result should show 2 USDC total
    const step1 = makeStep({
      id: "step-1",
      type: "bridge",
      inputTokens: [makeToken(USDC_ETHEREUM, 1000000n, 1)],
      outputToken: makeToken(USDC_ETHEREUM, 1000000n, 42161, { provenance: "step-1" }),
    });

    const step2 = makeStep({
      id: "step-2",
      type: "attestation",
      chainId: 42161,
      inputTokens: [makeToken(USDC_ETHEREUM, 1000000n, 42161, { provenance: "step-1" })],
      outputToken: makeToken(USDC_ETHEREUM, 1000000n, 42161, { provenance: "step-2" }),
    });

    const step3 = makeStep({
      id: "step-3",
      type: "claim",
      chainId: 42161,
      inputTokens: [makeToken(USDC_ETHEREUM, 1000000n, 42161, { provenance: "step-1" })],
      outputToken: makeToken(USDC_ETHEREUM, 1000000n, 42161, { provenance: "step-3" }),
    });

    const step4 = makeStep({
      id: "step-4",
      chainId: 42161,
      inputTokens: [makeToken(WBTC_ADDRESS, 1000n, 42161, { symbol: "WBTC", decimals: 8 })],
      outputToken: makeToken(USDC_ETHEREUM, 1000000n, 42161, { provenance: "step-4" }),
    });

    const state = makeState({
      plan: [step1, step2, step3, step4],
      sourceTokens: [
        makeToken(USDC_ETHEREUM, 1000000n, 1), // 1 USDC on Ethereum
        makeToken(WBTC_ADDRESS, 1000n, 42161, { symbol: "WBTC", decimals: 8 }), // 0.00001 WBTC on Arbitrum
      ],
      destinationToken: makeToken(USDC_ETHEREUM, 0n, 42161),
    });

    render(<CompletionStage state={state} onClose={vi.fn()} />);

    expect(screen.getByText("Consolidation Successful!")).toBeInTheDocument();
    expect(screen.getByText("Final Token").parentElement).toBeInTheDocument();
    expect(screen.getAllByTestId("token-display-root")).toHaveLength(3);

    // Final token should show 2 USDC (1 from bridge+claim + 1 from swap)
    const tokenAmounts = screen.getAllByTestId("token-display-amount");
    expect(tokenAmounts[2].textContent).toBe("2000000");
  });
});
