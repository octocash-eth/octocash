import { useState } from "react";
import type { Account, Address, Chain, HttpTransport, WalletClient } from "viem";
import { usePublicClient } from "wagmi";
import { tokenAddresses } from "~/data/cctp-contracts";
import {
  ConsolidationStep,
  executeBridge,
  executeSwapOrTransfer,
  groupTokensByWalletAndChain,
  type TokenAmount,
} from "~/lib/consolidation";
import { ensureSufficientGas } from "~/lib/gas";
import { addConsolidationRecord } from "~/lib/history";

/**
 * Consolidates tokens into a single token.
 * @returns The consolidation state.
 */
export function useConsolidate() {
  const publicClient = usePublicClient();
  const [currentStep, setCurrentStep] = useState<ConsolidationStep>(ConsolidationStep.IDLE);
  const [error, setError] = useState<string | null>(null);

  /**
   * Executes the consolidation.
   * @param sourceTokens - The tokens to consolidate.
   * @param destinationToken - The destination token.
   * @param sendTo - The wallet address to send the consolidated tokens to.
   * @param walletClient - The wallet client.
   */
  const executeConsolidation = async (
    sourceTokens: TokenAmount[],
    destinationToken: TokenAmount,
    sendTo: Address,
    walletClient: WalletClient<HttpTransport, Chain, Account>,
  ) => {
    console.log("executeConsolidation", sourceTokens, destinationToken);
    const startedAt = Date.now();
    const recordId = `${startedAt}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      if (!publicClient) {
        throw new Error("Public client not found");
      }

      // Pre-flight: ensure gas on each required chain
      await ensureSufficientGas(publicClient, sourceTokens, destinationToken);

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

      const bridgedToken = await executeBridge(tokensToBeBridged, destinationToken, walletClient, setCurrentStep);
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
      addConsolidationRecord({
        id: recordId,
        timestamp: startedAt,
        sourceTokens,
        destinationToken: finalToken,
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
