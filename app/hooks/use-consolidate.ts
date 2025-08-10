import { useState } from "react";
import {
  type Account,
  type Address,
  type Call,
  type Chain,
  type Hex,
  type HttpTransport,
  type Log,
  parseAbi,
  parseEventLogs,
  type WalletClient,
} from "viem";
import { usePublicClient } from "wagmi";
import { chains } from "~/data/supported-chains";
import { executeCCTPBurn, executeCCTPMint, retrieveAttestations } from "~/lib/cctp";
import { type ConsolidationProgressCallback, ConsolidationStep, type TokenAmount } from "~/lib/consolidation";
import { ensureSufficientGas } from "~/lib/gas";
import { addConsolidationRecord } from "~/lib/history";
import { executeOdosSwap } from "~/lib/odos";
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
  return async (
    txId: string,
    chainId: number,
    from: Address,
    calls: Call[],
  ): Promise<[string, { address: Address; data: Hex; topics: Hex[] }[]]> => {
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

    if (!tx || status.receipts?.[0]?.status === "reverted") {
      throw new Error(`${txId} transaction reverted`);
    }
    // Flatten all logs from all receipts into a single array
    const logs = status.receipts?.flatMap((r) => r.logs ?? []) ?? [];
    console.log(`${txId} Tx: ${tx}`);
    return [tx, logs];
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

/**
 * Executes a swap operation.
 * @param tokensIn - The tokens to swap.
 * @param tokenOut - The destination token.
 * @param walletClient - The wallet client.
 * @param onProgress - The progress callback.
 * @param step - The step to set.
 * @returns The resulting token.
 */
const executeSwap = async (
  tokensIn: TokenAmount[],
  tokenOut: TokenAmount,
  walletClient: WalletClient<HttpTransport, Chain, Account>,
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

  // If the input is already the desired token, skip the swap entirely
  if (tokensIn.length === 1 && tokensIn[0].token === tokenOut.token) {
    return {
      ...tokenOut,
      amount: tokensIn[0].amount,
    };
  }

  // Separate token that matches the target token from those that need swapping
  const matchingToken = tokensIn.find((token) => token.token === tokenOut.token);
  const tokensToSwap = tokensIn.filter((token) => token.token !== tokenOut.token);

  // Calculate existing amount of target token
  const existingAmount = matchingToken?.amount ?? 0n;

  // Swap remaining tokens
  const swapAmount = await executeOdosSwap(tokensToSwap, tokenOut, prepareSendCalls(walletClient));

  return {
    ...tokenOut,
    amount: existingAmount + swapAmount,
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
const executeBridge = async (
  tokensIn: TokenAmount[],
  tokenOut: TokenAmount,
  walletClient: WalletClient<HttpTransport, Chain, Account>,
  onProgress?: ConsolidationProgressCallback,
) => {
  // If the input is already the desired token on the destination chain, skip the bridge entirely
  if (tokensIn.flat().length === 1 && tokensIn.flat()[0].chainId === tokenOut.chainId) {
    return {
      ...tokenOut,
      amount: tokensIn.flat()[0].amount,
    };
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

/**
 * Consolidates tokens into a single token.
 * @returns The consolidation state.
 */
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
        // If the token is already on the destination chain, send it to the destination wallet (as we skip the bridge step)
        const walletToSend = chainId === destinationToken.chainId ? destinationToken.walletAddress : walletAddress;
        const usdcToken = tokenAddresses[chainId as keyof typeof tokenAddresses];
        const tokenOut = {
          token: usdcToken,
          amount: 0n,
          walletAddress: walletToSend,
          chainId,
        };
        resultingTokens.push(
          await executeSwap(_tokens, tokenOut, walletClient, setCurrentStep, ConsolidationStep.SWAPPING),
        );
      }

      const resultingToken = await executeBridge(resultingTokens, destinationToken, walletClient, setCurrentStep);

      const finalToken = await executeSwap(
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
