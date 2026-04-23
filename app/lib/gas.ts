import type { Address, Chain, Transport } from "viem";
import { getPublicClient, retryOnRateLimit } from "./public-client";

export async function getNativeBalance(chain: Chain, address: Address, transport?: Transport): Promise<bigint> {
  const client = getPublicClient(chain.id, transport);
  return retryOnRateLimit(() => client.getBalance({ address }));
}
