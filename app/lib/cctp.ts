import { parseAbi, type Hex, type Chain, type Call, type Address } from "viem";
import { encodeFunctionData } from "viem";
import { chainIdToDomain, messageTransmitter, tokenMessenger } from "~/data/cctp-contracts";
import { tokenAddresses } from "~/data/cctp-contracts";
import { chains } from "~/data/supported-chains";
import type { TokenAmount, ConsolidationProgressCallback } from "~/lib/consolidation";
import { ConsolidationStep } from "~/lib/consolidation";

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
              abi: parseAbi(["function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 hookData, uint256 maxFee, uint32 finalityThreshold)"]),
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
          }
      ]

      return calls;
    }

  const retrieveAttestations = async (transactionHash: string, sourceChainId: number) => {

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

  const getMintUsdcCalls = async (
    destinationChainId: number,
    attestations: { message: `0x${string}`; attestation: `0x${string}` }[],
  ) => {
   
        const contractConfig = {
          chain: chains[destinationChainId as keyof typeof chains] as Chain,
          address: messageTransmitter[destinationChainId] as `0x${string}`,
          abi: 
            parseAbi(["function receiveMessage(bytes memory message, bytes memory attestation) external"]),
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
  }

  export const executeCCTP = async (
    tokensIn: TokenAmount[][],
    tokenOut: TokenAmount,
    sendCalls: (txId: string, chainId: number, from: Address, calls: Call[]) => Promise<string>,
    onProgress?: ConsolidationProgressCallback,
  ) => {

    const burnTxs: string[] = [];
    onProgress?.(ConsolidationStep.BURNING);
    for (const tokens of tokensIn) {
      const sourceChainId = tokens[0].chainId;
      const amount = tokens[0].amount;
      const from = tokens[0].walletAddress;
      const destinationChainId = tokenOut.chainId;
      const destinationAddress = tokenOut.walletAddress;

      // Execute burn step sequentially
      const burnTx = await sendCalls(
        "burn",
        sourceChainId,
        from,
        await getApproveAndBurnUsdcCalls(
          sourceChainId,
          amount,
          destinationChainId,
          destinationAddress,
        )
      );
      burnTxs.push(burnTx);
    }

    try {

      onProgress?.(ConsolidationStep.WAITING_ATTESTATION);
      const attestations: { message: `0x${string}`; attestation: `0x${string}` }[] = [];
      const sourceChainIds = tokensIn.map(t => t[0].chainId);
      for (let i = 0; i < burnTxs.length; i++) {
        const attestation = await retrieveAttestations(burnTxs[i], sourceChainIds[i]);
        attestations.push(attestation);
      }

      // Execute mint step
      const destinationChainId = tokenOut.chainId;
      onProgress?.(ConsolidationStep.MINTING);
      const mintTx = await sendCalls(
        "mint",
        destinationChainId,
        tokenOut.walletAddress,
        await getMintUsdcCalls(destinationChainId, attestations)
      );
      return mintTx;
    } catch (error) {
      console.log(`Error: ${error instanceof Error ? error.message : "Unknown error"}`);
      throw error;
    }
  };
