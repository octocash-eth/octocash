import { useState } from "react";
import type { Account, Address, Chain, HttpTransport, WalletClient } from "viem";
import { useConsolidationRecords } from "~/hooks/use-consolidation-records";
import {
  executeConsolidation as _executeConsolidation,
  ConsolidationStep,
  type TokenAmount,
} from "~/lib/consolidation";

/**
 * Consolidates tokens into a single token.
 * @returns The consolidation state.
 */
export function useConsolidate() {
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
      const finalToken = await _executeConsolidation({
        sourceTokens,
        destinationToken,
        sendTo,
        walletClient,
        setCurrentStep,
      });
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
