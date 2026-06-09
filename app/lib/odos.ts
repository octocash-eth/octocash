import {
  type Address,
  type Call,
  erc20Abi,
  getAddress,
  type Hex,
  isAddressEqual,
  type Log,
  parseAbi,
  parseEventLogs,
} from "viem";
import { OCTOCASH_FEE_RECIPIENT, OCTOCASH_REFERRAL_FEE } from "~/data/odos";
import type { SendCallsFn } from "~/lib/send-calls";
import type { TokenAmount } from "~/lib/types";
import { odosBaseUrl, odosHeaders } from "./api/odos-client";
import { buildERC20ApprovalCalls } from "./tokens";

interface OdosQuoteResponse {
  pathId: string;
  outAmounts?: string[]; // Amount in smallest unit (wei, etc.)
  outValues?: number[]; // Converted to USD value
}

interface OdosAssembleResponse {
  transaction: {
    to: Address;
    data: Hex;
    value: string;
  };
}

const odosQuoteUrl = () => `${odosBaseUrl()}/sor/quote/v3`;
const odosAssembleUrl = () => `${odosBaseUrl()}/sor/assemble`;

/**
 * Slippage tolerance (percent) baked into the assembled tx's `outputMin`.
 *
 */
const SLIPPAGE_LIMIT_PERCENT = 0.5;

const odosRouterV3Abi = parseAbi([
  "event Swap(address sender, uint256 inputAmount, address inputToken, uint256 amountOut, address outputToken, int256 slippage, uint64 referralCode, uint64 referralFee, address referralFeeRecipient)",
  "event SwapMulti(address sender, uint256[] amountsIn, address[] tokensIn, uint256[] amountsOut, address[] tokensOut, int256[] slippage, uint64 referralCode, uint64 referralFee, address referralFeeRecipient)",
]);

async function fetchJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: odosHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Request failed (${res.status}): ${text}`);
  }
  return (await res.json()) as T;
}

/**
 * Sums per-`tokenAddress` so the Odos `/sor/quote/v3` payload doesn't include
 * the same token twice. Odos rejects repeated `inputTokens[].tokenAddress`
 * with "input cannot be repeated" — and we hit that whenever `step.inputTokens`
 * legitimately carries multiple `TokenAmount`s for the same on-chain token
 * (e.g. on the destination chain after a CCTP claim, the user's pre-existing
 * USDC and the claim-output USDC sit in `step.inputTokens` as two entries
 * with different `provenance` so dependency tracking and `recalculatePlan`
 * stay correct). The Odos request only cares about totals per address, so
 * collapse here without touching the upstream plan.
 *
 * Addresses go through `getAddress` so EIP-55 case differences don't split
 * the same token across two buckets.
 */
function dedupeOdosInputs(inputTokens: TokenAmount[]): { tokenAddress: Address; amount: string }[] {
  const sums = new Map<Address, bigint>();
  for (const t of inputTokens) {
    const key = getAddress(t.token);
    sums.set(key, (sums.get(key) ?? 0n) + t.amount);
  }
  return Array.from(sums.entries()).map(([tokenAddress, amount]) => ({
    tokenAddress,
    amount: amount.toString(),
  }));
}

/**
 * Fetches a swap quote from Odos.
 * @param inputTokens - The tokens to swap.
 * @param outputToken - The output token.
 * @returns The quote that will be used to assemble the swap transaction.
 */
async function fetchSwapQuote(
  inputTokens: TokenAmount[],
  outputToken: Omit<TokenAmount, "amount">,
  simple: boolean = false,
): Promise<OdosQuoteResponse> {
  const quoteBody = {
    chainId: outputToken.chainId,
    inputTokens: dedupeOdosInputs(inputTokens),
    outputTokens: [
      {
        tokenAddress: outputToken.token,
        proportion: 1,
      },
    ],
    userAddr: inputTokens[0].walletAddress,
    slippageLimitPercent: SLIPPAGE_LIMIT_PERCENT,
    referralFee: OCTOCASH_REFERRAL_FEE,
    referralFeeRecipient: OCTOCASH_FEE_RECIPIENT,
    disableRFQs: true,
    compact: false,
    simple,
  };
  const quote = await fetchJson<OdosQuoteResponse>(odosQuoteUrl(), quoteBody);
  return quote;
}

export async function buildOdosCalls(tokensToSwap: TokenAmount[], tokenOut: TokenAmount): Promise<Call[]> {
  const userAddr = tokensToSwap[0].walletAddress;
  const quote = await fetchSwapQuote(tokensToSwap, tokenOut);
  const assembleBody = {
    userAddr,
    pathId: quote.pathId,
    simulate: false,
  };
  const assembled = await fetchJson<OdosAssembleResponse>(odosAssembleUrl(), assembleBody);
  const { to, data, value } = assembled.transaction;
  // The referral fee is already baked into this calldata by Odos (see
  // `fetchSwapQuote`), so the assembled swap is sent verbatim.
  const swapCall: Call = { to, data, value: BigInt(value) };
  return [...(await buildERC20ApprovalCalls(tokensToSwap, to)), swapCall];
}

/**
 * Executes an Odos swap to convert tokens to a different token on the same chain.
 * @param tokensIn - The tokens to swap (must be different from tokenOut).
 * @param tokenOut - The token to swap to.
 * @param sendCalls - The function to send the calls.
 * @returns Object containing the amount of output token and transaction hash.
 */
export async function executeOdosSwap(
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
  const calls = await buildOdosCalls(tokensIn, tokenOut);
  const [transactionHash, logs] = await sendCalls("swap", chainId, wallet, calls, "atomic-steps", retryHints);
  const flattenedLogs = logs.flat();

  const amount = deriveSwapOutputAmount(flattenedLogs as Log[], tokenOut);

  return { amount, transactionHash };
}

/**
 * Derive the swap's actual output amount from receipt logs.
 *
 * Primary path: parse Odos `Swap` / `SwapMulti` events from the V3 router.
 *
 * Fallback (matters when Odos routes through a path that doesn't emit those
 * events, or when the on-chain event signature drifts from our ABI): sum
 * standard ERC20 `Transfer` events to the user's wallet for the output token.
 * Multiple transfers to the user (e.g. fee remainder + main payout) naturally
 * sum to the net amount received.
 *
 * Last resort: if neither path yields a positive amount, return the most
 * recent quoted amount (`tokenOut.amount`) rather than throw — the on-chain
 * swap has already executed by the time we're here, and reporting failure
 * for a successful tx is worse than a slightly stale `actualOutput`.
 *
 * Native-token output is not handled here (Odos returns wrapped tokens for
 * native swaps in current routes); a balance-delta backstop via
 * `getTokenBalance` would be the natural extension if that changes.
 */
export function deriveSwapOutputAmount(logs: Log[], tokenOut: TokenAmount): bigint {
  const singleSwapLogs = parseEventLogs({
    abi: odosRouterV3Abi,
    eventName: "Swap",
    logs,
  });
  const multiSwapLogs = parseEventLogs({
    abi: odosRouterV3Abi,
    eventName: "SwapMulti",
    logs,
  });

  const primary = singleSwapLogs[0]?.args?.amountOut ?? multiSwapLogs[0]?.args?.amountsOut?.[0];
  if (primary !== undefined && primary > 0n) return primary;

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

  console.warn(
    "[odos] No Swap/SwapMulti event and no matching ERC20 Transfer found in receipt; falling back to quoted amount.",
  );
  return tokenOut.amount;
}

/**
 * Get a swap quote from Odos for planning purposes (T009)
 * @param input - The input token amount(s) - can be a single token or an array of tokens
 * @param outputToken - The output token address
 * @param chainId - The chain ID
 * @returns The estimated output token amount
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
    const quote = await fetchSwapQuote(inputTokens, outputToken, true);
    // `outAmounts` is already net of the referral fee (Odos deducts it server
    // side when `referralFee` is set), so it's used as-is.
    const outputAmount = quote.outAmounts?.[0] ? BigInt(quote.outAmounts[0]) : 0n;
    return {
      ...outputToken,
      amount: outputAmount,
    };
  } catch (error) {
    throw new Error(`ExternalAPIError: ${error instanceof Error ? error.message : "Odos quote failed"}`);
  }
}
