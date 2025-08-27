import { type Chain, encodeFunctionData, type Hex, parseAbi } from "viem";
import { chainIdToDomain, messageTransmitter, tokenAddresses, tokenMessenger } from "~/data/cctp-contracts";
import { chains } from "~/data/supported-chains";
import type { TokenAmount } from "~/lib/consolidation";
import type { SendCallsFn } from "~/lib/send-calls";

const getApproveAndBurnUsdcCalls = async (
  sourceChainId: number,
  amount: bigint,
  destinationChainId: number,
  destinationAddress: string,
) => {
  const finalityThreshold = 1000;
  const maxFee = amount - 1n;

  // For EVM destinations, pad the hex address
  const mintRecipient = `0x${destinationAddress.replace(/^0x/, "").padStart(64, "0")}`;

  const calls = [
    {
      to: tokenAddresses[sourceChainId as keyof typeof tokenAddresses] as `0x${string}`,
      data: encodeFunctionData({
        abi: parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]),
        functionName: "approve",
        args: [tokenMessenger[sourceChainId] as `0x${string}`, amount],
      }),
    },
    {
      to: tokenMessenger[sourceChainId] as `0x${string}`,
      data: encodeFunctionData({
        abi: parseAbi([
          "function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 hookData, uint256 maxFee, uint32 finalityThreshold)",
        ]),
        functionName: "depositForBurn",
        args: [
          amount,
          chainIdToDomain[destinationChainId],
          mintRecipient as Hex,
          tokenAddresses[sourceChainId as keyof typeof tokenAddresses] as `0x${string}`,
          `0x${"00".repeat(32)}`,
          maxFee,
          finalityThreshold,
        ],
      }),
    },
  ];

  return calls;
};

export const retrieveAttestation = async (transactionHash: string, sourceChainId: number) => {
  const url = `https://iris-api.circle.com/v2/messages/${chainIdToDomain[sourceChainId]}?transactionHash=${transactionHash}`;

  while (true) {
    try {
      const response = await fetch(url);

      if (response.status === 404) {
        await new Promise((resolve) => setTimeout(resolve, 5000));
        continue;
      }

      if (!response.ok) {
        throw new Error(`API returned status ${response.status}`);
      }

      const responseData = await response.json();
      if (responseData?.messages?.[0]?.status === "complete") {
        console.log("Attestation retrieved!", url);
        return responseData.messages[0];
      }

      console.log("Waiting for attestation...");
      await new Promise((resolve) => setTimeout(resolve, 5000));
    } catch (error) {
      console.log(`Attestation error: ${error instanceof Error ? error.message : "Unknown error"}`);
      throw new Error("Attestation retrieval failed");
    }
  }
};

export const getMintUsdcCalls = async (
  destinationChainId: number,
  attestations: { message: `0x${string}`; attestation: `0x${string}` }[],
) => {
  const contractConfig = {
    chain: chains[destinationChainId as keyof typeof chains] as Chain,
    address: messageTransmitter[destinationChainId] as `0x${string}`,
    abi: parseAbi(["function receiveMessage(bytes memory message, bytes memory attestation) external"]),
  };

  const calls = [];
  for (const attestation of attestations) {
    calls.push({
      to: contractConfig.address,
      data: encodeFunctionData({
        ...contractConfig,
        args: [attestation.message, attestation.attestation],
      }),
      chain: chains[destinationChainId as keyof typeof chains] as Chain,
    });
  }
  return calls;
};

/**
 * Executes the CCTP burn step.
 * @param tokenIn - The token to burn.
 * @param tokenOut - The token to mint.
 * @param sendCalls - The function to send calls.
 * @param onProgress - The function to update the progress.
 * @returns The transaction hash and the chain ID.
 */
export const executeCCTPBurn = async (
  tokenIn: TokenAmount,
  tokenOut: TokenAmount,
  sendCalls: SendCallsFn,
): Promise<[string, number]> => {
  if (tokenIn.chainId === tokenOut.chainId) {
    throw new Error("Token is already on the destination chain");
  }

  const { chainId: sourceChainId, amount, walletAddress: from } = tokenIn;
  const { chainId: destinationChainId, walletAddress: destinationAddress } = tokenOut;

  // Execute burn step sequentially
  const [burnTx] = await sendCalls(
    "burn",
    sourceChainId,
    from,
    await getApproveAndBurnUsdcCalls(sourceChainId, amount, destinationChainId, destinationAddress),
  );

  return [burnTx, sourceChainId];
};

/**
 * Retrieves the attestations for the given transaction hashes and source chain IDs.
 * @param transactionHashesAndChainIds - List of transaction hashes and source chain IDs from `executeCCTPBurn()`.
 * @returns The attestations.
 */
export const retrieveAttestations = async (transactionHashesAndChainIds: [string, number][]) => {
  const attestations: { message: `0x${string}`; attestation: `0x${string}` }[] = [];
  for (let i = 0; i < transactionHashesAndChainIds.length; i++) {
    const attestation = await retrieveAttestation(...transactionHashesAndChainIds[i]);
    attestations.push(attestation);
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
  attestations: { message: `0x${string}`; attestation: `0x${string}` }[],
  tokenOut: TokenAmount,
  sendCalls: SendCallsFn,
) => {
  // Execute mint step
  const destinationChainId = tokenOut.chainId;
  const [mintTx, mintLogs] = await sendCalls(
    "mint",
    destinationChainId,
    tokenOut.walletAddress,
    await getMintUsdcCalls(destinationChainId, attestations),
  );
  return [mintTx, mintLogs];
};
