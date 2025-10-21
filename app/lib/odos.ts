import {
  type Address,
  type Call,
  decodeFunctionData,
  encodeFunctionData,
  type Hex,
  type Log,
  parseAbi,
  parseEventLogs,
  zeroAddress,
} from "viem";
import { OCTOCASH_REFERRAL_INFO } from "~/data/odos";
import type { SendCallsFn } from "~/lib/send-calls";
import type { TokenAmount } from "~/lib/types";

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

const ODOS_QUOTE_URL = "https://api.odos.xyz/sor/quote/v3";
const ODOS_ASSEMBLE_URL = "https://api.odos.xyz/sor/assemble";

const odosRouterV3Abi = parseAbi([
  "event Swap(address sender, uint256 inputAmount, address inputToken, uint256 amountOut, address outputToken, int256 slippage, uint64 referralCode, uint64 referralFee, address referralFeeRecipient)",
  "event SwapMulti(address sender, uint256[] amountsIn, address[] tokensIn, uint256[] amountsOut, address[] tokensOut, int256[] slippage, uint64 referralCode, uint64 referralFee, address referralFeeRecipient)",
  "function swap((address inputToken, uint256 inputAmount, address inputReceiver, address outputToken, uint256 outputQuote, uint256 outputMin, address outputReceiver) tokenInfo, bytes pathDefinition, address executor, (uint64 code, uint64 fee, address feeRecipient) referralInfo) payable returns (uint256 amountOut)",
  "function swapMulti((address tokenAddress, uint256 amountIn, address receiver)[] inputs, (address tokenAddress, uint256 amountQuote, uint256 amountMin, address receiver)[] outputs, bytes pathDefinition, address executor, (uint64 code, uint64 fee, address feeRecipient) referralInfo) payable returns (uint256[] amountsOut)",
  // "function swapCompact() payable returns (uint256)",
  // "function swapMultiCompact() payable returns (uint256[] amountsOut)",
  // "function swapMultiPermit2((address contractAddress, uint256 nonce, uint256 deadline, bytes signature) permit2, (address tokenAddress, uint256 amountIn, address receiver)[] inputs, (address tokenAddress, uint256 amountQuote, uint256 amountMin, address receiver)[] outputs, bytes pathDefinition, address executor, (uint64 code, uint64 fee, address feeRecipient) referralInfo) payable returns (uint256[] amountsOut)",
  // "function swapMultiPermit2WithHook((address contractAddress, uint256 nonce, uint256 deadline, bytes signature) permit2, (address tokenAddress, uint256 amountIn, address receiver)[] inputs, (address tokenAddress, uint256 amountQuote, uint256 amountMin, address receiver)[] outputs, bytes pathDefinition, address executor, (uint64 code, uint64 fee, address feeRecipient) referralInfo, address hookTarget, bytes hookData) payable returns (uint256[] amountsOut)",
  // "function swapMultiWithHook((address tokenAddress, uint256 amountIn, address receiver)[] inputs, (address tokenAddress, uint256 amountQuote, uint256 amountMin, address receiver)[] outputs, bytes pathDefinition, address executor, (uint64 code, uint64 fee, address feeRecipient) referralInfo, address hookTarget, bytes hookData) payable returns (uint256[] amountsOut)",
  // "function swapPermit2((address contractAddress, uint256 nonce, uint256 deadline, bytes signature) permit2, (address inputToken, uint256 inputAmount, address inputReceiver, address outputToken, uint256 outputQuote, uint256 outputMin, address outputReceiver) tokenInfo, bytes pathDefinition, address executor, (uint64 code, uint64 fee, address feeRecipient) referralInfo) returns (uint256 amountOut)",
  // "function swapPermit2WithHook((address contractAddress, uint256 nonce, uint256 deadline, bytes signature) permit2, (address inputToken, uint256 inputAmount, address inputReceiver, address outputToken, uint256 outputQuote, uint256 outputMin, address outputReceiver) tokenInfo, bytes pathDefinition, address executor, (uint64 code, uint64 fee, address feeRecipient) referralInfo, address hookTarget, bytes hookData) returns (uint256 amountOut)",
  // "function swapWithHook((address inputToken, uint256 inputAmount, address inputReceiver, address outputToken, uint256 outputQuote, uint256 outputMin, address outputReceiver) tokenInfo, bytes pathDefinition, address executor, (uint64 code, uint64 fee, address feeRecipient) referralInfo, address hookTarget, bytes hookData) payable returns (uint256 amountOut)",
]);

async function fetchJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Request failed (${res.status}): ${text}`);
  }
  return (await res.json()) as T;
}

/**
 * Builds the approve calls for the given tokens.
 * @param inputs - The tokens to approve.
 * @param router - The Odos router address.
 * @returns The approve calls.
 */
function buildApproveCalls(inputs: TokenAmount[], router: Address): Call[] {
  const calls: Call[] = [];
  const seen = new Set<string>();
  for (const t of inputs) {
    const key = `${t.chainId}:${t.walletAddress}:${t.token}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // Skip native coin (it doesn't need to be approved)
    if (t.token === zeroAddress) continue;
    // Skip tokens that don't need to be approved
    if (t.amount === 0n) continue;
    calls.push({
      to: t.token,
      data: encodeFunctionData({
        abi: parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]),
        args: [router, t.amount],
      }),
    });
  }
  return calls;
}

/**
 * Builds the transfer call for the given token.
 * @param token - The token to transfer.
 * @param to - The address to transfer to.
 * @returns The transfer call.
 */
function buildTransferCall(token: TokenAmount, to: Address): Call {
  return {
    to: token.token,
    data: encodeFunctionData({
      abi: parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]),
      args: [to, token.amount],
    }),
  };
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
    inputTokens: inputTokens.map((token) => ({
      tokenAddress: token.token,
      amount: token.amount.toString(),
    })),
    outputTokens: [
      {
        tokenAddress: outputToken.token,
        proportion: 1,
      },
    ],
    userAddr: inputTokens[0].walletAddress,
    slippageLimitPercent: 0.3,
    referralCode: 0,
    disableRFQs: true,
    compact: false,
    simple,
  };
  const quote = await fetchJson<OdosQuoteResponse>(ODOS_QUOTE_URL, quoteBody);
  return quote;
}

function applyFee(amount: bigint): bigint {
  return (amount * (1000000000000000000n - OCTOCASH_REFERRAL_INFO.fee)) / 1000000000000000000n;
}

function addReferralInfo(to: Address, data: Hex, value: bigint): Call {
  const decoded = decodeFunctionData({
    abi: odosRouterV3Abi,
    data,
  });
  if (decoded.functionName === "swap") {
    const [tokenInfo, pathDefinition, executor] = decoded.args as [
      {
        inputToken: `0x${string}`;
        inputAmount: bigint;
        inputReceiver: `0x${string}`;
        outputToken: `0x${string}`;
        outputQuote: bigint;
        outputMin: bigint;
        outputReceiver: `0x${string}`;
      },
      `0x${string}`,
      `0x${string}`,
      {
        code: bigint;
        fee: bigint;
        feeRecipient: `0x${string}`;
      },
    ];

    const tokenInfoAfterFee = {
      ...tokenInfo,
      outputMin: applyFee(tokenInfo.outputMin),
    };

    const encoded = encodeFunctionData({
      abi: odosRouterV3Abi,
      functionName: "swap",
      args: [tokenInfoAfterFee, pathDefinition, executor, OCTOCASH_REFERRAL_INFO],
    });

    return { to, data: encoded, value };
  }

  if (decoded.functionName === "swapMulti") {
    const [inputs, outputs, pathDefinition, executor] = decoded.args as [
      {
        tokenAddress: `0x${string}`;
        amountIn: bigint;
        receiver: `0x${string}`;
      }[],
      {
        tokenAddress: `0x${string}`;
        amountQuote: bigint;
        amountMin: bigint;
        receiver: `0x${string}`;
      }[],
      `0x${string}`,
      `0x${string}`,
      {
        code: bigint;
        fee: bigint;
        feeRecipient: `0x${string}`;
      },
    ];

    const outputsAfterFee = outputs.map((output) => ({
      ...output,
      amountMin: applyFee(output.amountMin),
    }));

    const encoded = encodeFunctionData({
      abi: odosRouterV3Abi,
      functionName: "swapMulti",
      args: [inputs, outputsAfterFee, pathDefinition, executor, OCTOCASH_REFERRAL_INFO],
    });

    return { to, data: encoded, value };
  }
  return { to, data, value };
}

export async function buildOdosCalls(tokensToSwap: TokenAmount[], tokenOut: TokenAmount): Promise<Call[]> {
  const userAddr = tokensToSwap[0].walletAddress;
  const quote = await fetchSwapQuote(tokensToSwap, tokenOut);
  const assembleBody = {
    userAddr,
    pathId: quote.pathId,
    simulate: false,
  };
  const assembled = await fetchJson<OdosAssembleResponse>(ODOS_ASSEMBLE_URL, assembleBody);
  const { to, data, value } = assembled.transaction;
  const swapWithRerralInfo = addReferralInfo(to, data, BigInt(value));
  return [...buildApproveCalls(tokensToSwap, to), swapWithRerralInfo];
}

/**
 * Executes the Odos swap.
 * @param tokensIn - The tokens to swap.
 * @param tokenOut - The token to swap to.
 * @param sendCalls - The function to send the calls.
 * @returns Object containing the amount of output token and transaction hash (if transaction was sent).
 */
export async function executeOdosSwapOrTransfer(
  tokensIn: TokenAmount[],
  tokenOut: TokenAmount,
  sendCalls: SendCallsFn,
): Promise<{ amount: bigint; transactionHash?: string }> {
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

  const tokensToSwap = tokensIn.filter((token) => token.token !== tokenOut.token);
  const tokenToTransfer = tokensIn.find(
    (token) => token.token === tokenOut.token && token.walletAddress !== tokenOut.walletAddress,
  );
  const tokenThatStays = tokensIn.find(
    (token) => token.token === tokenOut.token && token.walletAddress === tokenOut.walletAddress,
  );

  const calls: Call[] = [];

  if (tokensToSwap.length > 0) {
    calls.push(...(await buildOdosCalls(tokensToSwap, tokenOut)));
  }

  if (tokenToTransfer) {
    calls.push(buildTransferCall(tokenToTransfer, tokenOut.walletAddress));
  }

  if (calls.length === 0) {
    return { amount: tokenThatStays?.amount || 0n };
  }

  const [transactionHash, logs] = await sendCalls("swap", chainId, wallet, calls, "atomic-steps");
  const flattenedLogs = logs.flat();

  const singleSwapLogs = parseEventLogs({
    abi: odosRouterV3Abi,
    eventName: "Swap",
    logs: flattenedLogs as Log[],
  });

  const multiSwapLogs = parseEventLogs({
    abi: odosRouterV3Abi,
    eventName: "SwapMulti",
    logs: flattenedLogs as Log[],
  });

  const amount =
    (tokenToTransfer?.amount || 0n) +
    (tokenThatStays?.amount || 0n) +
    (singleSwapLogs[0]?.args?.amountOut || multiSwapLogs[0]?.args?.amountsOut?.[0] || 0n);

  if (!amount) {
    throw new Error("No output token amount found");
  }

  return { amount, transactionHash };
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
    const outputAmount = quote.outAmounts?.[0] ? BigInt(quote.outAmounts[0]) : 0n;
    return {
      ...outputToken,
      amount: applyFee(outputAmount),
      walletAddress: firstWallet,
    };
  } catch (error) {
    throw new Error(`ExternalAPIError: ${error instanceof Error ? error.message : "Odos quote failed"}`);
  }
}
