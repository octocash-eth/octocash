import { type Chain, type PublicClient, type Transport, createPublicClient as viemCreatePublicClient } from "viem";
import { chains, transports } from "~/data/supported-chains";

export const MAX_RETRIES = 5;
export const BASE_DELAY = 2000;

// Cache for public clients - avoids creating new clients for every RPC call
const publicClientCache = new Map<number, PublicClient>();

/**
 * Creates or retrieves a cached public client for the given chain.
 * @param chainId - The chain ID to create the client for.
 * @param transport - Optional transport to use. If provided, bypasses cache and creates a new client.
 * @returns A viem PublicClient instance.
 */
export function getPublicClient(chainId: number, transport?: Transport): PublicClient {
  const chain = chains[chainId as keyof typeof chains] as Chain;
  if (!chain) {
    throw new Error(`Chain ${chainId} not supported`);
  }

  // If no custom transport, check cache first
  if (!transport) {
    const cached = publicClientCache.get(chainId);
    if (cached) {
      return cached;
    }
  }

  const effectiveTransport = transport ?? transports?.[chainId as keyof typeof transports];
  if (!effectiveTransport) {
    throw new Error(`No transport configured for chain ${chainId}`);
  }

  const client = viemCreatePublicClient({ chain, transport: effectiveTransport });

  // Cache the client if using default transport
  if (!transport) {
    publicClientCache.set(chainId, client);
  }

  return client;
}

/**
 * Retries a function call on rate limit errors (429).
 * @param fn - The function to retry.
 * @param maxRetries - Maximum number of retries (default: 5).
 * @param baseDelay - Base delay in milliseconds for exponential backoff (default: 2000).
 * @returns The result of the function call.
 */
export async function retryOnRateLimit<T>(
  fn: () => Promise<T>,
  maxRetries = MAX_RETRIES,
  baseDelay = BASE_DELAY,
): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      // Check if it's a rate limiting error (429)
      const is429 =
        error instanceof Error &&
        (error.message.includes("429") ||
          error.message.toLowerCase().includes("too many request") ||
          error.message.toLowerCase().includes("rate limit"));

      // If it's not a rate limit error or we've exhausted retries, throw
      if (!is429 || attempt === maxRetries) {
        throw error;
      }

      // Wait with exponential backoff before retrying
      const delay = baseDelay * 2 ** attempt;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  // This should never be reached, but TypeScript needs it
  throw new Error("Failed after retries");
}
