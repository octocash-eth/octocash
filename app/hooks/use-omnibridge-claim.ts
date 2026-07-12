import type { Account, Chain, HttpTransport, WalletClient } from "viem";
import { mainnet } from "viem/chains";
import { useWalletClient } from "wagmi";
import { USDC } from "~/data/token-contracts";
import { executeOmnibridgeClaim, retrieveOmnibridgeClaims } from "~/lib/omnibridge";
import { prepareSendCalls, type SendCallsFn } from "~/lib/send-calls";

/**
 * Manual recovery for a stuck Gnosis->mainnet Omnibridge transfer: given the
 * Gnosis bridge transaction, waits for the AMB signatures (if still pending)
 * and submits `executeSignatures` on mainnet from the connected wallet.
 * Analog of {@link useCCTPClaim} for chain-100 sources.
 */
export function useOmnibridgeClaim() {
  const { data: walletClient } = useWalletClient();

  const claim = async (transactionHash: string, signal?: AbortSignal) => {
    if (!walletClient) {
      throw new Error("Wallet client is not available.");
    }

    // `signal` lets the manual-claim dialog's Cancel button stop the
    // signature poll instead of letting it run in the background.
    const claims = await retrieveOmnibridgeClaims([transactionHash], signal);
    if (claims.length === 0) {
      throw new Error("No Omnibridge messages found.");
    }

    const sendCalls: SendCallsFn = prepareSendCalls(walletClient as WalletClient<HttpTransport, Chain, Account>);

    const tokenOut = {
      token: USDC[mainnet.id],
      amount: 0n,
      walletAddress: walletClient.account.address,
      chainId: mainnet.id,
      symbol: "USDC",
      decimals: 6,
    };

    const [claimTx, logs] = await executeOmnibridgeClaim(claims, tokenOut, sendCalls);

    return { claimTx, logs } as const;
  };

  return {
    claim,
  };
}
