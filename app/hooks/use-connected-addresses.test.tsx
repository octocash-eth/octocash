import { renderHook } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { useConnectedAddresses } from "./use-connected-addresses";

// Mock wagmi
const mockUseAccount = vi.fn();
vi.mock("wagmi", () => ({
  useAccount: () => mockUseAccount(),
}));

describe("useConnectedAddresses", () => {
  describe("when wallet is not connected", () => {
    test("returns empty array when isConnected is false", () => {
      mockUseAccount.mockReturnValue({
        isConnected: false,
        addresses: undefined,
      });

      const { result } = renderHook(() => useConnectedAddresses());
      expect(result.current).toEqual([]);
    });

    test("returns empty array when isConnected is true but addresses is undefined", () => {
      mockUseAccount.mockReturnValue({
        isConnected: true,
        addresses: undefined,
      });

      const { result } = renderHook(() => useConnectedAddresses());
      expect(result.current).toEqual([]);
    });

    test("returns empty array when isConnected is true but addresses is null", () => {
      mockUseAccount.mockReturnValue({
        isConnected: true,
        addresses: null,
      });

      const { result } = renderHook(() => useConnectedAddresses());
      expect(result.current).toEqual([]);
    });
  });

  describe("when wallet is connected", () => {
    test("returns addresses when isConnected is true and addresses is provided", () => {
      const mockAddresses = ["0x1234567890123456789012345678901234567890"];
      mockUseAccount.mockReturnValue({
        isConnected: true,
        addresses: mockAddresses,
      });

      const { result } = renderHook(() => useConnectedAddresses());
      expect(result.current).toEqual(mockAddresses);
    });

    test("returns multiple addresses when multiple wallets are connected", () => {
      const mockAddresses = [
        "0x1234567890123456789012345678901234567890",
        "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
        "0x9876543210987654321098765432109876543210",
      ];
      mockUseAccount.mockReturnValue({
        isConnected: true,
        addresses: mockAddresses,
      });

      const { result } = renderHook(() => useConnectedAddresses());
      expect(result.current).toEqual(mockAddresses);
      expect(result.current).toHaveLength(3);
    });

    test("returns empty array when addresses is empty array", () => {
      mockUseAccount.mockReturnValue({
        isConnected: true,
        addresses: [],
      });

      const { result } = renderHook(() => useConnectedAddresses());
      expect(result.current).toEqual([]);
    });
  });

  describe("reactivity", () => {
    test("updates when connection status changes", () => {
      const mockAddresses = ["0x1234567890123456789012345678901234567890"];

      // Start disconnected
      mockUseAccount.mockReturnValue({
        isConnected: false,
        addresses: undefined,
      });

      const { result, rerender } = renderHook(() => useConnectedAddresses());
      expect(result.current).toEqual([]);

      // Connect wallet
      mockUseAccount.mockReturnValue({
        isConnected: true,
        addresses: mockAddresses,
      });

      rerender();
      expect(result.current).toEqual(mockAddresses);
    });

    test("updates when addresses change", () => {
      const initialAddresses = ["0x1234567890123456789012345678901234567890"];
      const updatedAddresses = [
        "0x1234567890123456789012345678901234567890",
        "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
      ];

      // Start with one address
      mockUseAccount.mockReturnValue({
        isConnected: true,
        addresses: initialAddresses,
      });

      const { result, rerender } = renderHook(() => useConnectedAddresses());
      expect(result.current).toEqual(initialAddresses);

      // Add another address
      mockUseAccount.mockReturnValue({
        isConnected: true,
        addresses: updatedAddresses,
      });

      rerender();
      expect(result.current).toEqual(updatedAddresses);
    });

    test("clears addresses when disconnected", () => {
      const mockAddresses = ["0x1234567890123456789012345678901234567890"];

      // Start connected
      mockUseAccount.mockReturnValue({
        isConnected: true,
        addresses: mockAddresses,
      });

      const { result, rerender } = renderHook(() => useConnectedAddresses());
      expect(result.current).toEqual(mockAddresses);

      // Disconnect
      mockUseAccount.mockReturnValue({
        isConnected: false,
        addresses: undefined,
      });

      rerender();
      expect(result.current).toEqual([]);
    });
  });
});
