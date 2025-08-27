import {
  type Account,
  type Address,
  type Chain,
  type HttpTransport,
  type Log,
  parseAbi,
  parseEventLogs,
  type WalletClient,
} from "viem";
import { tokenAddresses } from "~/data/cctp-contracts";
import { executeCCTPBurn, executeCCTPMint, retrieveAttestations } from "./cctp";
import { executeOdosSwapOrTransfer } from "./odos";
import { prepareSendCalls } from "./send-calls";

export enum ConsolidationStep {
  IDLE = "idle",
  SWAPPING = "swapping",
  BURNING = "burning",
  WAITING_ATTESTATION = "waiting-attestation",
  MINTING = "minting",
  SWAPPING_BACK = "swapping-back",
  COMPLETED = "completed",
  ERROR = "error",
}

export interface TokenAmount {
  token: Address;
  amount: bigint;
  walletAddress: Address;
  chainId: number;
}

export type ConsolidationProgressCallback = (step: ConsolidationStep) => void;

/**
 * Group tokens by walletAddress and chainId, merging tokens with the same token address, wallet address, and chain id.
 * @param tokens - The tokens to group.
 * @returns The grouped tokens.
 */
export function groupTokensByWalletAndChain(tokens: TokenAmount[]): TokenAmount[][] {
  const groupedByWalletAndChain = tokens.reduce(
    (acc, token) => {
      const groupKey = `${token.walletAddress}-${token.chainId}`;
      if (!acc[groupKey]) {
        acc[groupKey] = {} as Record<string, TokenAmount>;
      }

      const tokenKey = token.token as string;
      const existing = acc[groupKey][tokenKey];
      if (existing) {
        acc[groupKey][tokenKey] = { ...existing, amount: existing.amount + token.amount };
      } else {
        acc[groupKey][tokenKey] = { ...token };
      }

      return acc;
    },
    {} as Record<string, Record<string, TokenAmount>>,
  );

  return Object.values(groupedByWalletAndChain).map((tokenMap) => Object.values(tokenMap));
}

/**
 * Executes a swap operation.
 * @param tokensIn - The tokens to swap.
 * @param tokenOut - The destination token.
 * @param walletClient - The wallet client.
 * @param onProgress - The progress callback.
 * @param step - The step to set.
 * @returns The resulting token.
 */
export const executeSwapOrTransfer = async (
  tokensIn: TokenAmount[],
  tokenOut: TokenAmount,
  walletClient: WalletClient<HttpTransport, Chain, Account>,
  onProgress?: ConsolidationProgressCallback,
  step: ConsolidationStep = ConsolidationStep.SWAPPING,
) => {
  onProgress?.(step);

  const amount = await executeOdosSwapOrTransfer(tokensIn, tokenOut, prepareSendCalls(walletClient));

  return {
    ...tokenOut,
    amount,
  };
};

/**
 * Executes the bridge operation.
 * @param tokensIn - The tokens to bridge.
 * @param tokenOut - The destination token.
 * @param walletClient - The wallet client.
 * @param onProgress - The progress callback.
 * @returns The resulting token.
 */
export const executeBridge = async (
  tokensIn: TokenAmount[],
  tokenOut: TokenAmount,
  walletClient: WalletClient<HttpTransport, Chain, Account>,
  onProgress?: ConsolidationProgressCallback,
) => {
  for (const token of tokensIn) {
    if (token.chainId === tokenOut.chainId) {
      throw new Error("Tokens are already on the same chain");
    }
    if (token.token !== tokenAddresses[token.chainId as keyof typeof tokenAddresses]) {
      throw new Error(`Token ${token.token} on chain ${token.chainId} is not USDC`);
    }
  }
  if (tokenOut.token !== tokenAddresses[tokenOut.chainId as keyof typeof tokenAddresses]) {
    throw new Error(`Token ${tokenOut.token} on chain ${tokenOut.chainId} is not USDC`);
  }

  if (tokensIn.flat().length === 0) {
    return tokenOut;
  }

  const sendCalls = prepareSendCalls(walletClient);

  // Separate token that matches the target token from those that need bridging
  const matchingToken = tokensIn.find((token) => token.chainId === tokenOut.chainId);
  const tokensToBridge = tokensIn.filter((token) => token.chainId !== tokenOut.chainId);

  const existingAmount = matchingToken?.amount ?? 0n;

  onProgress?.(ConsolidationStep.BURNING);
  const burnTxsAndChainIds: [string, number][] = [];
  for (const token of tokensToBridge) {
    const [tx, chainId] = await executeCCTPBurn(token, tokenOut, sendCalls);
    burnTxsAndChainIds.push([tx, chainId]);
  }

  onProgress?.(ConsolidationStep.WAITING_ATTESTATION);
  const attestations = await retrieveAttestations(burnTxsAndChainIds);

  onProgress?.(ConsolidationStep.MINTING);
  const [_mintTx, logs] = await executeCCTPMint(attestations, tokenOut, sendCalls);

  const txs = parseEventLogs({
    abi: parseAbi([
      "event MintAndWithdraw(address indexed mintRecipient, uint256 amount, address indexed mintToken, uint256 feeCollected)",
    ]),
    eventName: "MintAndWithdraw",
    logs: logs as Log[],
  });

  const tokenOutAmount = txs[0]?.args?.amount ?? 0n;

  return {
    token: tokenOut.token,
    amount: existingAmount + tokenOutAmount,
    walletAddress: tokenOut.walletAddress,
    chainId: tokenOut.chainId,
  };
};
