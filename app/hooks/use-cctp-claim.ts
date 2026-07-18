import type { Account, Chain, HttpTransport, WalletClient } from "viem";
import { useConfig } from "wagmi";
import { getWalletClient } from "wagmi/actions";
import { chainIdToDomain, tokenAddresses } from "~/data/cctp-contracts";
import { type Attestation, executeCCTPMint, retrieveAttestations } from "~/lib/cctp";
import { prepareSendCalls, type SendCallsFn } from "~/lib/send-calls";

const getDestinationChainId = (attestation: Attestation): number => {
  const domain = Number(attestation.decodedMessage.destinationDomain);
  const entry = Object.entries(chainIdToDomain).find(([, d]) => d === domain);
  if (!entry) {
    throw new Error(
      `Unsupported CCTP destination domain ${domain}. Update chainIdToDomain in app/data/cctp-contracts.`,
    );
  }
  return Number(entry[0]);
};

export function useCCTPClaim() {
  const config = useConfig();

  const claim = async (transactionHash: string, sourceChainId: number, signal?: AbortSignal) => {
    // Resolved lazily (not via useWalletClient) so the always-mounted
    // manual-claim dialog doesn't keep a wallet-client query subscription
    // alive that refetches over RPC on every remount while closed.
    const walletClient = await getWalletClient(config).catch(() => null);
    if (!walletClient) {
      throw new Error("Wallet client is not available.");
    }

    // `signal` is wired through to `retrieveAttestations` so the manual-claim
    // dialog's Cancel button can stop the (potentially many-minute) Circle
    // attestation poll instead of letting it run to completion in the background.
    const attestations = await retrieveAttestations([[transactionHash, sourceChainId]], signal);
    if (attestations.length === 0) {
      throw new Error("No attestations found.");
    }

    const destinationChainIds = attestations.map(getDestinationChainId);
    if (destinationChainIds.some((chainId) => chainId !== destinationChainIds[0])) {
      throw new Error("Only same destination chain ID is supported.");
    }
    const destinationChainId = destinationChainIds[0];

    const sendCalls: SendCallsFn = prepareSendCalls(walletClient as WalletClient<HttpTransport, Chain, Account>);

    const tokenOut = {
      token: tokenAddresses[destinationChainId] as `0x${string}`,
      amount: 0n,
      walletAddress: walletClient.account.address,
      chainId: destinationChainId,
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
