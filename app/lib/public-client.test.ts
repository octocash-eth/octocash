import { type PublicClient, parseUnits, type Transport } from "viem";
import { mainnet, optimism } from "viem/chains";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { BASE_DELAY, MAX_RETRIES } from "./public-client";

// Mock the viem module
vi.mock("viem", async () => {
  const actual = await vi.importActual("viem");
  return {
    ...actual,
    createPublicClient: vi.fn(),
  };
});

// Mock the data modules
vi.mock("~/data/supported-chains", () => ({
  chains: {
    1: mainnet,
    10: optimism,
  },
  transports: {
    1: {} as Transport,
    10: {} as Transport,
  },
}));

import { createPublicClient } from "viem";
import { getPublicClient, retryOnRateLimit } from "./public-client";

const mockCreatePublicClient = vi.mocked(createPublicClient);

describe("public-client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getPublicClient", () => {
    test("should create a public client for a supported chain", () => {
      const mockClient = {} as PublicClient;
      mockCreatePublicClient.mockReturnValue(mockClient);

      const client = getPublicClient(1);

      expect(client).toBe(mockClient);
      expect(mockCreatePublicClient).toHaveBeenCalledWith({
        chain: mainnet,
        transport: expect.anything(),
      });
    });

    test("should use provided transport over configured transport", () => {
      const mockClient = {} as PublicClient;
      const mockTransport = {} as Transport;
      mockCreatePublicClient.mockReturnValue(mockClient);

      const client = getPublicClient(1, mockTransport);

      expect(client).toBe(mockClient);
      expect(mockCreatePublicClient).toHaveBeenCalledWith({
        chain: mainnet,
        transport: mockTransport,
      });
    });

    test("should throw error for unsupported chain", () => {
      expect(() => getPublicClient(999999)).toThrow("Chain 999999 not supported");
    });
  });

  describe("retryOnRateLimit", () => {
    test("should return result on first attempt if no error", async () => {
      const mockFn = vi.fn().mockResolvedValue(parseUnits("1.5", 18));

      const result = await retryOnRateLimit(mockFn);

      expect(result).toBe(parseUnits("1.5", 18));
      expect(mockFn).toHaveBeenCalledTimes(1);
    });

    test("should retry on 429 error and succeed", async () => {
      vi.useFakeTimers();
      let callCount = 0;
      const mockFn = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.reject(new Error("HTTP request failed. 429: Too Many Requests"));
        }
        return Promise.resolve(parseUnits("1.5", 18));
      });

      const resultPromise = retryOnRateLimit(mockFn);

      // Fast-forward through the retry delay
      await vi.runAllTimersAsync();

      const result = await resultPromise;

      expect(result).toBe(parseUnits("1.5", 18));
      expect(mockFn).toHaveBeenCalledTimes(2);

      vi.useRealTimers();
    });

    test('should retry on error with "Too many request" in message', async () => {
      vi.useFakeTimers();
      let callCount = 0;
      const mockFn = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.reject(new Error("Too many request"));
        }
        return Promise.resolve(parseUnits("2", 18));
      });

      const resultPromise = retryOnRateLimit(mockFn);
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result).toBe(parseUnits("2", 18));
      expect(mockFn).toHaveBeenCalledTimes(2);

      vi.useRealTimers();
    });

    test('should retry on error with "rate limit" in message', async () => {
      vi.useFakeTimers();
      let callCount = 0;
      const mockFn = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.reject(new Error("rate limit exceeded"));
        }
        return Promise.resolve(parseUnits("3", 18));
      });

      const resultPromise = retryOnRateLimit(mockFn);
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result).toBe(parseUnits("3", 18));
      expect(mockFn).toHaveBeenCalledTimes(2);

      vi.useRealTimers();
    });

    test("should apply exponential backoff on multiple retries", async () => {
      vi.useFakeTimers();
      const startTime = Date.now();
      let callCount = 0;
      const delays: number[] = [];

      const mockFn = vi.fn().mockImplementation(() => {
        callCount++;
        delays.push(Date.now() - startTime);

        if (callCount <= MAX_RETRIES) {
          return Promise.reject(new Error("429: Too Many Requests"));
        }
        return Promise.resolve(parseUnits("1", 18));
      });

      const resultPromise = retryOnRateLimit(mockFn);
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result).toBe(parseUnits("1", 18));
      expect(mockFn).toHaveBeenCalledTimes(MAX_RETRIES + 1);

      // Verify exponential backoff delays
      // First call at t=0
      // Second call after BASE_DELAY delay
      // Third call after 2 * BASE_DELAY delay
      expect(delays[0]).toBe(0);
      expect(delays[1]).toBeGreaterThanOrEqual(BASE_DELAY);
      expect(delays[2]).toBeGreaterThanOrEqual(3 * BASE_DELAY); // BASE_DELAY + 2 * BASE_DELAY

      vi.useRealTimers();
    });

    test("should throw after max retries exceeded", async () => {
      vi.useFakeTimers();
      const mockFn = vi.fn().mockRejectedValue(new Error("429: Too Many Requests"));

      const resultPromise = retryOnRateLimit(mockFn);
      // Add a catch handler to prevent unhandled rejection warnings
      resultPromise.catch(() => {});

      await vi.runAllTimersAsync();

      await expect(resultPromise).rejects.toThrow("429: Too Many Requests");
      // Should try: initial + MAX_RETRIES retries = MAX_RETRIES + 1 total attempts
      expect(mockFn).toHaveBeenCalledTimes(MAX_RETRIES + 1);

      vi.useRealTimers();
    });

    test("should not retry on non-rate-limit errors", async () => {
      const mockFn = vi.fn().mockRejectedValue(new Error("Network connection failed"));

      await expect(retryOnRateLimit(mockFn)).rejects.toThrow("Network connection failed");
      // Should only try once
      expect(mockFn).toHaveBeenCalledTimes(1);
    });

    test("should not retry on non-Error exceptions", async () => {
      const mockFn = vi.fn().mockRejectedValue("String error");

      await expect(retryOnRateLimit(mockFn)).rejects.toBe("String error");
      // Should only try once
      expect(mockFn).toHaveBeenCalledTimes(1);
    });

    test("should handle mixed rate limit and success scenarios", async () => {
      vi.useFakeTimers();
      let callCount = 0;
      const mockFn = vi.fn().mockImplementation(() => {
        callCount++;
        // First attempt: rate limit
        if (callCount === 1) {
          return Promise.reject(new Error("429"));
        }
        // Second attempt: different rate limit message
        if (callCount === 2) {
          return Promise.reject(new Error("rate limit exceeded"));
        }
        // Third attempt: success
        return Promise.resolve(parseUnits("5.5", 18));
      });

      const resultPromise = retryOnRateLimit(mockFn);
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result).toBe(parseUnits("5.5", 18));
      expect(mockFn).toHaveBeenCalledTimes(3);

      vi.useRealTimers();
    });

    test("should respect custom maxRetries parameter", async () => {
      vi.useFakeTimers();
      const mockFn = vi.fn().mockRejectedValue(new Error("429: Too Many Requests"));

      const resultPromise = retryOnRateLimit(mockFn, 1); // Only 1 retry
      resultPromise.catch(() => {});

      await vi.runAllTimersAsync();

      await expect(resultPromise).rejects.toThrow("429: Too Many Requests");
      // Should try: initial + 1 retry = 2 total attempts
      expect(mockFn).toHaveBeenCalledTimes(2);

      vi.useRealTimers();
    });

    test("should respect custom baseDelay parameter", async () => {
      vi.useFakeTimers();
      const startTime = Date.now();
      let callCount = 0;
      const delays: number[] = [];

      const mockFn = vi.fn().mockImplementation(() => {
        callCount++;
        delays.push(Date.now() - startTime);

        if (callCount === 1) {
          return Promise.reject(new Error("429: Too Many Requests"));
        }
        return Promise.resolve(parseUnits("1", 18));
      });

      const resultPromise = retryOnRateLimit(mockFn, 3, 500); // 500ms base delay
      await vi.runAllTimersAsync();
      await resultPromise;

      // First call at t=0
      // Second call after 500ms delay (not 1000ms)
      expect(delays[0]).toBe(0);
      expect(delays[1]).toBeGreaterThanOrEqual(500);
      expect(delays[1]).toBeLessThan(1000);

      vi.useRealTimers();
    });
  });
});
