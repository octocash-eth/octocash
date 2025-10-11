import type { Account, Chain, HttpTransport, WalletClient } from "viem";
import { useWalletClient } from "wagmi";
import { chainIdToDomain, tokenAddresses } from "~/data/cctp-contracts";
import { type Attestation, executeCCTPMint, retrieveAttestations } from "~/lib/cctp";
import { prepareSendCalls, type SendCallsFn } from "~/lib/send-calls";

const getDestinationChainId = (attestation: Attestation) => {
  return Object.entries(chainIdToDomain).find(
    ([_, domain]) => domain === Number(attestation.decodedMessage.destinationDomain),
  )?.[0];
};

export function useCCTPClaim() {
  const { data: walletClient } = useWalletClient();

  const claim = async (transactionHash: string, sourceChainId: number) => {
    if (!walletClient) {
      throw new Error("Wallet client is not available.");
    }

    const attestations = await retrieveAttestations([[transactionHash, sourceChainId]]);
    const destinationChainIds = attestations.map(getDestinationChainId);
    if (destinationChainIds.length === 0) {
      throw new Error("No attestations found.");
    }
    if (destinationChainIds.some((chainId) => chainId !== destinationChainIds[0])) {
      throw new Error("Only same destination chain ID is supported.");
    }
    const destinationChainId = destinationChainIds[0];

    const sendCalls: SendCallsFn = prepareSendCalls(walletClient as WalletClient<HttpTransport, Chain, Account>);

    const tokenOut = {
      token: tokenAddresses[Number(destinationChainId)] as `0x${string}`,
      amount: 0n,
      walletAddress: walletClient.account.address,
      chainId: Number(destinationChainId),
      symbol: "USDC",
      decimals: 6,
    };

    const [mintTx, logs] = await executeCCTPMint(attestations, tokenOut, sendCalls);

    return { mintTx, logs } as const;
  };

  return {
    claim,
  };
}
