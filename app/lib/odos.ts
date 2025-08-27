import {
  type Address,
  type Call,
  encodeFunctionData,
  type Hex,
  type Log,
  parseAbi,
  parseEventLogs,
  zeroAddress,
} from "viem";
import type { TokenAmount } from "~/lib/consolidation";
import type { SendCallsFn } from "~/lib/send-calls";

interface OdosQuoteResponse {
  pathId: string;
}

interface OdosAssembleResponse {
  transaction: {
    to: Address;
    data: Hex;
    value: string;
  };
}

const ODOS_QUOTE_URL = "https://api.odos.xyz/sor/quote/v2";
const ODOS_ASSEMBLE_URL = "https://api.odos.xyz/sor/assemble";

const swapAbi = parseAbi([
  "event Swap(address sender, uint256 inputAmount, address inputToken, uint256 amountOut, address outputToken, int256 slippage, uint32 referralCode)",
  "event SwapMulti(address sender, uint256[] amountsIn, address[] tokensIn, uint256[] amountsOut, address[] tokensOut, uint32 referralCode)",
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
    if (t.token.toLowerCase() === zeroAddress) continue;
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

function buildTransferCall(token: TokenAmount, to: Address): Call {
  return {
    to: token.token,
    data: encodeFunctionData({
      abi: parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]),
      args: [to, token.amount],
    }),
  };
}

async function buildOdosCalls(
  tokensToSwap: TokenAmount[],
  tokenOut: TokenAmount,
  _sendCalls: SendCallsFn,
): Promise<Call[]> {
  const chainId = tokensToSwap[0].chainId;
  const userAddr = tokensToSwap[0].walletAddress;

  const quoteBody = {
    chainId,
    inputTokens: tokensToSwap.map((token) => ({
      tokenAddress: token.token,
      amount: token.amount.toString(),
    })),
    outputTokens: [
      {
        tokenAddress: tokenOut.token,
        outputReceiver: tokenOut.walletAddress,
        proportion: 1,
      },
    ],
    userAddr,
    slippageLimitPercent: 0.3,
    referralCode: 0,
    disableRFQs: true,
    compact: true,
  };
  const quote = await fetchJson<OdosQuoteResponse>(ODOS_QUOTE_URL, quoteBody);

  const assembleBody = {
    userAddr,
    pathId: quote.pathId,
    simulate: true,
  };
  const assembled = await fetchJson<OdosAssembleResponse>(ODOS_ASSEMBLE_URL, assembleBody);
  const { to, data, value } = assembled.transaction;
  return [...buildApproveCalls(tokensToSwap, to), { to, data, value: BigInt(value) }];
}

/**
 * Executes the Odos swap.
 * @param tokensIn - The tokens to swap.
 * @param tokenOut - The token to swap to.
 * @param sendCalls - The function to send the calls.
 * @returns The amount of the output token.
 */
export async function executeOdosSwapOrTransfer(
  tokensIn: TokenAmount[],
  tokenOut: TokenAmount,
  sendCalls: SendCallsFn,
): Promise<bigint> {
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
    calls.push(...(await buildOdosCalls(tokensToSwap, tokenOut, sendCalls)));
  }

  if (tokenToTransfer) {
    calls.push(buildTransferCall(tokenToTransfer, tokenOut.walletAddress));
  }

  if (calls.length === 0) {
    return tokenThatStays?.amount || 0n;
  }

  const [_tx, logs] = await sendCalls("swap", chainId, wallet, calls);

  const singleSwapLogs = parseEventLogs({
    abi: swapAbi,
    eventName: "Swap",
    logs: logs as Log[],
  });

  const multiSwapLogs = parseEventLogs({
    abi: swapAbi,
    eventName: "SwapMulti",
    logs: logs as Log[],
  });

  const tokenOutAmount =
    (tokenToTransfer?.amount || 0n) +
    (tokenThatStays?.amount || 0n) +
    (singleSwapLogs[0]?.args?.amountOut || multiSwapLogs[0]?.args?.amountsOut?.[0] || 0n);

  if (!tokenOutAmount) {
    throw new Error("No output token amount found");
  }

  return tokenOutAmount;
}
