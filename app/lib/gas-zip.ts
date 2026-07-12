import type { Address, Hex } from "viem";
import type { GasRefuelQuote } from "./gas-refuel";

const GASZIP_API_BASE = "https://backend.gas.zip/v2";

/**
 * Gas.zip "Direct Deposit v2" contract — the same address on every chain it
 * supports (verified on Ethereum, Optimism, Arbitrum, Base and others). A
 * refuel is a plain native transfer to this address whose calldata encodes the
 * outbound chain(s) and recipient; Gas.zip's relayers deliver native on the
 * destination, typically within seconds.
 * https://dev.gas.zip/gas/code-examples/eoa/directDeposit
 */
export const GASZIP_DIRECT_DEPOSIT: Address = "0x391E7C679d29bD940d63be94AD22A25d25b5A604";

interface GasZipQuoteEntry {
  chain: number;
  expected?: number; // delivered wei (JSON number — see toBigIntWei)
  error?: string;
}

interface GasZipQuoteResponse {
  quotes?: GasZipQuoteEntry[];
  calldata?: Hex;
  error?: string;
  expires?: number;
}

/**
 * Gas.zip reports wei amounts as JSON numbers, which lose sub-1024-wei
 * precision above 2^53 (e.g. an 8 POL delivery). The error is economically
 * irrelevant for a gas refuel; floor to be deterministic.
 */
function toBigIntWei(value: number): bigint {
  return BigInt(Math.floor(value));
}

/**
 * Fetch a Gas.zip quote for depositing `depositWei` native on `fromChainId`
 * to be delivered as native on `toChainId`. Passing `from`/`to` makes the
 * backend return ready-to-send Direct Deposit calldata and a short-lived
 * guaranteed output.
 */
async function fetchGasZipQuote(
  fromChainId: number,
  toChainId: number,
  depositWei: bigint,
  from: Address,
  to: Address,
): Promise<{ expectedWei: bigint; calldata: Hex }> {
  const params = new URLSearchParams({ from, to });
  const url = `${GASZIP_API_BASE}/quotes/${fromChainId}/${depositWei.toString()}/${toChainId}?${params}`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`GasZipError: Quote failed (${res.status}): ${await res.text()}`);
  }

  const body = (await res.json()) as GasZipQuoteResponse;
  if (body.error) {
    throw new Error(`GasZipError: ${body.error}`);
  }
  const entry = body.quotes?.find((q) => q.chain === toChainId) ?? body.quotes?.[0];
  if (!entry || entry.error || entry.expected === undefined) {
    throw new Error(`GasZipError: No route to chain ${toChainId}${entry?.error ? ` (${entry.error})` : ""}`);
  }
  if (!body.calldata) {
    throw new Error("GasZipError: Quote returned no deposit calldata");
  }

  return { expectedWei: toBigIntWei(entry.expected), calldata: body.calldata };
}

/**
 * Get a Gas.zip refuel quote targeting a specific native output on the
 * destination chain. Two-step probe: quote with `deposit = target` to learn
 * the effective rate (cross-token pairs like ETH→POL included), then re-quote
 * with a 20% buffer (same-token) or a proportionally scaled deposit
 * (cross-token) so `expectedWei` covers the target.
 */
export async function getGasZipRefuelQuote(
  fromChainId: number,
  toChainId: number,
  targetOutputWei: bigint,
  from: Address,
  to: Address,
): Promise<GasRefuelQuote> {
  const probe = await fetchGasZipQuote(fromChainId, toChainId, targetOutputWei, from, to);
  const ratio = (probe.expectedWei * 100n) / targetOutputWei;

  const depositWei =
    ratio >= 90n && ratio <= 110n
      ? (targetOutputWei * 120n) / 100n
      : (targetOutputWei * targetOutputWei * 120n) / (probe.expectedWei * 100n);

  const quote = await fetchGasZipQuote(fromChainId, toChainId, depositWei, from, to);

  return {
    provider: "gaszip",
    fromChainId,
    toChainId,
    depositWei,
    expectedWei: quote.expectedWei,
    // Gas.zip's `expected` already nets out its fee; a modest haircut absorbs
    // rate movement between quote and delivery for the balance-based wait.
    minDeliveredWei: (quote.expectedWei * 80n) / 100n,
    tx: { to: GASZIP_DIRECT_DEPOSIT, data: quote.calldata, value: depositWei },
  };
}
