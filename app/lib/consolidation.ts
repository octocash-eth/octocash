import type { Account, Address, Chain, HttpTransport, WalletClient } from "viem";
import { tokenAddresses } from "~/data/cctp-contracts";
import { type Attestation, executeCCTPBurn, executeCCTPMint, retrieveAttestations } from "./cctp";
import { ensureSufficientGas } from "./gas";
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

  onProgress?.(ConsolidationStep.BURNING);
  const burnTxsAndChainIds: [string, number][] = [];
  for (const token of tokensIn) {
    const [tx, chainId] = await executeCCTPBurn(token, tokenOut, sendCalls);
    burnTxsAndChainIds.push([tx, chainId]);
  }

  onProgress?.(ConsolidationStep.WAITING_ATTESTATION);
  const attestations: Attestation[] = await retrieveAttestations(burnTxsAndChainIds);

  const tokenOutAmount = attestations.reduce(
    (sum, attestation) =>
      sum +
      BigInt(attestation.decodedMessage.decodedMessageBody.amount) -
      BigInt(attestation.decodedMessage.decodedMessageBody.feeExecuted),
    0n,
  );

  onProgress?.(ConsolidationStep.MINTING);
  const [_mintTx, _logs] = await executeCCTPMint(attestations, tokenOut, sendCalls);
  return {
    token: tokenOut.token,
    amount: tokenOutAmount,
    walletAddress: tokenOut.walletAddress,
    chainId: tokenOut.chainId,
  };
};

/**
 * Executes the consolidation.
 * @param sourceTokens - The tokens to consolidate.
 * @param destinationToken - The destination token.
 * @param sendTo - The wallet address to send the consolidated tokens to.
 * @param walletClient - The wallet client.
 * @param setCurrentStep - The function to set the current step.
 * @returns
 */
export async function executeConsolidation({
  sourceTokens,
  destinationToken,
  sendTo,
  walletClient,
  setCurrentStep,
}: {
  sourceTokens: TokenAmount[];
  destinationToken: TokenAmount;
  sendTo: Address;
  walletClient: WalletClient<HttpTransport, Chain, Account>;
  setCurrentStep: (step: ConsolidationStep) => void;
}) {
  // Pre-flight: ensure gas on each required chain
  await ensureSufficientGas(sourceTokens, destinationToken);

  const groupedTokens = groupTokensByWalletAndChain(sourceTokens);
  const tokensInDestinationChain: TokenAmount[] = [];
  const tokensToBeBridged: TokenAmount[] = [];

  for (const _tokens of groupedTokens) {
    const { chainId, walletAddress } = _tokens[0];
    if (chainId === destinationToken.chainId) {
      tokensInDestinationChain.push(..._tokens);
    } else {
      const usdcToken = tokenAddresses[chainId as keyof typeof tokenAddresses];
      const tokenOut = {
        token: usdcToken,
        amount: 0n,
        walletAddress,
        chainId,
      };
      tokensToBeBridged.push(
        await executeSwapOrTransfer(_tokens, tokenOut, walletClient, setCurrentStep, ConsolidationStep.SWAPPING),
      );
    }
  }

  const usdcToken = {
    ...destinationToken,
    token: tokenAddresses[destinationToken.chainId as keyof typeof tokenAddresses],
  };

  const bridgedToken = await executeBridge(tokensToBeBridged, usdcToken, walletClient, setCurrentStep);
  const groupedTokensInDestinationChain = groupTokensByWalletAndChain([...tokensInDestinationChain, bridgedToken]);

  const resultingTokens: TokenAmount[] = [];
  for (const _tokens of groupedTokensInDestinationChain) {
    const tokenOut: TokenAmount = {
      ...destinationToken,
      walletAddress: sendTo,
    };
    resultingTokens.push(
      await executeSwapOrTransfer(_tokens, tokenOut, walletClient, setCurrentStep, ConsolidationStep.SWAPPING_BACK),
    );
  }

  setCurrentStep(ConsolidationStep.COMPLETED);

  const finalToken: TokenAmount = {
    ...destinationToken,
    amount: resultingTokens.reduce((acc, token) => acc + token.amount, 0n),
    walletAddress: sendTo,
  };

  return finalToken;
}
