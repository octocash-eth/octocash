"use client";

import { useState } from "react";
import {
  type Account,
  type Chain,
  encodeFunctionData,
  formatUnits,
  type Hex,
  type HttpTransport,
  parseUnits,
  TransactionExecutionError,
  type WalletClient,
} from "viem";
import { usePublicClient } from "wagmi";

import { chainIdToDomain, messageTransmitter, tokenAddresses, tokenMessenger } from "../data/cctp-contracts";
import { chains } from "~/data/supported-chains";

export type TransferStep = "idle" | "burning" | "waiting-attestation" | "minting" | "completed" | "error";

export function useCrossChainTransfer() {
  const publicClient = usePublicClient();
  const [currentStep, setCurrentStep] = useState<TransferStep>("idle");
  const [error, setError] = useState<string | null>(null);

  const DEFAULT_DECIMALS = 6;

  const switchChain = async (client: WalletClient<HttpTransport, Chain, Account>, chainId: number) => {
    try {
      return client.switchChain({ id: chainId });
    } catch (_err) {
      return client.addChain({
        chain: chains[chainId as keyof typeof chains] as Chain,
      });
    }
  };

  const approveAndBurnUSDC = async (
    client: WalletClient<HttpTransport, Chain, Account>,
    sourceChainId: number,
    amount: bigint,
    destinationChainId: number,
    destinationAddress: string,
  ) => {
    setCurrentStep("burning");

    try {
      const finalityThreshold = 1000;
      const maxFee = amount - 1n;

      // For EVM destinations, pad the hex address
      const mintRecipient = `0x${destinationAddress.replace(/^0x/, "").padStart(64, "0")}`;

      await switchChain(client, sourceChainId);

      const calls = await client.sendCalls({
        chain: chains[sourceChainId as keyof typeof chains] as Chain,
        forceAtomic: true,
        calls: [
          {
            to: tokenAddresses[sourceChainId as keyof typeof tokenAddresses] as `0x${string}`,
            data: encodeFunctionData({
              abi: [
                {
                  type: "function",
                  name: "approve",
                  stateMutability: "nonpayable",
                  inputs: [
                    { name: "spender", type: "address" },
                    { name: "amount", type: "uint256" },
                  ],
                  outputs: [{ name: "", type: "bool" }],
                },
              ],
              functionName: "approve",
              args: [tokenMessenger[sourceChainId] as `0x${string}`, amount],
            }),
          },
          {
            to: tokenMessenger[sourceChainId] as `0x${string}`,
            data: encodeFunctionData({
              abi: [
                {
                  type: "function",
                  name: "depositForBurn",
                  stateMutability: "nonpayable",
                  inputs: [
                    { name: "amount", type: "uint256" },
                    { name: "destinationDomain", type: "uint32" },
                    { name: "mintRecipient", type: "bytes32" },
                    { name: "burnToken", type: "address" },
                    { name: "hookData", type: "bytes32" },
                    { name: "maxFee", type: "uint256" },
                    { name: "finalityThreshold", type: "uint32" },
                  ],
                  outputs: [],
                },
              ],
              functionName: "depositForBurn",
              args: [
                amount,
                chainIdToDomain[destinationChainId],
                mintRecipient as Hex,
                tokenAddresses[sourceChainId as keyof typeof tokenAddresses] as `0x${string}`,
                "0x0000000000000000000000000000000000000000000000000000000000000000",
                maxFee,
                finalityThreshold,
              ],
            }),
          },
        ],
      });

      const status = await client.waitForCallsStatus({
        id: calls.id,
      });

      const tx = status.receipts?.[0]?.transactionHash;

      if (!tx) {
        throw new Error("Burn transaction failed");
      }

      console.log(`Burn Tx: ${tx}`);
      return tx;
    } catch (err) {
      setError("Burn failed");
      throw err;
    }
  };

  const retrieveAttestation = async (transactionHash: string, sourceChainId: number) => {
    setCurrentStep("waiting-attestation");

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
        setError("Attestation retrieval failed");
        console.log(`Attestation error: ${error instanceof Error ? error.message : "Unknown error"}`);
        throw error;
      }
    }
  };

  const mintUSDC = async (
    client: WalletClient<HttpTransport, Chain, Account>,
    destinationChainId: number,
    attestations: { message: `0x${string}`; attestation: `0x${string}` }[],
  ) => {
    const MAX_RETRIES = 3;
    let retries = 0;
    setCurrentStep("minting");
    console.log("Minting USDC...");

    await switchChain(client, destinationChainId);

    while (retries < MAX_RETRIES) {
      if (!publicClient) {
        throw new Error("Public client not found");
      }
      try {
        const feeData = await publicClient.estimateFeesPerGas();
        const contractConfig = {
          chain: chains[destinationChainId as keyof typeof chains] as Chain,
          address: messageTransmitter[destinationChainId] as `0x${string}`,
          abi: [
            {
              type: "function",
              name: "receiveMessage",
              stateMutability: "nonpayable",
              inputs: [
                { name: "message", type: "bytes" },
                { name: "attestation", type: "bytes" },
              ],
              outputs: [],
            },
          ] as const,
        };

        const calls = [];
        for (const attestation of attestations) {
          // Estimate gas with buffer
          const gasEstimate = await publicClient.estimateContractGas({
            ...contractConfig,
            functionName: "receiveMessage",
            args: [attestation.message, attestation.attestation],
            account: client.account,
          });

          // Add 20% buffer to gas estimate
          const gasWithBuffer = (gasEstimate * 120n) / 100n;
          console.log(`Gas Used: ${formatUnits(gasWithBuffer, 9)} Gwei`);

          calls.push({
            to: contractConfig.address,
            data: encodeFunctionData({
              ...contractConfig,
              functionName: "receiveMessage",
              args: [attestation.message, attestation.attestation],
            }),
            chain: chains[destinationChainId as keyof typeof chains] as Chain,
            gas: gasWithBuffer,
            maxFeePerGas: feeData.maxFeePerGas,
            maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
          });
        }

        const mintCalls = await client.sendCalls({
          chain: chains[destinationChainId as keyof typeof chains] as Chain,
          forceAtomic: true,
          calls,
        });

        const status = await client.waitForCallsStatus({
          id: mintCalls.id,
        });

        const tx = status.receipts?.[0]?.transactionHash;

        if (!tx) {
          throw new Error("Mint transaction failed");
        }
        setCurrentStep("completed");
        break;
      } catch (err) {
        if (err instanceof TransactionExecutionError && retries < MAX_RETRIES) {
          retries++;
          console.log(`Retry ${retries}/${MAX_RETRIES}...`);
          await new Promise((resolve) => setTimeout(resolve, 2000 * retries));
          continue;
        }
        throw err;
      }
    }
  };

  const executeTransfers = async (
    sourceChainIds: number[],
    destinationChainId: number,
    destinationAddress: string,
    amounts: string[],
    walletClient: WalletClient<HttpTransport, Chain, Account>,
  ) => {
    try {
      if (!publicClient) {
        throw new Error("Public client not found");
      }

      const burnTxs = [];
      for (let i = 0; i < sourceChainIds.length; i++) {
        const sourceChainId = sourceChainIds[i];
        const amount = amounts[i];
        const numericAmount = parseUnits(amount, DEFAULT_DECIMALS);

        // Execute burn step sequentially
        const burnTx = await approveAndBurnUSDC(
          walletClient,
          sourceChainId,
          numericAmount,
          destinationChainId,
          destinationAddress,
        );
        burnTxs.push(burnTx);
      }

      const attestations = [];
      for (let i = 0; i < burnTxs.length; i++) {
        const attestation = await retrieveAttestation(burnTxs[i], sourceChainIds[i]);
        attestations.push(attestation);
      }

      // Execute mint step
      await mintUSDC(walletClient, destinationChainId, attestations);
    } catch (error) {
      setCurrentStep("error");
      console.log(`Error: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  };

  const reset = () => {
    setCurrentStep("idle");
    setError(null);
  };

  return {
    currentStep,
    error,
    executeTransfers,
    reset,
  };
}
