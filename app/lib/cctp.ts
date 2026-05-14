import { type Address, type Call, type Chain, encodeFunctionData, type Hex, pad, parseAbi } from "viem";
import { chainIdToDomain, messageTransmitter, tokenAddresses, tokenMessenger } from "~/data/cctp-contracts";
import { chains } from "~/data/supported-chains";
import { getPublicClient } from "~/lib/public-client";
import type { SendCallsFn } from "~/lib/send-calls";
import type { TokenAmount } from "~/lib/types";
import { buildERC20ApprovalCalls } from "./tokens";

export type Attestation = {
  message: `0x${string}`;
  attestation: `0x${string}`;
  status: string;
  decodedMessage: {
    nonce: `0x${string}`;
    destinationDomain: string;
    decodedMessageBody: {
      amount: string;
      feeExecuted: string;
    };
  };
};

/**
 * Fast = `minFinalityThreshold` 1000 (confirmed). Small fee, seconds-to-minutes.
 * Standard = 2000 (finalized). Typically free, ~13-19 minutes.
 * Per CCTP v2: values <=1000 are treated as 1000, anything >1000 as 2000.
 */
export type TransferType = "fast" | "standard";

const CIRCLE_API_BASE = "https://iris-api.circle.com";

const MAX_FEE_BUFFER_NUM = 110n;
const MAX_FEE_BUFFER_DENOM = 100n;
const BPS_DENOM = 10_000n;
// Circle occasionally returns a fractional `minimumFee` (e.g. 1.3 bps). Scale
// the bps before converting to BigInt so we preserve sub-bps precision without
// blowing up on `BigInt(1.3)`.
const BPS_SCALE = 1_000_000n;

const ATTESTATION_TIMEOUT_MS = 20 * 60 * 1000;
const ATTESTATION_POLL_INTERVAL_MS = 5_000;

export class AttestationTimeoutError extends Error {
  constructor(
    public readonly transactionHash: string,
    public readonly sourceChainId: number,
  ) {
    super(`Attestation retrieval timed out for tx ${transactionHash} on chain ${sourceChainId}`);
    this.name = "AttestationTimeoutError";
  }
}

const finalityThresholdFor = (t: TransferType): number => (t === "standard" ? 2000 : 1000);

type CircleBurnFeeEntry = { finalityThreshold: number; minimumFee: number };

const feeBpsCache = new Map<string, { ts: number; bps: number }>();
const FEE_CACHE_TTL_MS = 60_000;

/** Test-only hook: clears the in-memory fee cache between cases. */
export const _clearFeeCacheForTests = () => feeBpsCache.clear();

const fetchBurnFeeBps = async (
  sourceChainId: number,
  destinationChainId: number,
  transferType: TransferType,
): Promise<number> => {
  const srcDomain = chainIdToDomain[sourceChainId];
  const dstDomain = chainIdToDomain[destinationChainId];
  if (srcDomain === undefined || dstDomain === undefined) {
    throw new Error(`Unsupported CCTP route ${sourceChainId} -> ${destinationChainId}`);
  }
  const threshold = finalityThresholdFor(transferType);
  const cacheKey = `${srcDomain}->${dstDomain}:${threshold}`;
  const cached = feeBpsCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < FEE_CACHE_TTL_MS) {
    return cached.bps;
  }

  const url = `${CIRCLE_API_BASE}/v2/burn/USDC/fees/${srcDomain}/${dstDomain}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch CCTP fee from ${url} (status ${response.status})`);
  }
  const json = (await response.json()) as { data?: CircleBurnFeeEntry[] } | CircleBurnFeeEntry[];
  const entries = Array.isArray(json) ? json : (json.data ?? []);

  const match =
    transferType === "fast"
      ? entries.find((e) => e.finalityThreshold <= 1000)
      : entries.find((e) => e.finalityThreshold >= 2000);
  if (!match) {
    throw new Error(`Circle did not return a fee for ${transferType} (route ${srcDomain}->${dstDomain})`);
  }

  feeBpsCache.set(cacheKey, { ts: Date.now(), bps: match.minimumFee });
  return match.minimumFee;
};

const getApproveAndBurnUsdcCalls = async (
  sourceChainId: number,
  amount: bigint,
  destinationChainId: number,
  destinationAddress: Address,
  walletAddress: Address,
  transferType: TransferType,
) => {
  const tokenAddress = tokenAddresses[sourceChainId as keyof typeof tokenAddresses] as `0x${string}`;
  const spender = tokenMessenger[sourceChainId] as `0x${string}`;

  // Restrict who can mint on the destination chain to Multicall3, so the only
  // way to call `receiveMessage` is via our atomic-multicall mint flow.
  const destChain = chains[destinationChainId as keyof typeof chains] as Chain;
  const multicall3Address = destChain?.contracts?.multicall3?.address;
  if (!multicall3Address) {
    throw new Error(`Multicall3 address not found for destination chain ${destinationChainId}`);
  }
  const destinationCaller = pad(multicall3Address);

  const minFinalityThreshold = finalityThresholdFor(transferType);

  // Authorize up to Circle's quoted fee + 10% to absorb minor variance.
  const baseFee = await getBridgeFee(amount, sourceChainId, destinationChainId, transferType);
  const maxFee = (baseFee * MAX_FEE_BUFFER_NUM) / MAX_FEE_BUFFER_DENOM;

  const approvalCalls = await buildERC20ApprovalCalls(
    {
      token: tokenAddress,
      amount,
      chainId: sourceChainId,
      walletAddress,
      symbol: "USDC",
      decimals: 6,
    },
    spender,
  );

  const burnCall: Call = {
    to: spender,
    data: encodeFunctionData({
      abi: parseAbi([
        "function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold)",
      ]),
      functionName: "depositForBurn",
      args: [
        amount,
        chainIdToDomain[destinationChainId],
        pad(destinationAddress),
        tokenAddress,
        destinationCaller,
        maxFee,
        minFinalityThreshold,
      ],
    }),
  };

  return [...approvalCalls, burnCall];
};

const retrieveAttestation = async (
  transactionHash: string,
  sourceChainId: number,
  timeoutMs: number = ATTESTATION_TIMEOUT_MS,
): Promise<Attestation[]> => {
  const url = `${CIRCLE_API_BASE}/v2/messages/${chainIdToDomain[sourceChainId]}?transactionHash=${transactionHash}`;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);

      if (response.status === 404) {
        await new Promise((resolve) => setTimeout(resolve, ATTESTATION_POLL_INTERVAL_MS));
        continue;
      }

      if (!response.ok) {
        throw new Error(`API returned status ${response.status}`);
      }

      const responseData = (await response.json()) as { messages: Attestation[] };
      if (responseData?.messages?.length === 1 && responseData.messages[0].status === "complete") {
        console.log("Attestation retrieved!", url);
        return responseData.messages;
      }

      console.log("Waiting for attestation...");
      await new Promise((resolve) => setTimeout(resolve, ATTESTATION_POLL_INTERVAL_MS));
    } catch (error) {
      console.log(`Attestation error: ${error instanceof Error ? error.message : "Unknown error"}`);
      throw new Error("Attestation retrieval failed");
    }
  }

  throw new AttestationTimeoutError(transactionHash, sourceChainId);
};

export const getMintUsdcCalls = async (destinationChainId: number, attestations: Attestation[]) => {
  if (!chains[destinationChainId as keyof typeof chains]) {
    throw new Error(`Chain ${destinationChainId} not supported`);
  }

  const contractConfig = {
    address: messageTransmitter[destinationChainId] as `0x${string}`,
    abi: parseAbi([
      "function usedNonces(bytes32) public view returns (uint256)",
      "function receiveMessage(bytes memory message, bytes memory attestation) external",
    ]),
  };

  const publicClient = getPublicClient(destinationChainId);

  const usedNonces = await publicClient.multicall({
    contracts: attestations.map((a) => ({
      ...contractConfig,
      functionName: "usedNonces",
      args: [a.decodedMessage.nonce],
    })),
  });

  const calls: Call[] = attestations
    .map((attestation, index) => ({ attestation, isUsed: usedNonces[index].result }))
    .filter(({ isUsed }) => !isUsed) // keep only UNUSED nonces
    .map(({ attestation }) => ({
      to: contractConfig.address,
      data: encodeFunctionData({
        ...contractConfig,
        functionName: "receiveMessage",
        args: [attestation.message, attestation.attestation],
      }),
    }));

  return calls;
};

/**
 * Executes the CCTP burn step.
 * @param tokenIn - The token to burn.
 * @param tokenOut - The token to mint.
 * @param sendCalls - The function to send calls.
 * @param transferType - Speed/cost tradeoff: "fast" (default) or "standard".
 * @returns The transaction hash and the chain ID.
 */
export const executeCCTPBurn = async (
  tokenIn: TokenAmount,
  tokenOut: TokenAmount,
  sendCalls: SendCallsFn,
  transferType: TransferType = "fast",
  retryHints?: Parameters<SendCallsFn>[5],
): Promise<[string, number]> => {
  if (tokenIn.chainId === tokenOut.chainId) {
    throw new Error("Token is already on the destination chain");
  }

  const { chainId: sourceChainId, amount, walletAddress: from } = tokenIn;
  const { chainId: destinationChainId, walletAddress: destinationAddress } = tokenOut;

  const [burnTx] = await sendCalls(
    "burn",
    sourceChainId,
    from,
    await getApproveAndBurnUsdcCalls(sourceChainId, amount, destinationChainId, destinationAddress, from, transferType),
    "atomic-steps",
    retryHints,
  );

  return [burnTx, sourceChainId];
};

/**
 * Retrieves the attestations for the given transaction hashes and source chain IDs.
 * @param transactionHashesAndChainIds - List of transaction hashes and source chain IDs from `executeCCTPBurn()`.
 * @returns The attestations.
 */
export const retrieveAttestations = async (transactionHashesAndChainIds: [string, number][]) => {
  const attestations: Attestation[] = [];
  for (let i = 0; i < transactionHashesAndChainIds.length; i++) {
    const attestation = await retrieveAttestation(...transactionHashesAndChainIds[i]);
    attestations.push(...attestation);
  }
  return attestations;
};

/**
 * Executes the CCTP mint step.
 * @param attestations - List of attestations retrieved from `retrieveAttestations()`.
 * @param tokenOut - The token to mint.
 * @param sendCalls - The function to send calls.
 * @returns The transaction hash and the logs.
 */
export const executeCCTPMint = async (
  attestations: Attestation[],
  tokenOut: TokenAmount,
  sendCalls: SendCallsFn,
  retryHints?: Parameters<SendCallsFn>[5],
): Promise<[string, { address: Address; data: Hex; topics: Hex[] }[][]]> => {
  if (attestations.length === 0) {
    throw new Error("No attestations");
  }

  const { chainId, walletAddress } = tokenOut;
  const calls = await getMintUsdcCalls(chainId, attestations);

  if (calls.length === 0) {
    console.warn(`CCTP mint skipped: all ${attestations.length} nonce(s) already used on chain ${chainId}`);
    return ["", []];
  }

  const [mintTx, mintLogs] = await sendCalls("mint", chainId, walletAddress, calls, "atomic-multicall", retryHints);
  return [mintTx, mintLogs];
};

/**
 * Returns the CCTP bridge fee for the given amount and route, in token units.
 *
 * Hits Circle's fee endpoint (`/v2/burn/USDC/fees/{src}/{dst}`) and applies the
 * returned basis-points rate to `amount`. Cached for 60s per route+threshold.
 *
 * @param amount - Amount to bridge (USDC, 6 decimals).
 * @param sourceChainId - Source chain (must be in `chainIdToDomain`).
 * @param destinationChainId - Destination chain.
 * @param transferType - "fast" (default) or "standard".
 * @returns Bridge fee in USDC base units.
 */
export async function getBridgeFee(
  amount: bigint,
  sourceChainId: number,
  destinationChainId: number,
  transferType: TransferType = "fast",
): Promise<bigint> {
  if (sourceChainId === destinationChainId) return 0n;
  const bps = await fetchBurnFeeBps(sourceChainId, destinationChainId, transferType);
  if (!Number.isFinite(bps) || bps < 0) {
    throw new Error(`Circle returned a non-finite or negative bps: ${bps}`);
  }
  const scaledBps = BigInt(Math.round(bps * Number(BPS_SCALE)));
  return (amount * scaledBps) / (BPS_DENOM * BPS_SCALE);
}
