import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { DestinationToken, SourceToken, TransactionStep } from "~/lib/types";
import { useConsolidationPlanning } from "./use-consolidation-planning";

// Mock the planning module
const mockPlanConsolidation = vi.fn();
vi.mock("~/lib/planning", () => ({
  planConsolidation: (...args: unknown[]) => mockPlanConsolidation(...args),
}));

// Mock useConnectedAddresses
const mockUseConnectedAddresses = vi.fn();
vi.mock("./use-connected-addresses", () => ({
  useConnectedAddresses: () => mockUseConnectedAddresses(),
}));

describe("useConsolidationPlanning", () => {
  let queryClient: QueryClient;

  const createWrapper = () => {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });

    return ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  };

  const createMockSourceToken = (overrides?: Partial<SourceToken>): SourceToken => ({
    token: "0x1234567890123456789012345678901234567890" as `0x${string}`,
    amount: 1000000n,
    chainId: 1,
    walletAddress: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd" as `0x${string}`,
    symbol: "USDC",
    decimals: 6,
    ...overrides,
  });

  const createMockDestinationToken = (overrides?: Partial<DestinationToken>): DestinationToken => ({
    token: "0x1234567890123456789012345678901234567890" as `0x${string}`,
    chainId: 1,
    walletAddress: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd" as `0x${string}`,
    symbol: "USDC",
    decimals: 6,
    ...overrides,
  });

  const createMockPlan = (): TransactionStep[] => [
    {
      id: "step-1",
      type: "swap",
      status: "pending",
      chainId: 1,
      inputTokens: [createMockSourceToken()],
      outputToken: createMockSourceToken({ amount: 1000000n }),
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    mockUseConnectedAddresses.mockReturnValue(["0xabcdefabcdefabcdefabcdefabcdefabcdefabcd"]);
  });

  describe("initialization", () => {
    test("returns null state initially when enabled is false", () => {
      const { result } = renderHook(
        () =>
          useConsolidationPlanning({
            sourceTokens: [],
            destinationToken: createMockDestinationToken(),
            enabled: false,
            planId: "test-plan-1",
          }),
        { wrapper: createWrapper() },
      );

      expect(result.current.state).toBeNull();
      expect(result.current.isPlanning).toBe(false);
    });

    test("returns null state initially when sourceTokens is empty", () => {
      const { result } = renderHook(
        () =>
          useConsolidationPlanning({
            sourceTokens: [],
            destinationToken: createMockDestinationToken(),
            enabled: true,
            planId: "test-plan-1",
          }),
        { wrapper: createWrapper() },
      );

      expect(result.current.state).toBeNull();
      expect(result.current.isPlanning).toBe(false);
    });

    test("starts planning when sourceTokens is provided and enabled", async () => {
      const mockPlan = createMockPlan();
      mockPlanConsolidation.mockResolvedValue(mockPlan);

      const { result } = renderHook(
        () =>
          useConsolidationPlanning({
            sourceTokens: [createMockSourceToken()],
            destinationToken: createMockDestinationToken(),
            enabled: true,
            planId: "test-plan-1",
          }),
        { wrapper: createWrapper() },
      );

      expect(result.current.isPlanning).toBe(true);

      await waitFor(() => {
        expect(result.current.state).not.toBeNull();
      });

      expect(mockPlanConsolidation).toHaveBeenCalled();
    });
  });

  describe("planning", () => {
    test("calls planConsolidation with correct arguments", async () => {
      const sourceTokens = [createMockSourceToken()];
      const destinationToken = createMockDestinationToken();
      const connectedWallets = ["0xabcdefabcdefabcdefabcdefabcdefabcdefabcd"];
      mockUseConnectedAddresses.mockReturnValue(connectedWallets);
      mockPlanConsolidation.mockResolvedValue(createMockPlan());

      renderHook(
        () =>
          useConsolidationPlanning({
            sourceTokens,
            destinationToken,
            enabled: true,
            planId: "test-plan-1",
          }),
        { wrapper: createWrapper() },
      );

      await waitFor(() => {
        expect(mockPlanConsolidation).toHaveBeenCalledWith(
          sourceTokens,
          destinationToken,
          connectedWallets,
          undefined,
          undefined,
          [], // warnings out-array, filled by planning when tokens are dropped
        );
      });
    });

    test("creates consolidation state from plan", async () => {
      const mockPlan = createMockPlan();
      const sourceTokens = [createMockSourceToken()];
      const destinationToken = createMockDestinationToken();
      mockPlanConsolidation.mockResolvedValue(mockPlan);

      const { result } = renderHook(
        () =>
          useConsolidationPlanning({
            sourceTokens,
            destinationToken,
            enabled: true,
            planId: "test-plan-1",
          }),
        { wrapper: createWrapper() },
      );

      await waitFor(() => {
        expect(result.current.state).not.toBeNull();
      });

      expect(result.current.state?.id).toBe("test-plan-1");
      expect(result.current.state?.plan).toEqual(mockPlan);
      expect(result.current.state?.status).toBe("ready");
      expect(result.current.state?.currentStepIndex).toBe(0);
      expect(result.current.state?.results).toEqual({});
      expect(result.current.state?.sourceTokens).toEqual(sourceTokens);
      expect(result.current.state?.destinationToken).toEqual(destinationToken);
    });

    test("sets isPlanning to true during planning", async () => {
      mockPlanConsolidation.mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve(createMockPlan()), 100);
          }),
      );

      const { result } = renderHook(
        () =>
          useConsolidationPlanning({
            sourceTokens: [createMockSourceToken()],
            destinationToken: createMockDestinationToken(),
            enabled: true,
            planId: "test-plan-1",
          }),
        { wrapper: createWrapper() },
      );

      expect(result.current.isPlanning).toBe(true);

      await waitFor(() => {
        expect(result.current.isPlanning).toBe(false);
      });
    });

    test("handles planning errors", async () => {
      const error = new Error("Planning failed");
      mockPlanConsolidation.mockRejectedValue(error);

      const { result } = renderHook(
        () =>
          useConsolidationPlanning({
            sourceTokens: [createMockSourceToken()],
            destinationToken: createMockDestinationToken(),
            enabled: true,
            planId: "test-plan-1",
          }),
        { wrapper: createWrapper() },
      );

      await waitFor(() => {
        expect(result.current.planError).toBe("Planning failed");
      });

      expect(result.current.state).toBeNull();
    });

    test("handles non-Error planning errors", async () => {
      mockPlanConsolidation.mockRejectedValue("String error");

      const { result } = renderHook(
        () =>
          useConsolidationPlanning({
            sourceTokens: [createMockSourceToken()],
            destinationToken: createMockDestinationToken(),
            enabled: true,
            planId: "test-plan-1",
          }),
        { wrapper: createWrapper() },
      );

      await waitFor(() => {
        expect(result.current.planError).toBe("");
      });
    });
  });

  describe("query caching", () => {
    test("uses planId in query key", async () => {
      mockPlanConsolidation.mockResolvedValue(createMockPlan());

      // Create a shared wrapper for both renders to share the same QueryClient cache
      const wrapper = createWrapper();

      const { result: result1, unmount: unmount1 } = renderHook(
        () =>
          useConsolidationPlanning({
            sourceTokens: [createMockSourceToken()],
            destinationToken: createMockDestinationToken(),
            enabled: true,
            planId: "plan-1",
          }),
        { wrapper },
      );

      await waitFor(() => {
        expect(result1.current.state).not.toBeNull();
      });

      unmount1();
      mockPlanConsolidation.mockClear();

      // Same planId should use cached result
      const { result: result2 } = renderHook(
        () =>
          useConsolidationPlanning({
            sourceTokens: [createMockSourceToken()],
            destinationToken: createMockDestinationToken(),
            enabled: true,
            planId: "plan-1",
          }),
        { wrapper },
      );

      await waitFor(() => {
        expect(result2.current.state).not.toBeNull();
      });

      // Should not call planConsolidation again due to caching
      expect(mockPlanConsolidation).not.toHaveBeenCalled();
    });

    test("uses connectedWalletKey in query key", async () => {
      mockPlanConsolidation.mockResolvedValue(createMockPlan());
      mockUseConnectedAddresses.mockReturnValue(["0xaaa"]);

      const { result: result1, unmount } = renderHook(
        () =>
          useConsolidationPlanning({
            sourceTokens: [createMockSourceToken()],
            destinationToken: createMockDestinationToken(),
            enabled: true,
            planId: "plan-1",
          }),
        { wrapper: createWrapper() },
      );

      await waitFor(() => {
        expect(result1.current.state).not.toBeNull();
      });

      unmount();
      mockPlanConsolidation.mockClear();

      // Different connected wallets should trigger new planning
      mockUseConnectedAddresses.mockReturnValue(["0xbbb"]);

      renderHook(
        () =>
          useConsolidationPlanning({
            sourceTokens: [createMockSourceToken()],
            destinationToken: createMockDestinationToken(),
            enabled: true,
            planId: "plan-1",
          }),
        { wrapper: createWrapper() },
      );

      await waitFor(() => {
        expect(mockPlanConsolidation).toHaveBeenCalled();
      });
    });

    test("normalizes connectedWallets for cache key", async () => {
      mockPlanConsolidation.mockResolvedValue(createMockPlan());

      // Create a shared wrapper for both renders to share the same QueryClient cache
      const wrapper = createWrapper();

      // Same addresses in different order and case should use same cache
      mockUseConnectedAddresses.mockReturnValue(["0xAAA", "0xBBB"]);

      const { result: result1, unmount: unmount1 } = renderHook(
        () =>
          useConsolidationPlanning({
            sourceTokens: [createMockSourceToken()],
            destinationToken: createMockDestinationToken(),
            enabled: true,
            planId: "plan-1",
          }),
        { wrapper },
      );

      await waitFor(() => {
        expect(result1.current.state).not.toBeNull();
      });

      unmount1();
      mockPlanConsolidation.mockClear();

      mockUseConnectedAddresses.mockReturnValue(["0xbbb", "0xaaa"]);

      renderHook(
        () =>
          useConsolidationPlanning({
            sourceTokens: [createMockSourceToken()],
            destinationToken: createMockDestinationToken(),
            enabled: true,
            planId: "plan-1",
          }),
        { wrapper },
      );

      await waitFor(() => {
        // Should use cached result (addresses normalized to lowercase and sorted)
        expect(mockPlanConsolidation).not.toHaveBeenCalled();
      });
    });
  });

  describe("generatePlan", () => {
    test("refetches the plan when called", async () => {
      mockPlanConsolidation.mockResolvedValue(createMockPlan());

      const { result } = renderHook(
        () =>
          useConsolidationPlanning({
            sourceTokens: [createMockSourceToken()],
            destinationToken: createMockDestinationToken(),
            enabled: true,
            planId: "test-plan-1",
          }),
        { wrapper: createWrapper() },
      );

      await waitFor(() => {
        expect(result.current.state).not.toBeNull();
      });

      mockPlanConsolidation.mockClear();
      mockPlanConsolidation.mockResolvedValue(createMockPlan());

      act(() => {
        result.current.generatePlan();
      });

      await waitFor(() => {
        expect(mockPlanConsolidation).toHaveBeenCalled();
      });
    });
  });

  describe("enabled option", () => {
    test("does not plan when enabled is false", async () => {
      const { result } = renderHook(
        () =>
          useConsolidationPlanning({
            sourceTokens: [createMockSourceToken()],
            destinationToken: createMockDestinationToken(),
            enabled: false,
            planId: "test-plan-1",
          }),
        { wrapper: createWrapper() },
      );

      expect(result.current.isPlanning).toBe(false);
      expect(mockPlanConsolidation).not.toHaveBeenCalled();
    });

    test("starts planning when enabled changes to true", async () => {
      mockPlanConsolidation.mockResolvedValue(createMockPlan());

      const { result, rerender } = renderHook(
        ({ enabled }: { enabled: boolean }) =>
          useConsolidationPlanning({
            sourceTokens: [createMockSourceToken()],
            destinationToken: createMockDestinationToken(),
            enabled,
            planId: "test-plan-1",
          }),
        { wrapper: createWrapper(), initialProps: { enabled: false } },
      );

      expect(result.current.isPlanning).toBe(false);
      expect(mockPlanConsolidation).not.toHaveBeenCalled();

      rerender({ enabled: true });

      await waitFor(() => {
        expect(mockPlanConsolidation).toHaveBeenCalled();
      });
    });
  });

  describe("state structure", () => {
    test("includes timestamps in state", async () => {
      mockPlanConsolidation.mockResolvedValue(createMockPlan());
      const beforeTime = Date.now();

      const { result } = renderHook(
        () =>
          useConsolidationPlanning({
            sourceTokens: [createMockSourceToken()],
            destinationToken: createMockDestinationToken(),
            enabled: true,
            planId: "test-plan-1",
          }),
        { wrapper: createWrapper() },
      );

      await waitFor(() => {
        expect(result.current.state).not.toBeNull();
      });

      const afterTime = Date.now();

      expect(result.current.state?.createdAt).toBeGreaterThanOrEqual(beforeTime);
      expect(result.current.state?.createdAt).toBeLessThanOrEqual(afterTime);
      expect(result.current.state?.updatedAt).toBe(result.current.state?.createdAt);
    });
  });
});
