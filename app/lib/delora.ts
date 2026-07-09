import {
  type Address,
  type Call,
  erc20Abi,
  getAddress,
  type Hex,
  isAddressEqual,
  type Log,
  parseEventLogs,
} from "viem";
import { DELORA_INTEGRATOR, OCTOCASH_SWAP_FEE } from "~/data/delora";
import type { SendCallsFn } from "~/lib/send-calls";
import type { TokenAmount } from "~/lib/types";
import { deloraBaseUrl, deloraHeaders } from "./api/delora-client";
import { buildERC20ApprovalCalls } from "./tokens";

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
 * Slippage tolerance as a fraction (0.005 = 0.5%), enforced on-chain via the
 * quote's `minOutputAmount`.
 */
const SLIPPAGE_LIMIT = 0.005;

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
): Promise<DeloraQuote> {
  const url = new URL(deloraQuoteUrl());
  url.searchParams.set("senderAddress", input.walletAddress);
  url.searchParams.set("originChainId", String(input.chainId));
  url.searchParams.set("destinationChainId", String(outputToken.chainId));
  url.searchParams.set("amount", input.amount.toString());
  url.searchParams.set("originCurrency", input.token);
  url.searchParams.set("destinationCurrency", outputToken.token);
  url.searchParams.set("slippage", String(SLIPPAGE_LIMIT));
  if (OCTOCASH_SWAP_FEE > 0) {
    url.searchParams.set("integrator", DELORA_INTEGRATOR);
    url.searchParams.set("fee", String(OCTOCASH_SWAP_FEE));
  }

  const res = await fetch(url.toString(), {
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
  return (await res.json()) as DeloraQuote;
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
 */
export async function buildDeloraCalls(tokensToSwap: TokenAmount[], tokenOut: TokenAmount): Promise<Call[]> {
  const calls: Call[] = [];
  for (const input of dedupeSwapInputs(tokensToSwap)) {
    // Nothing to swap for this address; a zero-amount quote would be rejected.
    if (input.amount <= 0n) continue;
    const quote = await fetchSwapQuote(input, tokenOut);
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
  }
  return calls;
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

  // Build and execute swap calls
  const calls = await buildDeloraCalls(tokensIn, tokenOut);
  const [transactionHash, logs] = await sendCalls("swap", chainId, wallet, calls, "atomic-steps", retryHints);
  const flattenedLogs = logs.flat();

  const amount = deriveSwapOutputAmount(flattenedLogs as Log[], tokenOut);

  return { amount, transactionHash };
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
  if (summed > 0n) return summed;

  console.warn("[delora] No matching ERC20 Transfer found in receipt; falling back to quoted amount.");
  return tokenOut.amount;
}

/**
 * Get a swap quote from Delora for planning purposes (T009)
 * @param input - The input token amount(s) - can be a single token or an array of tokens
 * @param outputToken - The output token address
 * @returns The estimated output token amount
 *
 * Delora quotes are single-input, so multi-token input is deduped per address
 * and quoted sequentially, summing the per-token `outputAmount`s. Planning
 * creates one swap step per token address, so the common case is exactly one
 * request; arrays are still supported for same-address multi-provenance
 * entries and for robustness in `recalculatePlan`.
 */
export async function getSwapQuote(
  input: TokenAmount | TokenAmount[],
  outputToken: Omit<TokenAmount, "amount">,
): Promise<TokenAmount> {
  const inputTokens = Array.isArray(input) ? input : [input];

  // Validate all inputs are on the same chain
  for (const token of inputTokens) {
    if (token.chainId !== outputToken.chainId) {
      throw new Error("Input and output token must be on the same chain");
    }
  }

  // Validate all inputs are from the same wallet
  const firstWallet = inputTokens[0].walletAddress;
  for (const token of inputTokens) {
    if (token.walletAddress !== firstWallet) {
      throw new Error("All input tokens must be from the same wallet");
    }
  }

  try {
    let outputAmount = 0n;
    for (const token of dedupeSwapInputs(inputTokens)) {
      // Nothing to swap for this address; a zero-amount quote would be rejected.
      if (token.amount <= 0n) continue;
      // `outputAmount` is already net of Delora's routing costs and our
      // integrator fee (deducted from the input side), so it's used as-is.
      const quote = await fetchSwapQuote(token, outputToken);
      outputAmount += BigInt(quote.outputAmount);
    }
    return {
      ...outputToken,
      amount: outputAmount,
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

/** Whether a quote failure is Delora's HTTP 429 / RATE_LIMIT rejection. */
function isRateLimitError(error: unknown): boolean {
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return msg.includes("(429)") || msg.includes("rate_limit");
}
