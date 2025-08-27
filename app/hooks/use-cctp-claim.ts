import type { Account, Chain, HttpTransport, WalletClient } from "viem";
import { useWalletClient } from "wagmi";
import { chainIdToDomain, tokenAddresses } from "~/data/cctp-contracts";
import { executeCCTPMint, retrieveAttestation } from "~/lib/cctp";
import { prepareSendCalls, type SendCallsFn } from "~/lib/send-calls";

export function useCCTPClaim() {
  const { data: walletClient } = useWalletClient();

  const claim = async (transactionHash: string, sourceChainId: number) => {
    if (!walletClient) {
      throw new Error("Wallet client is not available.");
    }

    const attestation = await retrieveAttestation(transactionHash, sourceChainId);
    const destinationChainId = Object.entries(chainIdToDomain).find(
      ([_, domain]) => domain === Number(attestation.decodedMessage.destinationDomain),
    )?.[0];
    if (!destinationChainId) {
      throw new Error("Destination chain ID not found.");
    }

    const sendCalls: SendCallsFn = prepareSendCalls(walletClient as WalletClient<HttpTransport, Chain, Account>);

    const tokenOut = {
      token: tokenAddresses[Number(destinationChainId)] as `0x${string}`,
      amount: 0n,
      walletAddress: walletClient.account.address,
      chainId: Number(destinationChainId),
    };

    const [mintTx, logs] = await executeCCTPMint([attestation], tokenOut, sendCalls);

    return { mintTx, logs } as const;
  };

  return {
    claim,
  };
}
