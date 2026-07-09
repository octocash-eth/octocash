import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, renderHook, screen, waitFor } from "@testing-library/react";
import type * as React from "react";
import { parseUnits } from "viem";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { CurrencyProvider } from "~/context/currency-provider";
import { TokenPriceProvider } from "~/context/token-price-provider";
import { WETH } from "~/data/token-contracts";
import { RailgunPoolWarning, useRailgunPoolTvl } from "./railgun-pool-warning";

// Mock the on-chain pool balance read so no RPC is hit.
vi.mock("~/lib/railgun", async () => {
  const actual = await vi.importActual<typeof import("~/lib/railgun")>("~/lib/railgun");
  return {
    ...actual,
    getRailgunPoolBalance: vi.fn(),
  };
});

// Mock the Delora price API that feeds <TokenPriceProvider>.
vi.mock("~/lib/api/delora", async () => {
  const actual = await vi.importActual<typeof import("~/lib/api/delora")>("~/lib/api/delora");
  return {
    ...actual,
    fetchDeloraPrices: vi.fn(),
  };
});

// CurrencyProvider fetches exchange rates on mount; keep it offline.
vi.mock("~/lib/api/coingecko", async () => {
  const actual = await vi.importActual<typeof import("~/lib/api/coingecko")>("~/lib/api/coingecko");
  return {
    ...actual,
    fetchCoinGeckoExchangeRates: vi.fn(),
  };
});

const { getRailgunPoolBalance } = await import("~/lib/railgun");
const { fetchDeloraPrices, deloraPriceKey } = await import("~/lib/api/delora");
const { fetchCoinGeckoExchangeRates } = await import("~/lib/api/coingecko");

const mockedBalance = vi.mocked(getRailgunPoolBalance);
const mockedPrices = vi.mocked(fetchDeloraPrices);
const mockedRates = vi.mocked(fetchCoinGeckoExchangeRates);

const MAINNET = 1;
// Checksummed (mixed-case) address, exactly as getRailgunTokenOptions passes it
// to the component. The price registry keys are lowercased internally — this
// test guards that the case mismatch doesn't break the price lookup.
const WETH_MAINNET = WETH[MAINNET];
const WETH_DECIMALS = 18;
const WETH_PRICE = 2500;

function makeWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
    },
  });
  function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <CurrencyProvider>
          <TokenPriceProvider>{children}</TokenPriceProvider>
        </CurrencyProvider>
      </QueryClientProvider>
    );
  }
  return { Wrapper, queryClient };
}

/** Mock a WETH price response keyed the way fetchDeloraPrices really keys it. */
function mockWethPrice(price = WETH_PRICE) {
  mockedPrices.mockResolvedValue(new Map([[deloraPriceKey(MAINNET, WETH_MAINNET), price]]));
}

beforeEach(() => {
  mockedBalance.mockReset();
  mockedPrices.mockReset();
  mockedPrices.mockResolvedValue(new Map());
  mockedRates.mockReset();
  mockedRates.mockResolvedValue({ USD: 1 });
});

describe("useRailgunPoolTvl", () => {
  test("combines pool balance and Delora price into a USD TVL", async () => {
    // 100 WETH x $2500 = $250k.
    mockedBalance.mockResolvedValue(parseUnits("100", WETH_DECIMALS));
    mockWethPrice();
    const { Wrapper } = makeWrapper();

    const { result } = renderHook(() => useRailgunPoolTvl(MAINNET, WETH_MAINNET, WETH_DECIMALS), {
      wrapper: Wrapper,
    });

    // tvlUsd stays undefined until BOTH the balance and the price resolve.
    expect(result.current.tvlUsd).toBeUndefined();

    await waitFor(() => expect(result.current.tvlUsd).toBe(250_000));
    expect(result.current.isLowPrivacy).toBe(true);
  });

  test("flags isLowPrivacy=false for a pool above the threshold", async () => {
    // 1000 WETH x $2500 = $2.5M >= $1M threshold.
    mockedBalance.mockResolvedValue(parseUnits("1000", WETH_DECIMALS));
    mockWethPrice();
    const { Wrapper } = makeWrapper();

    const { result } = renderHook(() => useRailgunPoolTvl(MAINNET, WETH_MAINNET, WETH_DECIMALS), {
      wrapper: Wrapper,
    });

    await waitFor(() => expect(result.current.tvlUsd).toBe(2_500_000));
    expect(result.current.isLowPrivacy).toBe(false);
  });

  test("stays undefined when the price never arrives", async () => {
    mockedBalance.mockResolvedValue(parseUnits("100", WETH_DECIMALS));
    // mockedPrices resolves to an empty map (default from beforeEach).
    const { Wrapper } = makeWrapper();

    const { result } = renderHook(() => useRailgunPoolTvl(MAINNET, WETH_MAINNET, WETH_DECIMALS), {
      wrapper: Wrapper,
    });

    await waitFor(() => expect(mockedBalance).toHaveBeenCalled());
    await waitFor(() => expect(mockedPrices).toHaveBeenCalled());

    expect(result.current.tvlUsd).toBeUndefined();
    expect(result.current.isLowPrivacy).toBe(false);
  });

  test("reports isUnverifiable when the balance read fails", async () => {
    mockedBalance.mockRejectedValue(new Error("RPC down"));
    mockWethPrice();
    const { Wrapper } = makeWrapper();

    const { result } = renderHook(() => useRailgunPoolTvl(MAINNET, WETH_MAINNET, WETH_DECIMALS), {
      wrapper: Wrapper,
    });

    expect(result.current.isUnverifiable).toBe(false);
    await waitFor(() => expect(result.current.isUnverifiable).toBe(true));
    expect(result.current.tvlUsd).toBeUndefined();
    expect(result.current.isLowPrivacy).toBe(false);
  });

  test("does not fetch anything on a non-Railgun chain", async () => {
    const { Wrapper } = makeWrapper();

    const { result } = renderHook(
      // Base (8453) is not in RAILGUN_SUPPORTED_CHAINS.
      () => useRailgunPoolTvl(8453, WETH_MAINNET, WETH_DECIMALS),
      { wrapper: Wrapper },
    );

    await new Promise((r) => setTimeout(r, 20));
    expect(mockedBalance).not.toHaveBeenCalled();
    expect(result.current.tvlUsd).toBeUndefined();
    expect(result.current.isLowPrivacy).toBe(false);
  });
});

describe("RailgunPoolWarning", () => {
  function renderWarning() {
    const { Wrapper } = makeWrapper();
    return render(
      <RailgunPoolWarning
        chainId={MAINNET}
        token={WETH_MAINNET}
        symbol="WETH"
        decimals={WETH_DECIMALS}
        chainName="Ethereum"
      />,
      { wrapper: Wrapper },
    );
  }

  test("shows the warning with the formatted TVL when the pool is small", async () => {
    mockedBalance.mockResolvedValue(parseUnits("100", WETH_DECIMALS));
    mockWethPrice();

    renderWarning();

    expect(await screen.findByText("Low privacy pool")).toBeInTheDocument();
    expect(screen.getByText(/250,000/)).toBeInTheDocument();
    expect(screen.getByText(/WETH/)).toBeInTheDocument();
    expect(screen.getByText(/Ethereum/)).toBeInTheDocument();
  });

  test("renders nothing when the pool is large enough", async () => {
    mockedBalance.mockResolvedValue(parseUnits("1000", WETH_DECIMALS));
    mockWethPrice();

    renderWarning();

    // Wait for both fetches so the "no warning" state is the settled one.
    await waitFor(() => expect(mockedBalance).toHaveBeenCalled());
    await waitFor(() => expect(mockedPrices).toHaveBeenCalled());

    expect(screen.queryByText("Low privacy pool")).not.toBeInTheDocument();
  });

  test("fails closed with an unverified-pool alert when the balance read fails", async () => {
    mockedBalance.mockRejectedValue(new Error("RPC down"));
    mockWethPrice();

    renderWarning();

    expect(await screen.findByText("Pool size unverified")).toBeInTheDocument();
    expect(screen.queryByText("Low privacy pool")).not.toBeInTheDocument();
  });

  test("renders nothing while the price is missing", async () => {
    mockedBalance.mockResolvedValue(parseUnits("100", WETH_DECIMALS));
    // No price returned: TVL can't be computed, so no warning should show.

    renderWarning();

    await waitFor(() => expect(mockedPrices).toHaveBeenCalled());
    expect(screen.queryByText("Low privacy pool")).not.toBeInTheDocument();
  });
});
