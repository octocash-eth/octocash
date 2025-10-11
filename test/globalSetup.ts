import { createServer } from 'prool'
import { anvil } from 'prool/instances'
import { createPublicClient, createTestClient, http, type Address, type Chain } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { base, mainnet, optimism } from 'viem/chains';

const basePort = 8545;
const mnemonic = "memory dream rib champion cradle century antenna purchase smart company spoon reason";

async function getLatestBlockNumber(rpcUrl: string): Promise<number> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout

    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_blockNumber',
        params: []
      })
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();
    if (data.result) {
      return Number.parseInt(data.result, 16);
    }
    throw new Error(`Failed to fetch block number from RPC: ${data.error?.message || 'Unknown error'}`);
  } catch (error) {
    console.error(`Error fetching block number from ${rpcUrl}:`, error);
    throw error;
  }
}

export default async function setup() {
  if (!process.env.VITE_DRPC_API_KEY) {
    throw new Error("VITE_DRPC_API_KEY is not set")
  }

  console.log('📊 Fetching latest block numbers...');
  const mainnetRpc = `https://lb.drpc.org/ethereum/${process.env.VITE_DRPC_API_KEY}`;
  const optimismRpc = `https://lb.drpc.org/optimism/${process.env.VITE_DRPC_API_KEY}`;
  const baseRpc = `https://lb.drpc.org/base/${process.env.VITE_DRPC_API_KEY}`;

  const [mainnetBlock, optimismBlock, baseBlock] = await Promise.all([
    getLatestBlockNumber(mainnetRpc),
    getLatestBlockNumber(optimismRpc),
    getLatestBlockNumber(baseRpc),
  ]);
  console.log(`📦 Latest blocks - Mainnet: ${mainnetBlock}, Optimism: ${optimismBlock}, Base: ${baseBlock}`);

  const [proolMainnet, proolOptimism, proolBase] = [
    {
      chain: mainnet,
      forkUrl: mainnetRpc,
      forkBlockNumber: mainnetBlock,
    },
    {
      chain: optimism,
      forkUrl: optimismRpc,
      forkBlockNumber: optimismBlock,
    },
    {
      chain: base,
      forkUrl: baseRpc,
      forkBlockNumber: baseBlock,
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
  await getTestClients(mainnet.id).testClient.reset();
  await getTestClients(optimism.id).testClient.reset();
  await getTestClients(base.id).testClient.reset();
}
