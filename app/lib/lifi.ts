import type { Address, Hex } from "viem";
import { chains } from "~/data/supported-chains";

const LIFI_API_BASE = "https://li.quest/v1";
const NATIVE_TOKEN_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * Bridges whitelisted for gas top-ups. Restricted to fast, relay-style bridges
 * so the cross-chain wait stays well under `pollLiFiTransferStatus`'s timeout
 * (slow liquidity bridges like Stargate would routinely blow past it):
 * - `across`           — fast optimistic relay, typically sub-minute
 * - `relaydepository`  — Relay, ~seconds for small native transfers
 * - `gasZipBridge`     — Gas.zip, purpose-built for native gas refuel
 * Keys verified against `GET https://li.quest/v1/tools`. This is a hard
 * allow-list: a chain pair served by none of these yields a quote failure
 * (surfaced as the existing `LiFiError: Quote failed`), which is the intended
 * trade-off for guaranteeing fast delivery.
 */
const FAST_BRIDGES = ["across", "relaydepository", "gasZipBridge"] as const;

/**
 * Minimum cross-chain top-up target, keyed by the destination chain's native
 * symbol. Bridges reject transfers worth under ~$1 ("Bridge from ETH with
 * fromToken value less than 1 USD") and a sub-$1 native refuel gets eaten by
 * fees ("FEES_HIGHER_THAN_AMOUNT"), so we never request a cross-chain quote
 * below this. The user just receives a little extra — immediately usable —
 * gas on the destination instead of a hard planning failure. Sized to clear
 * ~$1 + fees across plausible price regimes; natives absent from this map
 * (none in supported-chains today) get no floor.
 */
const MIN_CROSS_CHAIN_TARGET_WEI: Record<string, bigint> = {
  ETH: 1_200_000_000_000_000n, // ~0.0012 ETH (≈ $1.8–5 across regimes)
  POL: 8_000_000_000_000_000_000n, // ~8 POL (≈ $1.2–5 across regimes)
};

/**
 * Lower top-up floor that applies only when we route via gas.zip, which
 * accepts deposits as small as $0.25 (https://dev.gas.zip/gas/overview) —
 * far below the ~$1 minimum that Across / Relay enforce. Sized to clear
 * gas.zip's $0.25 minimum + price slippage + their flat fee, so the bridge
 * itself doesn't reject the request; absent natives get no gas.zip floor
 * (which means the gas.zip-first attempt is skipped — no harm, the standard
 * tier still runs).
 */
const MIN_GASZIP_TARGET_WEI: Record<string, bigint> = {
  ETH: 200_000_000_000_000n, // ~0.0002 ETH (≈ $0.30–0.80 across regimes)
  POL: 2_000_000_000_000_000_000n, // ~2 POL    (≈ $0.30–1.00 across regimes)
};

function minCrossChainTargetWei(toChainId: number): bigint {
  const symbol = chains[toChainId as keyof typeof chains]?.nativeCurrency.symbol;
  return (symbol && MIN_CROSS_CHAIN_TARGET_WEI[symbol]) || 0n;
}

function minGasZipTargetWei(toChainId: number): bigint {
  const symbol = chains[toChainId as keyof typeof chains]?.nativeCurrency.symbol;
  return (symbol && MIN_GASZIP_TARGET_WEI[symbol]) || 0n;
}

// ============================================================================
// API Response Types
// ============================================================================

export interface LiFiTransactionRequest {
  value: string;
  to: Address;
  data: Hex;
  from: Address;
  chainId: number;
  gasPrice?: string;
  gasLimit?: string;
}

export interface LiFiQuoteResponse {
  tool: string;
  action: {
    fromChainId: number;
    toChainId: number;
    fromToken: { symbol: string; decimals: number; priceUSD: string };
    toToken: { symbol: string; decimals: number; priceUSD: string };
  };
  estimate: {
    fromAmount: string;
    toAmount: string;
    toAmountMin: string;
  };
  transactionRequest: LiFiTransactionRequest;
}

type LiFiTransferStatus = "NOT_FOUND" | "PENDING" | "DONE" | "FAILED";
type LiFiSubstatus =
  | "WAIT_SOURCE_CONFIRMATIONS"
  | "WAIT_DESTINATION_TRANSACTION"
  | "BRIDGE_NOT_AVAILABLE"
  | "CHAIN_NOT_AVAILABLE"
  | "NOT_PROCESSABLE_REFUND_NEEDED"
  | "REFUND_IN_PROGRESS"
  | "COMPLETED"
  | "PARTIAL"
  | "REFUNDED"
  | "UNKNOWN";

export interface LiFiStatusResponse {
  status: LiFiTransferStatus;
  substatus?: LiFiSubstatus;
  receiving?: {
    txHash?: string;
    amount?: string;
    chainId?: number;
  };
}

// ============================================================================
// API Functions
// ============================================================================

/**
 * Get a LI.FI quote for a native-token-to-native-token cross-chain transfer.
 *
 * @param fromChainId - Source chain ID
 * @param toChainId - Destination chain ID
 * @param fromAmount - Amount to send in source-token wei
 * @param fromAddress - Sender address
 * @param toAddress - Recipient address on destination chain
 * @returns Quote with transactionRequest ready for signing
 */
export async function getLiFiQuote(
  fromChainId: number,
  toChainId: number,
  fromAmount: bigint,
  fromAddress: Address,
  toAddress: Address,
  opts?: { bridges?: string; fromAmountForGas?: bigint },
): Promise<LiFiQuoteResponse> {
  const base: Record<string, string> = {
    fromChain: String(fromChainId),
    toChain: String(toChainId),
    fromToken: NATIVE_TOKEN_ADDRESS,
    toToken: NATIVE_TOKEN_ADDRESS,
    fromAmount: fromAmount.toString(),
    fromAddress,
    toAddress,
    order: "FASTEST",
  };
  if (opts?.fromAmountForGas !== undefined) {
    base.fromAmountForGas = opts.fromAmountForGas.toString();
  }

  // When the caller pins a specific bridge (e.g. `gasZipBridge` for the
  // low-floor first attempt) we honor it verbatim and skip the fast→full
  // widening — a 404 here is a meaningful "this bridge can't quote it"
  // signal that the caller wants to act on. Otherwise prefer the fast-
  // bridge allow-list, and if LI.FI has no route within it (404 "no
  // available quotes") retry once across the full bridge set, still
  // FASTEST-ordered. Non-404 failures (bad params, rate limit, 5xx)
  // never benefit from widening, so fail fast.
  const attempts: Record<string, string>[] = opts?.bridges
    ? [{ ...base, allowBridges: opts.bridges }]
    : [{ ...base, allowBridges: FAST_BRIDGES.join(",") }, base];
  let status = 0;
  let body = "";
  for (let i = 0; i < attempts.length; i++) {
    const res = await fetch(`${LIFI_API_BASE}/quote?${new URLSearchParams(attempts[i])}`);
    if (res.ok) {
      return (await res.json()) as LiFiQuoteResponse;
    }
    status = res.status;
    body = await res.text();
    if (status !== 404) break;
  }

  throw new Error(`LiFiError: Quote failed (${status}): ${body}`);
}

/**
 * Get a LI.FI quote targeting a specific output amount on the destination chain.
 * Uses a two-step probe to handle cross-token pricing (e.g. ETH -> POL).
 *
 * 1. Probe with fromAmount = targetOutputWei to discover the exchange rate
 * 2. If toAmount differs significantly (cross-token), adjust fromAmount proportionally
 *
 * @param fromChainId - Source chain ID
 * @param toChainId - Destination chain ID
 * @param targetOutputWei - Desired output in destination-token wei
 * @param fromAddress - Sender address
 * @param toAddress - Recipient address
 * @returns Quote whose estimate.toAmount covers the target
 */
export async function getLiFiQuoteForTargetOutput(
  fromChainId: number,
  toChainId: number,
  targetOutputWei: bigint,
  fromAddress: Address,
  toAddress: Address,
): Promise<LiFiQuoteResponse> {
  // Probe with `target`, inspect the rate, then re-quote with either a 20%
  // buffer (same-token) or a proportionally-scaled fromAmount (cross-token).
  // Extracted so we can run it once for the gas.zip-first low-floor attempt
  // and again for the standard fast-bridge fallback without duplicating the
  // probe / ratio / re-quote logic.
  const probeWithBuffer = async (
    target: bigint,
    quoteOpts?: { bridges?: string; fromAmountForGas?: bigint },
  ): Promise<LiFiQuoteResponse> => {
    const probe = await getLiFiQuote(fromChainId, toChainId, target, fromAddress, toAddress, quoteOpts);
    const probeToAmount = BigInt(probe.estimate.toAmount);
    const ratio = (probeToAmount * 100n) / target;

    if (ratio >= 90n && ratio <= 110n) {
      const bufferedAmount = (target * 120n) / 100n;
      return getLiFiQuote(fromChainId, toChainId, bufferedAmount, fromAddress, toAddress, quoteOpts);
    }

    const adjustedFromAmount = (target * target * 120n) / (probeToAmount * 100n);
    return getLiFiQuote(fromChainId, toChainId, adjustedFromAmount, fromAddress, toAddress, quoteOpts);
  };

  // Tier 1 — gas.zip-first, low floor. Gas.zip accepts deposits as small as
  // $0.25, so when the deficit lands between gas.zip's min and the standard
  // ~$1.50 floor we save the user from over-bridging. Best-effort: any
  // failure (404 NO_QUOTE, 4xx/5xx, network) falls through to tier 2 so
  // gas.zip availability never blocks a top-up.
  const gasZipFloor = minGasZipTargetWei(toChainId);
  if (gasZipFloor > 0n) {
    const gasZipTarget = targetOutputWei > gasZipFloor ? targetOutputWei : gasZipFloor;
    try {
      return await probeWithBuffer(gasZipTarget, {
        bridges: "gasZipBridge",
        fromAmountForGas: gasZipTarget,
      });
    } catch {
      // Fall through — surface the standard-tier error if that one also fails.
    }
  }

  // Tier 2 — standard fast-bridge path with the ~$1.50 floor that Across /
  // Relay need. Sub-$1 requests get rejected here, so we never let
  // `targetOutputWei` slip below the destination's minimum bridgeable value.
  const target =
    targetOutputWei > minCrossChainTargetWei(toChainId) ? targetOutputWei : minCrossChainTargetWei(toChainId);
  return probeWithBuffer(target);
}

/**
 * Poll the LI.FI transfer status until completion.
 *
 * @param txHash - Source chain transaction hash
 * @param bridge - Bridge tool name from the quote (e.g. "across")
 * @param fromChainId - Source chain ID
 * @param toChainId - Destination chain ID
 * @param timeoutMs - Maximum time to wait (default: 180s)
 * @param pollIntervalMs - Polling interval (default: 5s)
 * @param onProgress - Invoked with the parsed status on every successful poll
 *   (before the terminal DONE/FAILED decision), so callers can surface the
 *   live bridge substatus while the transfer is still in flight.
 * @returns The final status response
 */
export async function pollLiFiTransferStatus(
  txHash: string,
  bridge: string,
  fromChainId: number,
  toChainId: number,
  timeoutMs = 180_000,
  pollIntervalMs = 5_000,
  onProgress?: (status: LiFiStatusResponse) => void,
): Promise<LiFiStatusResponse> {
  const params = new URLSearchParams({
    txHash,
    bridge,
    fromChain: String(fromChainId),
    toChain: String(toChainId),
  });
  const url = `${LIFI_API_BASE}/status?${params}`;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const res = await fetch(url);

    if (!res.ok) {
      await new Promise((r) => setTimeout(r, pollIntervalMs));
      continue;
    }

    const data = (await res.json()) as LiFiStatusResponse;

    onProgress?.(data);

    if (data.status === "DONE") {
      if (data.substatus === "REFUNDED") {
        throw new Error("LiFiError: Transfer was refunded — funds returned to sender");
      }
      return data;
    }

    if (data.status === "FAILED") {
      throw new Error("LiFiError: Cross-chain transfer failed");
    }

    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  throw new Error("GAS_TOPUP_TIMEOUT: LI.FI transfer confirmation timed out");
}
