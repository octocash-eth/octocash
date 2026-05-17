import type { Address, Hex } from "viem";

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
): Promise<LiFiQuoteResponse> {
  const params = new URLSearchParams({
    fromChain: String(fromChainId),
    toChain: String(toChainId),
    fromToken: NATIVE_TOKEN_ADDRESS,
    toToken: NATIVE_TOKEN_ADDRESS,
    fromAmount: fromAmount.toString(),
    fromAddress,
    toAddress,
    order: "FASTEST",
    allowBridges: FAST_BRIDGES.join(","),
  });
  const url = `${LIFI_API_BASE}/quote?${params}`;
  const res = await fetch(url);

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LiFiError: Quote failed (${res.status}): ${text}`);
  }

  return (await res.json()) as LiFiQuoteResponse;
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
  const probe = await getLiFiQuote(fromChainId, toChainId, targetOutputWei, fromAddress, toAddress);
  const probeToAmount = BigInt(probe.estimate.toAmount);

  // If the probe already delivers enough (same token, small fee), return with a 20% buffer re-quote
  const ratio = (probeToAmount * 100n) / targetOutputWei;

  if (ratio >= 90n && ratio <= 110n) {
    // Same token pair (e.g. ETH->ETH), probe is close. Re-quote with 20% buffer.
    const bufferedAmount = (targetOutputWei * 120n) / 100n;
    return getLiFiQuote(fromChainId, toChainId, bufferedAmount, fromAddress, toAddress);
  }

  // Cross-token (e.g. ETH->POL or POL->ETH): calculate proportionally with 20% buffer
  const adjustedFromAmount = (targetOutputWei * targetOutputWei * 120n) / (probeToAmount * 100n);
  return getLiFiQuote(fromChainId, toChainId, adjustedFromAmount, fromAddress, toAddress);
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
