import { useState } from "react";
import type { Account, Address, Call, Chain, HttpTransport, WalletClient } from "viem";
import { usePublicClient } from "wagmi";
import { chains } from "~/data/supported-chains";
import { executeCCTP } from "~/lib/cctp";
import { type ConsolidationProgressCallback, ConsolidationStep, type TokenAmount } from "~/lib/consolidation";
import { ensureSufficientGas } from "~/lib/gas";
import { addConsolidationRecord } from "~/lib/history";
import { tokenAddresses } from "../data/cctp-contracts";

/**
 * Switches to the given chain. If the chain is not supported, it adds it to the wallet.
 * @param client - The wallet client.
 * @param chainId - The chain ID.
 * @returns The wallet client.
 */
const switchChain = async (client: WalletClient<HttpTransport, Chain, Account>, chainId: number) => {
  try {
    console.log("Switching to chain", chainId);
    await client.switchChain({ id: chainId });
  } catch (_err) {
    console.log("Adding chain", chainId);
    await client.addChain({
      chain: chains[chainId as keyof typeof chains] as Chain,
    });
  }
};

/**
 * Prepares a function that sends calls to the given chain.
 * @param client - The wallet client.
 * @returns A function that sends calls to the given chain.
 */
const prepareSendCalls = (client: WalletClient<HttpTransport, Chain, Account>) => {
  return async (txId: string, chainId: number, from: Address, calls: Call[]) => {
    await switchChain(client, chainId);
    const _calls = await client.sendCalls({
      account: from,
      chain: chains[chainId as keyof typeof chains] as Chain,
      forceAtomic: true,
      calls,
    });
    const status = await client.waitForCallsStatus({
      id: _calls.id,
    });
    const tx = status.receipts?.[0]?.transactionHash;
    if (!tx) {
      throw new Error(`${txId} transaction failed`);
    }
    console.log(`${txId} Tx: ${tx}`);
    return tx;
  };
};

/**
 * Group tokens by walletAddress and chainId
 * @param tokens - The tokens to group.
 * @returns The grouped tokens.
 */
function groupTokensByWalletAndChain(tokens: TokenAmount[]): TokenAmount[][] {
  return Object.values(
    tokens.reduce(
      (acc, token) => {
        const key = `${token.walletAddress}-${token.chainId}`;
        if (!acc[key]) {
          acc[key] = [];
        }
        acc[key].push(token);
        return acc;
      },
      {} as Record<string, TokenAmount[]>,
    ),
  );
}

const executeSwap = async (
  tokensIn: TokenAmount[],
  tokenOut: TokenAmount,
  _walletClient: WalletClient<HttpTransport, Chain, Account>,
  onProgress?: ConsolidationProgressCallback,
  step: ConsolidationStep = ConsolidationStep.SWAPPING,
) => {
  // Check if the tokens are on the same chain, otherwise throw an error
  for (const token of tokensIn) {
    if (token.chainId !== tokenOut.chainId) {
      throw new Error("Tokens are not on the same chain");
    }
  }
  onProgress?.(step);
  let amount = 0n;
  for (const token of tokensIn) {
    if (token.token === tokenOut.token) {
      amount += token.amount;
    } else {
      // TODO: Implement the swap
      console.log("token", token);
      console.log("tokenOut", tokenOut);
      throw new Error("Swap not implemented");
    }
  }
  return {
    token: tokenOut.token,
    amount,
    walletAddress: tokenOut.walletAddress,
    chainId: tokenOut.chainId,
  };
};

/**
 * Executes the bridge operation.
 * @param tokensIn - The tokens to bridge, grouped by wallet and chain.
 * @param tokenOut - The destination token.
 * @param walletClient - The wallet client.
 * @returns The resulting token.
 */
const executeBridge = async (
  tokensIn: TokenAmount[][],
  tokenOut: TokenAmount,
  walletClient: WalletClient<HttpTransport, Chain, Account>,
  onProgress?: ConsolidationProgressCallback,
) => {
  const sendCalls = prepareSendCalls(walletClient);
  const _tx = await executeCCTP(tokensIn, tokenOut, sendCalls, onProgress);
  return {
    token: tokenOut.token,
    amount: 0n,
    walletAddress: tokenOut.walletAddress,
    chainId: tokenOut.chainId,
  };
};

export function useConsolidate() {
  const publicClient = usePublicClient();
  const [currentStep, setCurrentStep] = useState<ConsolidationStep>(ConsolidationStep.IDLE);
  const [error, setError] = useState<string | null>(null);

  const executeConsolidation = async (
    sourceTokens: TokenAmount[],
    destinationToken: TokenAmount,
    walletClient: WalletClient<HttpTransport, Chain, Account>,
  ) => {
    const startedAt = Date.now();
    const recordId = `${startedAt}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      if (!publicClient) {
        throw new Error("Public client not found");
      }

      // Pre-flight: ensure gas on each required chain
      await ensureSufficientGas(publicClient, sourceTokens, destinationToken);

      const groupedTokens = groupTokensByWalletAndChain(sourceTokens);
      const resultingTokens: TokenAmount[] = [];

      for (const _tokens of groupedTokens) {
        const { chainId, walletAddress } = _tokens[0];
        const usdcToken = tokenAddresses[chainId as keyof typeof tokenAddresses];
        const tokenOut = {
          token: usdcToken,
          amount: 0n,
          walletAddress,
          chainId,
        };
        resultingTokens.push(
          await executeSwap(_tokens, tokenOut, walletClient, setCurrentStep, ConsolidationStep.SWAPPING),
        );
      }

      const groupedResultingTokens = groupTokensByWalletAndChain(resultingTokens);

      const resultingToken = await executeBridge(
        groupedResultingTokens,
        destinationToken,
        walletClient,
        setCurrentStep,
      );

      await executeSwap(
        [resultingToken],
        destinationToken,
        walletClient,
        setCurrentStep,
        ConsolidationStep.SWAPPING_BACK,
      );
      setCurrentStep(ConsolidationStep.COMPLETED);

      addConsolidationRecord({
        id: recordId,
        timestamp: startedAt,
        sourceTokens,
        destinationToken,
        status: "completed",
      });
    } catch (err) {
      setCurrentStep(ConsolidationStep.ERROR);
      setError(err instanceof Error ? err.message : "Consolidation failed");
      addConsolidationRecord({
        id: recordId,
        timestamp: startedAt,
        sourceTokens,
        destinationToken,
        status: "error",
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  };

  const reset = () => {
    setCurrentStep(ConsolidationStep.IDLE);
    setError(null);
  };

  return {
    currentStep,
    error,
    executeConsolidation,
    reset,
  };
}
