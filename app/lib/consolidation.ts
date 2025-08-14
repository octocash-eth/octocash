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
import { chains } from "~/data/supported-chains";
import { executeCCTPBurn, executeCCTPMint, retrieveAttestations } from "./cctp";
import { executeOdosSwapOrTransfer } from "./odos";

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

export type SendCallsFn = (
  txId: string,
  chainId: number,
  from: Address,
  calls: Call[],
) => Promise<[string, { address: Address; data: Hex; topics: Hex[] }[]]>;

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
