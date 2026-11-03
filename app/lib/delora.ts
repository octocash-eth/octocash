import {
  type Address,
  type Call,
  erc20Abi,
  ethAddress,
  formatUnits,
  getAddress,
  type Hex,
  isAddressEqual,
  type Log,
  parseEventLogs,
  zeroAddress,
} from "viem";
import { DELORA_INTEGRATOR, OCTOCASH_SWAP_FEE } from "~/data/delora";
import type { SendCallsFn } from "~/lib/send-calls";
import type { TokenAmount } from "~/lib/types";
import { deloraBaseUrl, deloraHeaders } from "./api/delora-client";
import { getPublicClient } from "./public-client";
import { buildERC20ApprovalCalls, getTokenBalance } from "./tokens";

/**
 * Response of Delora's `GET /v1/quotes`. The quote is the executable
 * transaction — there is no separate assemble step.
 * See https://docs.delora.build/api-reference/endpoint/get-a-quote-for-a-token-transfer
 */
export interface DeloraQuote {
  inputAmount: string; // Base units actually routed (input-side fees already deducted)
  outputAmount: string; // Base units, net of all fees — planning consumes this
  minOutputAmount: string; // Slippage floor enforced on-chain
  adapter: string; // Route provider chosen by Delora (varies per quote)
  calldata: {
    to: Address;
    data: Hex;
    value: string; // Hex quantity
  };
  approvalAddress?: Address; // ERC20 spender; falls back to calldata.to
  gas?: {
    gasPrice?: Hex;
    maxFeePerGas?: Hex;
    maxPriorityFeePerGas?: Hex;
    gasLimit?: Hex;
  };
  warnings?: unknown[];
}

const deloraQuoteUrl = () => `${deloraBaseUrl()}/v1/quotes`;

/**
 * Planning-time quote cache. A failed planning attempt auto-retries (see
 * transaction-plan-executor.tsx), and each attempt re-quotes every selected
 * token sequentially at ~1.5–3s per request — without a cache a retry pays
 * the full sweep again and burns Delora's per-minute request budget on
 * quotes that already succeeded. Entries are keyed by the full request URL
 * (sender, chain pair, amount, currencies, fee), so any input change misses.
 *
 * Only planning opts in ({@link getSwapQuoteWithLegs}); execution paths
 * ({@link buildDeloraCalls}, {@link getDeloraRefuelQuote}) always fetch fresh
 * calldata. The TTL is short — plan estimates may lag the market by up to a
 * minute, but execution re-quotes and the drift check in execution.ts pauses
 * on divergence beyond {@link SLIPPAGE_LIMIT}.
 */
const QUOTE_CACHE_TTL_MS = 60_000;
const quoteCache = new Map<string, { quote: DeloraQuote; fetchedAt: number }>();

/** Test-only: the cache is module state, so suites must isolate from each other. */
export function clearSwapQuoteCache(): void {
  quoteCache.clear();
}

/**
 * Slippage tolerance as a fraction (0.005 = 0.5%), enforced on-chain via the
 * quote's `minOutputAmount`. Also reused as the quote-drift tolerance at
 * execution time: a fresh quote that under-delivers the planned amount by more
 * than this fraction pauses the plan instead of executing silently.
 */
export const SLIPPAGE_LIMIT = 0.005;

/**
 * Fetch a swap quote (single input → single output) from Delora.
 *
 * The integrator fee (0.1% of input) is baked into the returned
 * `outputAmount`/calldata when `OCTOCASH_SWAP_FEE > 0`; Delora deducts it
 * from the input side, but callers only ever consume the net `outputAmount`
 * so that detail doesn't leak out of this module.
 *
 * On non-2xx the thrown error message embeds the HTTP status plus Delora's
 * `code` and `message` fields — `isUnroutableTokenError` in planning.ts and
 * the `ExternalAPIError:` classification both match on that message text.
 */
async function fetchSwapQuote(
  input: Pick<TokenAmount, "token" | "amount" | "chainId" | "walletAddress">,
  outputToken: Pick<TokenAmount, "token" | "chainId">,
  receiverAddress?: Address,
  options?: { cache?: boolean },
): Promise<{ quote: DeloraQuote; fetchedAt: number }> {
  const url = new URL(deloraQuoteUrl());
  url.searchParams.set("senderAddress", input.walletAddress);
  url.searchParams.set("originChainId", String(input.chainId));
  url.searchParams.set("destinationChainId", String(outputToken.chainId));
  url.searchParams.set("amount", input.amount.toString());
  url.searchParams.set("originCurrency", input.token);
  url.searchParams.set("destinationCurrency", outputToken.token);
  if (receiverAddress) {
    url.searchParams.set("receiverAddress", receiverAddress);
  }
  url.searchParams.set("slippage", String(SLIPPAGE_LIMIT));
  if (OCTOCASH_SWAP_FEE > 0) {
    url.searchParams.set("integrator", DELORA_INTEGRATOR);
    url.searchParams.set("fee", String(OCTOCASH_SWAP_FEE));
  }

  const cacheKey = url.toString();
  if (options?.cache) {
    const hit = quoteCache.get(cacheKey);
    // `fetchedAt` rides along so callers can judge quote age: RFQ-style
    // adapters embed an on-chain order deadline shorter than the cache TTL,
    // so a cache hit may be fine for amounts yet stale for simulation.
    if (hit && Date.now() - hit.fetchedAt < QUOTE_CACHE_TTL_MS) return hit;
  }

  const res = await fetch(cacheKey, {
    headers: deloraHeaders({ accept: "application/json" }),
  });
  if (!res.ok) {
    const text = await res.text();
    let detail = text;
    try {
      const body = JSON.parse(text) as { code?: string; message?: string };
      if (body.message) detail = body.code ? `${body.code}: ${body.message}` : body.message;
    } catch {
      // Non-JSON error body; keep the raw text.
    }
    throw new Error(`Request failed (${res.status}): ${detail}`);
  }
  const quote = (await res.json()) as DeloraQuote;
  const fetchedAt = Date.now();
  if (options?.cache) {
    // Drop expired entries before storing so the map stays bounded.
    for (const [key, entry] of quoteCache) {
      if (Date.now() - entry.fetchedAt >= QUOTE_CACHE_TTL_MS) quoteCache.delete(key);
    }
    quoteCache.set(cacheKey, { quote, fetchedAt });
  }
  return { quote, fetchedAt };
}

/**
 * Sums per-token-address so we issue a single quote per on-chain token.
 * `step.inputTokens` legitimately carries multiple `TokenAmount`s for the
 * same token (e.g. on the destination chain after a CCTP claim, the user's
 * pre-existing USDC and the claim-output USDC sit in `step.inputTokens` as
 * two entries with different `provenance` so dependency tracking and
 * `recalculatePlan` stay correct). Delora only cares about the total per
 * address, so collapse here without touching the upstream plan.
 *
 * Addresses go through `getAddress` so EIP-55 case differences don't split
 * the same token across two buckets.
 */
function dedupeSwapInputs(inputTokens: TokenAmount[]): TokenAmount[] {
  const byAddress = new Map<Address, TokenAmount>();
  for (const t of inputTokens) {
    const key = getAddress(t.token);
    const existing = byAddress.get(key);
    if (existing === undefined) {
      byAddress.set(key, { ...t });
    } else {
      existing.amount += t.amount;
    }
  }
  return Array.from(byAddress.values());
}

/**
 * Quote each (deduped) input token and turn the quotes into executable calls:
 * `[approval?, swap]` per token. Quotes are fetched sequentially to avoid
 * bursting Delora's per-IP rate limit.
 *
 * `minOutputAmount` is the sum of the per-quote on-chain slippage floors —
 * the least the receiver should get across all swap calls combined. It feeds
 * the pre-flight delivery check in {@link simulateSwapDelivery} (same-chain)
 * and the delivery record's landed threshold (cross-chain, where
 * `receiverAddress` names the destination-chain recipient and
 * `expectedOutputAmount` — the sum of quoted outputs — is the amount the
 * plan carries forward, since origin receipts can't reveal it).
 */
export async function buildDeloraCalls(
  tokensToSwap: TokenAmount[],
  tokenOut: TokenAmount,
  receiverAddress?: Address,
): Promise<{ calls: Call[]; minOutputAmount: bigint; expectedOutputAmount: bigint }> {
  const calls: Call[] = [];
  let minOutputAmount = 0n;
  let expectedOutputAmount = 0n;
  for (const input of dedupeSwapInputs(tokensToSwap)) {
    // Nothing to swap for this address; a zero-amount quote would be rejected.
    if (input.amount <= 0n) continue;
    const { quote } = await fetchSwapQuote(input, tokenOut, receiverAddress);
    // The integrator fee is already baked into this calldata by Delora (see
    // `fetchSwapQuote`), so the swap is sent verbatim. The spender for the
    // approval is Delora's per-chain entrypoint; `calldata.to` can differ
    // per adapter, so prefer the explicit `approvalAddress`.
    const spender = quote.approvalAddress ?? quote.calldata.to;
    calls.push(...(await buildERC20ApprovalCalls(input, spender)));
    calls.push({
      to: quote.calldata.to,
      data: quote.calldata.data,
      value: BigInt(quote.calldata.value ?? "0x0"),
    });
    // A quote missing its floor contributes 0 rather than failing the swap —
    // the delivery check just gets weaker for that leg.
    minOutputAmount += BigInt(quote.minOutputAmount ?? "0");
    expectedOutputAmount += BigInt(quote.outputAmount);
  }
  return { calls, minOutputAmount, expectedOutputAmount };
}

/**
 * Shape of one entry in `simulateCalls().results`. viem's full result type is
 * generic over the call array; this narrows to the three fields we consume.
 */
interface SimulatedCallResult {
  status: "success" | "failure";
  error?: Error;
  logs?: Log[];
}

/**
 * Pre-flight delivery check: simulate the full `[approval?, swap]+` sequence
 * via `eth_simulateV1` and verify the user's wallet would actually receive at
 * least the quotes' combined `minOutputAmount`.
 *
 * Why this exists: the swap calldata is Delora's, sent verbatim. The on-chain
 * `minOutputAmount` floor protects against price movement — but only if the
 * calldata actually contains that check and pays out to the user's wallet.
 * Simulating verifies both without trusting Delora: a route that would execute
 * "successfully" while under-delivering, or paying someone else, is caught
 * here before the wallet prompt and before any gas is spent.
 *
 * Failure policy:
 * - Simulated shortfall or simulated revert → throw (fail closed).
 * - Simulation infrastructure errors (RPC without `eth_simulateV1`, rate
 *   limit, network) → warn and proceed (fail open): the on-chain floor still
 *   protects the funds, matching the gas-estimation fallback in send-calls.ts.
 *
 * Native output (zeroAddress) emits no ERC20 Transfer, so it is verified via
 * `traceAssetChanges` (native balance delta, reported under viem's
 * `ethAddress` placeholder) instead of Transfer logs.
 *
 * This is a point-in-time check — pool state can move between simulation and
 * inclusion — so it complements the on-chain floor rather than replacing it.
 *
 * Cross-chain quotes (`tokenOut.chainId !== chainId`) get a revert check
 * only: the output lands later on the destination chain, so neither Transfer
 * logs nor the origin wallet's balance delta can verify delivery here. The
 * quote's `minOutputAmount` floor (enforced by the adapter's settlement) and
 * the destination-side balance wait ({@link waitForCrossChainDelivery})
 * carry the delivery guarantee instead.
 */
export async function simulateSwapDelivery(
  chainId: number,
  wallet: Address,
  calls: Call[],
  tokenOut: TokenAmount,
  minOutputAmount: bigint,
): Promise<void> {
  if (calls.length === 0 || minOutputAmount <= 0n) return;

  if (tokenOut.chainId !== chainId) {
    try {
      const client = getPublicClient(chainId);
      const { results } = await client.simulateCalls({ account: wallet, calls });
      const failed = (results as readonly SimulatedCallResult[]).find((r) => r.status === "failure");
      if (failed) {
        throw new Error(`Swap simulation reverted: ${failed.error?.message ?? "execution reverted"}`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Swap simulation reverted:")) throw error;
      console.warn("[delora] Pre-flight simulation unavailable; relying on on-chain minOutputAmount.", error);
    }
    return;
  }

  const isNativeOut = isAddressEqual(tokenOut.token, zeroAddress);
  let outcome: { simulatedOutput: bigint } | { revertReason: string } | undefined;
  try {
    const client = getPublicClient(chainId);
    if (isNativeOut) {
      const { assetChanges, results } = await client.simulateCalls({
        account: wallet,
        calls,
        traceAssetChanges: true,
      });
      const failed = (results as readonly SimulatedCallResult[]).find((r) => r.status === "failure");
      if (failed) {
        outcome = { revertReason: failed.error?.message ?? "execution reverted" };
      } else {
        const native = assetChanges.find((c) => isAddressEqual(c.token.address, ethAddress));
        // Missing native entry means the balance probes failed; leave
        // `outcome` unset so this is treated as "simulation unavailable".
        if (native) outcome = { simulatedOutput: native.value.diff };
      }
    } else {
      const { results } = await client.simulateCalls({ account: wallet, calls });
      const failed = (results as readonly SimulatedCallResult[]).find((r) => r.status === "failure");
      if (failed) {
        outcome = { revertReason: failed.error?.message ?? "execution reverted" };
      } else {
        const logs = (results as readonly SimulatedCallResult[]).flatMap((r) => r.logs ?? []);
        outcome = { simulatedOutput: sumTransfersToWallet(logs, tokenOut) };
      }
    }
  } catch (error) {
    console.warn("[delora] Pre-flight simulation unavailable; relying on on-chain minOutputAmount.", error);
    return;
  }

  if (outcome === undefined) {
    console.warn(
      "[delora] Pre-flight simulation returned no native balance delta; relying on on-chain minOutputAmount.",
    );
    return;
  }
  if ("revertReason" in outcome) {
    throw new Error(`Swap simulation reverted: ${outcome.revertReason}`);
  }
  if (outcome.simulatedOutput < minOutputAmount) {
    const fmt = (amount: bigint) => `${formatUnits(amount, tokenOut.decimals)} ${tokenOut.symbol}`;
    throw new Error(
      `Swap aborted: simulation shows the wallet would receive ${fmt(outcome.simulatedOutput)}, ` +
        `below the quoted minimum of ${fmt(minOutputAmount)}. No transaction was sent.`,
    );
  }
}

/**
 * Executes a Delora swap to convert tokens to a different token on the same chain.
 * @param tokensIn - The tokens to swap (must be different from tokenOut).
 * @param tokenOut - The token to swap to.
 * @param sendCalls - The function to send the calls.
 * @returns Object containing the amount of output token and transaction hash.
 */
export async function executeDeloraSwap(
  tokensIn: TokenAmount[],
  tokenOut: TokenAmount,
  sendCalls: SendCallsFn,
  retryHints?: Parameters<SendCallsFn>[5],
): Promise<{ amount: bigint; transactionHash: string }> {
  const chainId = tokensIn[0].chainId;
  const wallet = tokensIn[0].walletAddress;

  for (const t of tokensIn) {
    // All tokens must be on the same chain and come from the same wallet
    if (t.chainId !== chainId || t.walletAddress !== wallet) {
      throw new Error("Tokens are not on the same chain or do not come from the same wallet");
    }
  }

  // TokenOut chainId must be the same as the source chainId
  if (tokenOut.chainId !== chainId) {
    throw new Error("Swap destination chain must be the same as the source chain");
  }

  // Build swap calls, then simulate them before asking the wallet to sign:
  // aborts (throws) if the simulated delivery falls short of the quoted
  // minimum or the sequence would revert. See `simulateSwapDelivery`.
  const { calls, minOutputAmount } = await buildDeloraCalls(tokensIn, tokenOut);
  await simulateSwapDelivery(chainId, wallet, calls, tokenOut, minOutputAmount);
  const [transactionHash, logs] = await sendCalls("swap", chainId, wallet, calls, "atomic-steps", retryHints);
  const flattenedLogs = logs.flat();

  const amount = deriveSwapOutputAmount(flattenedLogs as Log[], tokenOut);

  return { amount, transactionHash };
}

/**
 * Executes a Delora cross-chain swap: origin-chain `[approval?, swap]` calls
 * whose output is delivered by Delora's adapter to `receiver` on
 * `tokenOut.chainId`. Cross-chain sibling of {@link executeDeloraSwap}, with
 * two deliberate differences:
 * - the pre-flight simulation is a revert check only (delivery happens later
 *   on another chain — see {@link simulateSwapDelivery});
 * - the origin receipt carries no output Transfer, so the returned
 *   `expectedAmount`/`minDeliveredAmount` come from the fresh quotes; actual
 *   delivery is confirmed by {@link waitForCrossChainDelivery} against a
 *   {@link CrossChainDeliveryRecord}.
 */
export async function executeDeloraCrossChainSwap(
  tokensIn: TokenAmount[],
  tokenOut: TokenAmount,
  receiver: Address,
  sendCalls: SendCallsFn,
  retryHints?: Parameters<SendCallsFn>[5],
): Promise<{ expectedAmount: bigint; minDeliveredAmount: bigint; transactionHash: string }> {
  const chainId = tokensIn[0].chainId;
  const wallet = tokensIn[0].walletAddress;

  for (const t of tokensIn) {
    // All tokens must be on the same chain and come from the same wallet
    if (t.chainId !== chainId || t.walletAddress !== wallet) {
      throw new Error("Tokens are not on the same chain or do not come from the same wallet");
    }
  }

  if (tokenOut.chainId === chainId) {
    throw new Error("Cross-chain swap destination chain must differ from the source chain");
  }

  const { calls, minOutputAmount, expectedOutputAmount } = await buildDeloraCalls(tokensIn, tokenOut, receiver);
  await simulateSwapDelivery(chainId, wallet, calls, tokenOut, minOutputAmount);
  const [transactionHash] = await sendCalls("crosschain-swap", chainId, wallet, calls, "atomic-steps", retryHints);

  return { expectedAmount: expectedOutputAmount, minDeliveredAmount: minOutputAmount, transactionHash };
}

/**
 * Derive the swap's actual output amount from receipt logs.
 *
 * Primary path: sum standard ERC20 `Transfer` events to the user's wallet
 * for the output token. Delora picks a different adapter (and therefore a
 * different router contract) per quote, so there is no stable swap event ABI
 * to parse — summing Transfer events is the reliable signal here. Multiple
 * transfers to the user (e.g. fee remainder + main payout) naturally sum to
 * the net amount received.
 *
 * Last resort: if no matching transfer is found, return the most recent
 * quoted amount (`tokenOut.amount`) rather than throw — the on-chain swap
 * has already executed by the time we're here, and reporting failure for a
 * successful tx is worse than a slightly stale `actualOutput`. This is also
 * the path for native-token output (no ERC20 Transfer is emitted to the
 * wallet); a balance-delta backstop via `getTokenBalance` would be the
 * natural extension if native outputs become common.
 */
export function deriveSwapOutputAmount(logs: Log[], tokenOut: TokenAmount): bigint {
  const summed = sumTransfersToWallet(logs, tokenOut);
  if (summed > 0n) return summed;

  console.warn("[delora] No matching ERC20 Transfer found in receipt; falling back to quoted amount.");
  return tokenOut.amount;
}

/**
 * Sum standard ERC20 `Transfer` amounts to the user's wallet for the output
 * token. Shared by receipt parsing (above) and the pre-flight simulation —
 * unlike `deriveSwapOutputAmount` there is no quoted-amount fallback, so a
 * zero here genuinely means "nothing delivered".
 */
function sumTransfersToWallet(logs: Log[], tokenOut: TokenAmount): bigint {
  const transfers = parseEventLogs({
    abi: erc20Abi,
    eventName: "Transfer",
    logs,
  });

  let summed = 0n;
  for (const log of transfers) {
    if (!isAddressEqual(log.address, tokenOut.token)) continue;
    if (!isAddressEqual(log.args.to, tokenOut.walletAddress)) continue;
    summed += log.args.value;
  }
  return summed;
}

/**
 * One quoted swap leg retained for planning-time gas simulation: the deduped
 * input it consumes, the executable call from the quote, the approval spender,
 * and Delora's own gas-limit hint when present.
 *
 * Planning-time only — this calldata must never be executed (execution
 * re-quotes via {@link buildDeloraCalls}), which is why legs travel as a
 * side-channel next to the plan instead of on `TransactionStep`.
 */
export interface DeloraSwapLeg {
  input: TokenAmount;
  call: { to: Address; data: Hex; value: bigint };
  approvalAddress: Address;
  gasLimitHint?: bigint;
  /**
   * Epoch ms when the quote behind `call` was fetched from Delora (a cache
   * hit reports the original fetch time). RFQ-style adapters embed an
   * on-chain order deadline ~30s from issuance, so gas simulation skips
   * calldata older than that. Absent legs are treated as fresh.
   */
  quoteFetchedAt?: number;
}

/**
 * Get a swap quote from Delora for planning purposes (T009)
 * @param input - The input token amount(s) - can be a single token or an array of tokens
 * @param outputToken - The output token address
 * @returns The estimated output token amount plus the per-leg calldata/gas hints
 *
 * Delora quotes are single-input, so multi-token input is deduped per address
 * and quoted sequentially, summing the per-token `outputAmount`s. Planning
 * creates one swap step per token address, so the common case is exactly one
 * request; arrays are still supported for same-address multi-provenance
 * entries and for robustness in `recalculatePlan`.
 */
export async function getSwapQuoteWithLegs(
  input: TokenAmount | TokenAmount[],
  outputToken: Omit<TokenAmount, "amount">,
): Promise<{ output: TokenAmount; legs: DeloraSwapLeg[] }> {
  const inputTokens = Array.isArray(input) ? input : [input];

  // Validate all inputs are on the same chain
  for (const token of inputTokens) {
    if (token.chainId !== outputToken.chainId) {
      throw new Error("Input and output token must be on the same chain");
    }
  }

  return quoteSwapLegs(inputTokens, outputToken);
}

/**
 * Cross-chain sibling of {@link getSwapQuoteWithLegs}: quote each input token
 * on its origin chain directly into `outputToken` on a different chain, with
 * Delora delivering to `receiverAddress` there. Planning-only (cached, like
 * the same-chain path); execution re-quotes via
 * {@link executeDeloraCrossChainSwap}.
 *
 * Also returns the summed `minOutputAmount` slippage floor — the landed
 * threshold a `crosschain-swap` step's delivery record is built from.
 */
export async function getCrossChainSwapQuoteWithLegs(
  input: TokenAmount | TokenAmount[],
  outputToken: Omit<TokenAmount, "amount">,
  receiverAddress: Address,
): Promise<{ output: TokenAmount; legs: DeloraSwapLeg[]; minOutputAmount: bigint }> {
  const inputTokens = Array.isArray(input) ? input : [input];

  for (const token of inputTokens) {
    if (token.chainId === outputToken.chainId) {
      throw new Error("Cross-chain swap requires different origin and destination chains");
    }
  }

  return quoteSwapLegs(inputTokens, outputToken, receiverAddress);
}

/**
 * Shared body of the planning-time quote entry points. Chain-shape
 * validation stays in the public wrappers; this handles the same-wallet
 * check, per-address dedupe, sequential cached quoting, and the
 * RateLimitError/ExternalAPIError classification.
 */
async function quoteSwapLegs(
  inputTokens: TokenAmount[],
  outputToken: Omit<TokenAmount, "amount">,
  receiverAddress?: Address,
): Promise<{ output: TokenAmount; legs: DeloraSwapLeg[]; minOutputAmount: bigint }> {
  // Validate all inputs are from the same wallet
  const firstWallet = inputTokens[0].walletAddress;
  for (const token of inputTokens) {
    if (token.walletAddress !== firstWallet) {
      throw new Error("All input tokens must be from the same wallet");
    }
  }

  try {
    let outputAmount = 0n;
    let minOutputAmount = 0n;
    const legs: DeloraSwapLeg[] = [];
    for (const token of dedupeSwapInputs(inputTokens)) {
      // Nothing to swap for this address; a zero-amount quote would be rejected.
      if (token.amount <= 0n) continue;
      // `outputAmount` is already net of Delora's routing costs and our
      // integrator fee (deducted from the input side), so it's used as-is.
      // Planning-only, so cached: an auto-retried plan reuses quotes that
      // already succeeded instead of re-sweeping every token.
      const { quote, fetchedAt } = await fetchSwapQuote(token, outputToken, receiverAddress, { cache: true });
      outputAmount += BigInt(quote.outputAmount);
      minOutputAmount += BigInt(quote.minOutputAmount ?? "0");
      legs.push({
        input: token,
        call: {
          to: quote.calldata.to,
          data: quote.calldata.data,
          value: BigInt(quote.calldata.value ?? "0x0"),
        },
        approvalAddress: quote.approvalAddress ?? quote.calldata.to,
        gasLimitHint: quote.gas?.gasLimit ? BigInt(quote.gas.gasLimit) : undefined,
        quoteFetchedAt: fetchedAt,
      });
    }
    return {
      output: {
        ...outputToken,
        amount: outputAmount,
      },
      legs,
      minOutputAmount,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Delora quote failed";
    // Rate-limit rejections must NOT carry the `ExternalAPIError:` prefix:
    // that prefix triggers the plan-error auto-retry loop (see
    // transaction-plan-executor.tsx), which would hammer a per-IP window that
    // only resets after minutes (or 2 hours without an API key). Rendering
    // the failure statically lets the user retry once the window clears.
    if (isRateLimitError(error)) {
      throw new Error(`RateLimitError: ${message}`);
    }
    throw new Error(`ExternalAPIError: ${message}`);
  }
}

/**
 * Amount-only variant of {@link getSwapQuoteWithLegs} for callers that don't
 * need the calldata/gas legs (e.g. `recalculatePlan` and quote refreshes at
 * execution time).
 */
export async function getSwapQuote(
  input: TokenAmount | TokenAmount[],
  outputToken: Omit<TokenAmount, "amount">,
): Promise<TokenAmount> {
  const { output } = await getSwapQuoteWithLegs(input, outputToken);
  return output;
}

/**
 * Get a Delora cross-chain native→native quote targeting a specific output on
 * the destination chain — the fallback gas-refuel route when Gas.zip can't
 * serve a chain pair. Same two-step probe as the Gas.zip path: quote with
 * `amount = target` to learn the rate, then re-quote with a 20% buffer
 * (same-token) or a proportionally scaled input (cross-token, e.g. ETH→POL).
 *
 * The returned `minDeliveredWei` is the quote's on-chain `minOutputAmount`
 * floor, which the balance-based delivery wait uses as its landed threshold.
 */
export async function getDeloraRefuelQuote(
  fromChainId: number,
  toChainId: number,
  targetOutputWei: bigint,
  from: Address,
  to: Address,
): Promise<import("./gas-refuel").GasRefuelQuote> {
  const quoteAt = async (amount: bigint) => {
    const { quote } = await fetchSwapQuote(
      { token: zeroAddress, amount, chainId: fromChainId, walletAddress: from },
      { token: zeroAddress, chainId: toChainId },
      to,
    );
    return quote;
  };

  const probe = await quoteAt(targetOutputWei);
  const probeOut = BigInt(probe.outputAmount);
  if (probeOut <= 0n) {
    throw new Error("DeloraRefuelError: probe quote returned no output");
  }
  const ratio = (probeOut * 100n) / targetOutputWei;

  const depositWei =
    ratio >= 90n && ratio <= 110n
      ? (targetOutputWei * 120n) / 100n
      : (targetOutputWei * targetOutputWei * 120n) / (probeOut * 100n);

  const quote = await quoteAt(depositWei);
  // The tx value is what the source wallet actually spends — prefer it over
  // our requested amount in case Delora prices fees into the call value.
  const txValue = BigInt(quote.calldata.value ?? "0x0");

  return {
    provider: "delora",
    fromChainId,
    toChainId,
    depositWei: txValue > 0n ? txValue : depositWei,
    expectedWei: BigInt(quote.outputAmount),
    minDeliveredWei: BigInt(quote.minOutputAmount ?? quote.outputAmount),
    tx: {
      to: quote.calldata.to,
      data: quote.calldata.data,
      value: txValue,
    },
  };
}

/** Whether a quote failure is Delora's HTTP 429 / RATE_LIMIT rejection. */
function isRateLimitError(error: unknown): boolean {
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return msg.includes("(429)") || msg.includes("rate_limit");
}

/**
 * A sent cross-chain swap, persisted in
 * `ConsolidationState.metadata.crosschain.deliveries` so the `crosschain-wait`
 * step can confirm delivery (including across a page reload or retry — the
 * pre-send baseline makes the check idempotent). The token-flavored sibling
 * of {@link import("./gas-refuel").GasRefuelRecord}.
 */
export interface CrossChainDeliveryRecord {
  txHash: string;
  fromChainId: number;
  toChainId: number;
  toAddress: Address;
  /** Destination token delivered; zeroAddress = native. */
  tokenAddress: Address;
  /** Receiver's destination-token balance BEFORE the origin tx was sent (base units, as string for persistence). */
  baselineUnits: string;
  /** Delivery threshold: landed when balance ≥ baseline + minDelivered (base units, as string). */
  minDeliveredUnits: string;
  /** Sum of the quotes' `outputAmount`s — the amount the plan carries forward. */
  expectedUnits: string;
}

/**
 * Wait until every sent cross-chain swap visibly lands on its destination
 * chain. Records are grouped by (chain, receiver, token) — several origin
 * legs typically converge on one destination balance — and a group counts as
 * delivered when `balance ≥ min(baselines) + Σ minDelivered`. The earliest
 * baseline is the reference: a delivery that landed before a later record's
 * baseline was captured is already inside that later baseline, so summing
 * per-record thresholds against it can't double-count.
 *
 * Returns the total delivered amount: per group, the measured balance delta
 * clamped to `[Σ min, Σ expected]` (clamping discards unrelated inflows and
 * floors transient RPC under-reads), summed across groups.
 *
 * Provider-agnostic and idempotent — a retry after the funds arrived
 * resolves on the first poll.
 *
 * @param onProgress - invoked on every poll with (deliveredGroups, totalGroups)
 * @throws `CROSSCHAIN_DELIVERY_TIMEOUT: ...` when the deadline passes (funds
 *   may still arrive later — the caller's retry path re-enters this wait)
 */
export async function waitForCrossChainDelivery(
  records: CrossChainDeliveryRecord[],
  timeoutMs = 600_000,
  pollIntervalMs = 5_000,
  onProgress?: (delivered: number, total: number) => void,
): Promise<bigint> {
  interface DeliveryGroup {
    toChainId: number;
    toAddress: Address;
    tokenAddress: Address;
    baseline: bigint;
    minDelivered: bigint;
    expected: bigint;
  }
  const groups = new Map<string, DeliveryGroup>();
  for (const record of records) {
    const key = `${record.toChainId}:${getAddress(record.toAddress)}:${getAddress(record.tokenAddress)}`;
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, {
        toChainId: record.toChainId,
        toAddress: record.toAddress,
        tokenAddress: record.tokenAddress,
        baseline: BigInt(record.baselineUnits),
        minDelivered: BigInt(record.minDeliveredUnits),
        expected: BigInt(record.expectedUnits),
      });
    } else {
      const baseline = BigInt(record.baselineUnits);
      if (baseline < existing.baseline) existing.baseline = baseline;
      existing.minDelivered += BigInt(record.minDeliveredUnits);
      existing.expected += BigInt(record.expectedUnits);
    }
  }
  if (groups.size === 0) return 0n;

  const deadline = Date.now() + timeoutMs;
  const landedDelta = new Map<string, bigint>();

  while (Date.now() < deadline) {
    for (const [key, group] of groups) {
      if (landedDelta.has(key)) continue;
      try {
        const balance = await getTokenBalance(group.toChainId, group.toAddress, group.tokenAddress);
        const delta = balance - group.baseline;
        if (delta >= group.minDelivered) {
          landedDelta.set(key, delta < group.expected ? delta : group.expected);
        }
      } catch {
        // Transient RPC error — keep polling until the deadline.
      }
    }
    onProgress?.(landedDelta.size, groups.size);
    if (landedDelta.size === groups.size) {
      let total = 0n;
      for (const delta of landedDelta.values()) total += delta;
      return total;
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  throw new Error("CROSSCHAIN_DELIVERY_TIMEOUT: Cross-chain swap delivery confirmation timed out");
}
