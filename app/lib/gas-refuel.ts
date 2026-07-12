import type { Address, Chain, Hex } from "viem";
import { chains, transports } from "~/data/supported-chains";
import { getNativeBalance } from "./gas";

/**
 * Cross-chain native gas refuel, provider-agnostic. Gas.zip is the primary
 * route (purpose-built for refuels, accepts deposits from ~$0.25, delivers in
 * seconds); Delora's cross-chain native→native routing is the fallback when
 * Gas.zip can't serve a chain pair or its API is down.
 *
 * Delivery is confirmed by watching the destination wallet's native balance
 * (see {@link waitForRefuelDelivery}) rather than a provider status API — the
 * balance is the ground truth, works identically for both providers, and
 * keeps the wait step functional even when a provider's backend is
 * unreachable.
 */

/** A quoted refuel ready to send from the source wallet. */
export interface GasRefuelQuote {
  provider: "gaszip" | "delora";
  fromChainId: number;
  toChainId: number;
  /** Native wei the source wallet spends (the deposit transaction's value). */
  depositWei: bigint;
  /** Native wei the provider expects to deliver on the destination. */
  expectedWei: bigint;
  /** Landed threshold for the balance-based delivery wait. */
  minDeliveredWei: bigint;
  tx: { to: Address; data: Hex; value: bigint };
}

/**
 * A sent refuel, persisted in `ConsolidationState.metadata.gasRefuels` so the
 * `gas-topup-wait` step can confirm delivery (including across a page reload
 * or retry — the pre-deposit baseline makes the check idempotent).
 */
export interface GasRefuelRecord {
  provider: "gaszip" | "delora";
  txHash: string;
  fromChainId: number;
  toChainId: number;
  toAddress: Address;
  /** Destination wallet's native balance BEFORE the deposit was sent (wei, as string for persistence). */
  baselineWei: string;
  /** Delivery threshold: landed when balance ≥ baseline + minDelivered (wei, as string). */
  minDeliveredWei: string;
}

/**
 * Minimum cross-chain top-up target for the Delora fallback, keyed by the
 * destination chain's native symbol. General-purpose bridges reject transfers
 * worth under ~$1 and a sub-$1 refuel gets eaten by fees, so the fallback
 * never quotes below this — the user just receives a little extra,
 * immediately usable, gas instead of a hard planning failure.
 */
const MIN_DELORA_TARGET_WEI: Record<string, bigint> = {
  ETH: 1_200_000_000_000_000n, // ~0.0012 ETH (≈ $1.8–5 across regimes)
  POL: 8_000_000_000_000_000_000n, // ~8 POL (≈ $1.2–5 across regimes)
};

/**
 * Lower floor for the Gas.zip route, which accepts deposits as small as
 * ~$0.25 (https://dev.gas.zip/gas/overview) — far below what general-purpose
 * bridges enforce. Sized to clear that minimum + price movement + Gas.zip's
 * flat fee. Natives absent from the map get no floor.
 */
const MIN_GASZIP_TARGET_WEI: Record<string, bigint> = {
  ETH: 200_000_000_000_000n, // ~0.0002 ETH (≈ $0.30–0.80 across regimes)
  POL: 2_000_000_000_000_000_000n, // ~2 POL    (≈ $0.30–1.00 across regimes)
};

function flooredTarget(toChainId: number, targetWei: bigint, floors: Record<string, bigint>): bigint {
  const symbol = chains[toChainId as keyof typeof chains]?.nativeCurrency.symbol;
  const floor = (symbol && floors[symbol]) || 0n;
  return targetWei > floor ? targetWei : floor;
}

/**
 * Quote a cross-chain gas refuel delivering at least `targetOutputWei` native
 * to `to` on `toChainId`: Gas.zip first, Delora as fallback. Throws only when
 * both providers fail, with both reasons in the message.
 */
export async function getGasRefuelQuote(
  fromChainId: number,
  toChainId: number,
  targetOutputWei: bigint,
  from: Address,
  to: Address,
): Promise<GasRefuelQuote> {
  // Lazy imports keep a clean one-way dependency: provider modules import the
  // GasRefuelQuote type from here, this orchestrator imports their runtime.
  const { getGasZipRefuelQuote } = await import("./gas-zip");
  let gasZipReason: string;
  try {
    return await getGasZipRefuelQuote(
      fromChainId,
      toChainId,
      flooredTarget(toChainId, targetOutputWei, MIN_GASZIP_TARGET_WEI),
      from,
      to,
    );
  } catch (error) {
    gasZipReason = error instanceof Error ? error.message : String(error);
    console.warn(`[gas-refuel] Gas.zip quote failed (${fromChainId}→${toChainId}); trying Delora.`, error);
  }

  const { getDeloraRefuelQuote } = await import("./delora");
  try {
    return await getDeloraRefuelQuote(
      fromChainId,
      toChainId,
      flooredTarget(toChainId, targetOutputWei, MIN_DELORA_TARGET_WEI),
      from,
      to,
    );
  } catch (error) {
    const deloraReason = error instanceof Error ? error.message : String(error);
    throw new Error(`GasRefuelError: No refuel route available. Gas.zip: ${gasZipReason}. Delora: ${deloraReason}`);
  }
}

/**
 * Wait until a sent refuel visibly lands: the destination wallet's native
 * balance reaches `baseline + minDelivered`. Provider-agnostic and idempotent
 * — a retry after the funds already arrived resolves on the first poll.
 *
 * @param onProgress - invoked on every poll with whether this refuel has landed
 * @throws `GAS_TOPUP_TIMEOUT: ...` when the deadline passes (funds may still
 *   arrive later — the caller's retry path re-enters this wait)
 */
export async function waitForRefuelDelivery(
  refuel: GasRefuelRecord,
  timeoutMs = 180_000,
  pollIntervalMs = 5_000,
  onProgress?: (delivered: boolean) => void,
): Promise<void> {
  const chain = chains[refuel.toChainId as keyof typeof chains] as Chain | undefined;
  if (!chain) {
    throw new Error(`GasRefuelError: Unsupported destination chain ${refuel.toChainId}`);
  }
  const threshold = BigInt(refuel.baselineWei) + BigInt(refuel.minDeliveredWei);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const balance = await getNativeBalance(
        chain,
        refuel.toAddress,
        transports?.[refuel.toChainId as keyof typeof transports],
      );
      if (balance >= threshold) {
        onProgress?.(true);
        return;
      }
      onProgress?.(false);
    } catch {
      // Transient RPC error — keep polling until the deadline.
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  throw new Error("GAS_TOPUP_TIMEOUT: Gas refuel delivery confirmation timed out");
}
