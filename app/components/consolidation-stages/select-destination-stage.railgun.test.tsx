/**
 * Reproduction of the consolidate-modal destination step with a Railgun 0zk
 * destination: real SelectDestinationStage + real TokenSelector + real
 * RailgunPoolWarning + real price/currency providers. Only the network edges
 * are mocked (pool balanceOf, Odos prices, CoinGecko rates).
 *
 * Live data (2026-06-10): the Arbitrum Railgun WBTC pool holds ~1.09 WBTC
 * (~$67.5k), well below LOW_PRIVACY_TVL_USD — the warning MUST appear.
 */

import { bech32m } from "@scure/base";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { CurrencyProvider } from "~/context/currency-provider";
import { TokenPriceProvider } from "~/context/token-price-provider";
import { WBTC } from "~/data/token-contracts";
import type { DestinationSelection } from "./select-destination-stage";
import { SelectDestinationStage } from "./select-destination-stage";

vi.mock("wagmi", () => ({
  useAccount: vi.fn(() => ({ addresses: [] })),
  usePublicClient: vi.fn(() => ({
    // Metadata enrichment isn't needed (options are pre-formatted); reject so
    // any unexpected on-chain read fails loudly inside its try/catch.
    readContract: vi.fn(() => Promise.reject(new Error("no rpc in test"))),
  })),
  // Used by TokenLabel via useToken for on-chain metadata; not needed here.
  useReadContracts: vi.fn(() => ({ data: undefined })),
}));

// The address picker pulls in wallet UI we don't need for this repro.
vi.mock("~/components/address", () => ({
  AddressSelector: ({ value }: { value: string }) => <div data-testid="address-selector">{value}</div>,
}));

vi.mock("~/lib/railgun", async () => {
  const actual = await vi.importActual<typeof import("~/lib/railgun")>("~/lib/railgun");
  return { ...actual, getRailgunPoolBalance: vi.fn() };
});

vi.mock("~/lib/api/odos", async () => {
  const actual = await vi.importActual<typeof import("~/lib/api/odos")>("~/lib/api/odos");
  return { ...actual, fetchOdosPrices: vi.fn() };
});

vi.mock("~/lib/api/coingecko", async () => {
  const actual = await vi.importActual<typeof import("~/lib/api/coingecko")>("~/lib/api/coingecko");
  return { ...actual, fetchCoinGeckoExchangeRates: vi.fn() };
});

const { getRailgunPoolBalance, isRailgunAddress } = await import("~/lib/railgun");
const { fetchOdosPrices, odosPriceKey } = await import("~/lib/api/odos");
const { fetchCoinGeckoExchangeRates } = await import("~/lib/api/coingecko");

const mockedBalance = vi.mocked(getRailgunPoolBalance);
const mockedPrices = vi.mocked(fetchOdosPrices);
const mockedRates = vi.mocked(fetchCoinGeckoExchangeRates);

const ARBITRUM = 42161;
const WBTC_ARBITRUM = WBTC[ARBITRUM];
// Live values observed on 2026-06-10.
const WBTC_POOL_BALANCE = 109_107_138n; // ~1.09 WBTC (8 decimals)
const WBTC_PRICE = 61_848.67;

/**
 * Mirror of decodeRailgunAddress's wire format (version ‖ mpk ‖ networkID^“railgun” ‖ vpk)
 * so the test can mint a syntactically valid all-chains 0zk address.
 */
function makeRailgunAddress(): string {
  const data = new Uint8Array(73);
  data[0] = 1; // version
  data.fill(0x42, 1, 33); // masterPublicKey (arbitrary)
  const networkId = new Uint8Array(8).fill(0xff); // all-chains
  const mask = new TextEncoder().encode("railgun");
  for (let i = 0; i < mask.length; i++) networkId[i] ^= mask[i];
  data.set(networkId, 33);
  data.fill(0x24, 41, 73); // viewingPublicKey (arbitrary)
  return bech32m.encode("0zk", bech32m.toWords(data), 127);
}

const ZK_ADDRESS = makeRailgunAddress();

function Harness({ initial }: { initial: DestinationSelection }) {
  const [value, setValue] = React.useState(initial);
  return <SelectDestinationStage value={value} onChange={setValue} />;
}

function renderStage(initial: DestinationSelection) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  return {
    user: userEvent.setup(),
    ...render(
      <QueryClientProvider client={queryClient}>
        <CurrencyProvider>
          <TokenPriceProvider>
            <Harness initial={initial} />
          </TokenPriceProvider>
        </CurrencyProvider>
      </QueryClientProvider>,
    ),
  };
}

beforeEach(() => {
  mockedBalance.mockReset();
  mockedBalance.mockResolvedValue(WBTC_POOL_BALANCE);
  mockedPrices.mockReset();
  mockedPrices.mockResolvedValue(new Map([[odosPriceKey(ARBITRUM, WBTC_ARBITRUM), WBTC_PRICE]]));
  mockedRates.mockReset();
  mockedRates.mockResolvedValue({ USD: 1 });
});

describe("destination stage with a 0zk address on Arbitrum", () => {
  test("the minted 0zk fixture is accepted by isRailgunAddress", () => {
    expect(isRailgunAddress(ZK_ADDRESS)).toBe(true);
  });

  test("warning appears when WBTC is already selected", async () => {
    renderStage({
      walletAddress: ZK_ADDRESS,
      chainId: ARBITRUM,
      tokenInfo: { address: WBTC_ARBITRUM, decimals: 8, symbol: "WBTC" },
    });

    expect(await screen.findByText("Low privacy pool")).toBeInTheDocument();
    // ~1.09 WBTC x $61,848 = ~$67.5k
    expect(screen.getByText(/67,48\d/)).toBeInTheDocument();
  });

  test("warning appears after picking WBTC through the real TokenSelector", async () => {
    const { user } = renderStage({ walletAddress: ZK_ADDRESS, chainId: ARBITRUM });

    // Open the token combobox and pick WBTC from the Railgun token options.
    await user.click(screen.getByRole("button"));
    await user.click(await screen.findByText("WBTC"));

    expect(await screen.findByText("Low privacy pool")).toBeInTheDocument();
  });

  test("beta-acknowledgment checkbox is shown for a 0zk destination", () => {
    renderStage({ walletAddress: ZK_ADDRESS, chainId: ARBITRUM });

    expect(screen.getByLabelText(/beta and that I use it at my own risk/i)).toBeInTheDocument();
  });

  test("beta-acknowledgment checkbox is hidden for a public 0x destination", () => {
    renderStage({ walletAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", chainId: ARBITRUM });

    expect(screen.queryByLabelText(/beta and that I use it at my own risk/i)).not.toBeInTheDocument();
  });
});
