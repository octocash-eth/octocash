import { useState } from "react";
import type { Account, Address, Chain, HttpTransport, WalletClient } from "viem";
import { usePublicClient } from "wagmi";
import { tokenAddresses } from "~/data/cctp-contracts";
import { useConsolidationRecords } from "~/hooks/use-consolidation-records";
import {
  ConsolidationStep,
  executeBridge,
  executeSwapOrTransfer,
  groupTokensByWalletAndChain,
  type TokenAmount,
} from "~/lib/consolidation";
import { ensureSufficientGas } from "~/lib/gas";

/**
 * Consolidates tokens into a single token.
 * @returns The consolidation state.
 */
export function useConsolidate() {
  const _publicClient = usePublicClient();
  const [currentStep, setCurrentStep] = useState<ConsolidationStep>(ConsolidationStep.IDLE);
  const [error, setError] = useState<string | null>(null);
  const [, setRecords] = useConsolidationRecords();

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
    const recordId = crypto.randomUUID();
    try {
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
      setRecords((prev) => [
        {
          id: recordId,
          timestamp: Date.now(),
          sourceTokens,
          destinationToken: finalToken,
          status: "completed",
        },
        ...prev,
      ]);
    } catch (err) {
      setCurrentStep(ConsolidationStep.ERROR);
      setError(err instanceof Error ? err.message : "Consolidation failed");
      setRecords((prev) => [
        {
          id: recordId,
          timestamp: Date.now(),
          sourceTokens,
          destinationToken,
          status: "error",
          errorMessage: err instanceof Error ? err.message : String(err),
        },
        ...prev,
      ]);
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
