import { createServer } from 'prool'
import { anvil } from 'prool/instances'
import { createPublicClient, createTestClient, http, type Address, type Chain } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { base, mainnet, optimism } from 'viem/chains';

const basePort = 8545;
const mnemonic = "memory dream rib champion cradle century antenna purchase smart company spoon reason";

export default async function setup() {
  if (!process.env.ALCHEMY_API_KEY) {
    throw new Error("ALCHEMY_API_KEY is not set")
  }
  const [proolMainnet, proolOptimism, proolBase] = [
    {
      chain: mainnet,
      forkUrl: `https://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`,
      forkBlockNumber: 23257260,
    },
    {
      chain: optimism,
      forkUrl: `https://opt-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`,
      forkBlockNumber: 140499492,
    },
    {
      chain: base,
      forkUrl: `https://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`,
      forkBlockNumber: 34904190,
    },
  ].map(({ chain, forkUrl, forkBlockNumber }) =>
    createServer({
    host: "localhost",
    port: basePort + chain.id,
    instance: anvil({
      forkUrl,
      forkChainId: chain.id,
      forkBlockNumber,
      accounts: 2,
      mnemonic,
      autoImpersonate: true,
    }),
  })
);

console.log('🚀 Starting Prool server');
await proolMainnet.start();
await waitForRpc(`http://localhost:${basePort + mainnet.id}/1`);
await proolOptimism.start();
await waitForRpc(`http://localhost:${basePort + optimism.id}/1`);
await proolBase.start();
await waitForRpc(`http://localhost:${basePort + base.id}/1`);
console.log('✅ Prool RPCs are ready');

return async () => {
  console.log('🛑 Stopping Prool server');
  await proolMainnet.stop();
  await proolOptimism.stop();
  await proolBase.stop();
}
}

async function waitForRpc(url: string, { attempts = 100, delayMs = 500 }: { attempts?: number; delayMs?: number } = {}) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] });
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      if (res.ok) return;
      // Anvil errors are JSON-RPC responses
      const contentType = res.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        const text = await res.text();
        console.error(text);
      }
    } catch {
      // ignore and retry
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error(`RPC at ${url} did not become ready in time`);
}

export const getTestClients = (chainId: number) => {
  const url = `http://localhost:${basePort + chainId}/1`;
  return {
    testClient: createTestClient({
      chain: [mainnet, optimism, base].find((c) => c.id === chainId) as Chain,
      transport: http(url),
      mode: "anvil",
      account: mnemonicToAccount(mnemonic),
    }),
    publicClient: createPublicClient({
      chain: [mainnet, optimism, base].find((c) => c.id === chainId) as Chain,
      transport: http(url),
    }),
    transport: http(url),
  };
}

export async function reset() {
  const { testClient } = getTestClients(mainnet.id);
  const { testClient: optimismTestClient } = getTestClients(optimism.id);
  const { testClient: baseTestClient } = getTestClients(base.id);
  await testClient.reset();
  await optimismTestClient.reset();
  await baseTestClient.reset();
}
