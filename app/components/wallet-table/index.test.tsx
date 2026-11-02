import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Address } from "viem";
import { zeroAddress } from "viem";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  type DeloraCatalog,
  discoverZerionTokens,
  fetchDeloraTokensForChain,
  fetchTokenBalances,
  type TokenRef,
} from "~/lib/api";
import type { ConsolidationState, TokenAmount } from "~/lib/types";
import { WalletTable } from ".";

vi.mock("~/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/api")>()),
  fetchDeloraTokensForChain: vi.fn(),
  fetchTokenBalances: vi.fn(),
  discoverZerionTokens: vi.fn(),
  checkDeloraRoutableToUsdc: vi.fn().mockResolvedValue(false),
}));
vi.mock("~/context/token-price-provider", () => ({
  usePriceMap: () => ({ priceFor: () => 1, isPending: false }),
  useRegisterPrices: () => {},
}));
vi.mock("~/components/consolidate-tokens-modal", () => ({ ConsolidateTokensModal: () => null }));
vi.mock("./data-table", () => ({
  DataTable: ({
    data,
    onRefresh,
    isRefreshing,
  }: {
    data: TokenAmount[];
    onRefresh: () => void;
    isRefreshing: boolean;
  }) => (
    <div>
      <span data-testid="refreshing">{String(isRefreshing)}</span>
      <button type="button" onClick={onRefresh}>
        refresh
      </button>
      <ul>
        {data.map((t) => (
          <li key={`${t.chainId}:${t.token}:${t.walletAddress}`}>{`${t.chainId}:${t.symbol}:${t.walletAddress}`}</li>
        ))}
      </ul>
    </div>
  ),
}));
let records: ConsolidationState[] = [];
vi.mock("~/hooks/use-consolidation-records", () => ({
  useConsolidationRecords: () => ({ consolidations: records }),
}));

const W1 = "0x1111111111111111111111111111111111111111" as Address;
const W2 = "0x2222222222222222222222222222222222222222" as Address;
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address;
const RARE = "0x00000000000000000000000000000000000000Ee" as Address; // not in the catalog
const SWAPPED = "0x00000000000000000000000000000000000000Cc" as Address; // a past consolidation output

const mainnetCatalog: DeloraCatalog = new Map([
  [zeroAddress, { address: zeroAddress, symbol: "ETH", name: "Ether", decimals: 18, priceUSD: 2000 }],
  [USDC.toLowerCase(), { address: USDC, symbol: "USDC", name: "USD Coin", decimals: 6, priceUSD: 1 }],
]);

/** Fake chain: every wallet holds 1 unit of every scanned mainnet token. */
function holdEverything(chainId: number, wallets: readonly Address[], refs: readonly TokenRef[]) {
  if (chainId !== 1) return Promise.resolve([]);
  return Promise.resolve(
    wallets.flatMap((w) =>
      refs.map((r) => ({
        token: r.token,
        amount: 1n,
        chainId,
        walletAddress: w,
        symbol: r.symbol ?? "?",
        decimals: r.decimals ?? 0,
      })),
    ),
  );
}

function renderTable(addresses: Address[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui = (a: Address[]) => (
    <QueryClientProvider client={client}>
      <WalletTable connectedAddresses={a} />
    </QueryClientProvider>
  );
  const view = render(ui(addresses));
  return { ...view, rerenderWith: (a: Address[]) => view.rerender(ui(a)) };
}

/** Token addresses passed to the extras scan for mainnet, latest call. */
const lastMainnetExtras = () =>
  vi
    .mocked(fetchTokenBalances)
    .mock.calls.filter(([chainId, , refs]) => chainId === 1 && !refs.some((r) => r.token === USDC))
    .at(-1)?.[2]
    .map((r) => r.token);

describe("WalletTable balance sourcing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    records = [];
    vi.mocked(fetchDeloraTokensForChain).mockImplementation((chainId) =>
      Promise.resolve(chainId === 1 ? mainnetCatalog : new Map()),
    );
    vi.mocked(fetchTokenBalances).mockImplementation(holdEverything);
    vi.mocked(discoverZerionTokens).mockResolvedValue([]);
  });

  test("shows catalog balances read over RPC for every wallet", async () => {
    renderTable([W1, W2]);

    expect(await screen.findByText(`1:USDC:${W1}`)).toBeInTheDocument();
    expect(screen.getByText(`1:USDC:${W2}`)).toBeInTheDocument();
    expect(screen.getByText(`1:ETH:${W1}`)).toBeInTheDocument();
    const catalogScan = vi.mocked(fetchTokenBalances).mock.calls.find(([c, , r]) => c === 1 && r.length === 2);
    expect(catalogScan?.[1]).toEqual([W1, W2]);
  });

  test("asks Zerion once per wallet and scans what it discovers outside the catalog", async () => {
    vi.mocked(discoverZerionTokens).mockImplementation(async (a) =>
      a === W1 ? [{ chainId: 1, token: RARE, symbol: "RARE", name: "Rare", decimals: 18 }] : [],
    );
    renderTable([W1, W2]);

    await waitFor(() => expect(lastMainnetExtras()).toContain(RARE));
    expect(discoverZerionTokens).toHaveBeenCalledTimes(2);
    expect(
      vi
        .mocked(discoverZerionTokens)
        .mock.calls.map(([a]) => a)
        .sort(),
    ).toEqual([W1, W2]);
    // Catalog tokens are never rescanned as extras.
    expect(lastMainnetExtras()).not.toContain(USDC);
  });

  test("refresh rescans over RPC without asking Zerion again", async () => {
    renderTable([W1]);
    await screen.findByText(`1:USDC:${W1}`);
    const scansBefore = vi.mocked(fetchTokenBalances).mock.calls.length;

    await act(async () => {
      fireEvent.click(screen.getByText("refresh"));
    });

    await waitFor(() => expect(vi.mocked(fetchTokenBalances).mock.calls.length).toBeGreaterThan(scansBefore));
    expect(discoverZerionTokens).toHaveBeenCalledTimes(1);
  });

  test("tokens from recorded consolidations are on the must-check list", async () => {
    records = [
      {
        destinationToken: { chainId: 1, token: SWAPPED, walletAddress: W1, symbol: "SWP", decimals: 18 },
        sourceTokens: [],
      } as unknown as ConsolidationState,
    ];
    renderTable([W1]);

    await waitFor(() => expect(lastMainnetExtras()).toContain(SWAPPED));
  });

  test("drops rows of a wallet that was disconnected while the rescan runs", async () => {
    const { rerenderWith } = renderTable([W1, W2]);
    await screen.findByText(`1:USDC:${W2}`);

    // Hold the next scan so the previous data is shown as placeholder.
    vi.mocked(fetchTokenBalances).mockImplementation(() => new Promise(() => {}));
    rerenderWith([W1]);

    await waitFor(() => expect(screen.queryByText(`1:USDC:${W2}`)).not.toBeInTheDocument());
    expect(screen.getByText(`1:USDC:${W1}`)).toBeInTheDocument();
  });

  test("a hung Zerion request neither blocks balances nor keeps the spinner going", async () => {
    vi.mocked(discoverZerionTokens).mockImplementation(() => new Promise(() => {}));
    renderTable([W1]);

    expect(await screen.findByText(`1:USDC:${W1}`)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("refreshing")).toHaveTextContent("false"));
    // The out-of-catalog pass ran without waiting for discovery.
    expect(
      vi.mocked(fetchTokenBalances).mock.calls.some(([c, , r]) => c === 1 && !r.some((t) => t.token === USDC)),
    ).toBe(true);
  });

  test("still shows balances when Zerion discovery fails", async () => {
    vi.mocked(discoverZerionTokens).mockRejectedValue(new Error("Zerion API error: 429"));
    renderTable([W1]);

    expect(await screen.findByText(`1:USDC:${W1}`)).toBeInTheDocument();
  });
});
