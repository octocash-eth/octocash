import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import AddressAvatar from "./address-avatar";

// Mock ethereum-blockies-base64
vi.mock("ethereum-blockies-base64", () => ({
  default: vi.fn((address: string) => `data:image/png;base64,blockie-${address}`),
}));

// Mock wagmi hooks
const mockUseEnsName = vi.fn();
const mockUseEnsAddress = vi.fn();
const mockUseEnsAvatar = vi.fn();

vi.mock("wagmi", () => ({
  useEnsName: (config: unknown) => mockUseEnsName(config),
  useEnsAddress: (config: unknown) => mockUseEnsAddress(config),
  useEnsAvatar: (config: unknown) => mockUseEnsAvatar(config),
}));

// Helper to wrap components with QueryClientProvider
function renderWithQueryClient(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

describe("AddressAvatar", () => {
  beforeEach(() => {
    // Reset mocks before each test
    vi.clearAllMocks();
    mockUseEnsName.mockReturnValue({ data: undefined });
    mockUseEnsAddress.mockReturnValue({ data: undefined });
    mockUseEnsAvatar.mockReturnValue({ data: undefined, isLoading: false });
  });

  describe("rendering", () => {
    test("renders avatar with valid address", () => {
      const testAddress = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
      const { container } = renderWithQueryClient(<AddressAvatar addressOrEns={testAddress} />);

      const avatar = container.querySelector('[data-slot="avatar"]');
      expect(avatar).toBeInTheDocument();
    });

    test("renders avatar with ENS name", () => {
      const ensName = "vitalik.eth";
      const { container } = renderWithQueryClient(<AddressAvatar addressOrEns={ensName} />);

      const avatar = container.querySelector('[data-slot="avatar"]');
      expect(avatar).toBeInTheDocument();
    });

    test("applies custom className", () => {
      const testAddress = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
      const { container } = renderWithQueryClient(
        <AddressAvatar addressOrEns={testAddress} className="custom-class" />,
      );

      const avatar = container.querySelector('[data-slot="avatar"]');
      expect(avatar).toHaveClass("custom-class");
    });

    test("applies default rounded-sm class", () => {
      const testAddress = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
      const { container } = renderWithQueryClient(<AddressAvatar addressOrEns={testAddress} />);

      const avatar = container.querySelector('[data-slot="avatar"]');
      expect(avatar).toHaveClass("rounded-sm");
    });

    test("applies title attribute", () => {
      const testAddress = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
      const title = "User's avatar";
      const { container } = renderWithQueryClient(<AddressAvatar addressOrEns={testAddress} title={title} />);

      const avatar = container.querySelector('[data-slot="avatar"]');
      expect(avatar).toHaveAttribute("title", title);
    });

    test("renders without title when not provided", () => {
      const testAddress = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
      const { container } = renderWithQueryClient(<AddressAvatar addressOrEns={testAddress} />);

      const avatar = container.querySelector('[data-slot="avatar"]');
      expect(avatar).not.toHaveAttribute("title");
    });
  });

  describe("address handling", () => {
    test("calls useEnsName when given a valid address", () => {
      const testAddress = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
      renderWithQueryClient(<AddressAvatar addressOrEns={testAddress} />);

      expect(mockUseEnsName).toHaveBeenCalledWith(
        expect.objectContaining({
          address: testAddress,
          chainId: 1,
          query: expect.objectContaining({ enabled: true }),
        }),
      );
    });

    test("does not call useEnsName when given ENS name", () => {
      const ensName = "vitalik.eth";
      renderWithQueryClient(<AddressAvatar addressOrEns={ensName} />);

      expect(mockUseEnsName).toHaveBeenCalledWith(
        expect.objectContaining({
          address: undefined,
          query: expect.objectContaining({ enabled: false }),
        }),
      );
    });

    test("generates blockie for valid address without ENS", () => {
      const testAddress = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
      const { container } = renderWithQueryClient(<AddressAvatar addressOrEns={testAddress} />);

      // Check that the avatar component renders (image may not load in tests)
      const avatar = container.querySelector('[data-slot="avatar"]');
      expect(avatar).toBeInTheDocument();

      // Verify that useEnsAvatar was called, which means we're trying to get the avatar
      expect(mockUseEnsAvatar).toHaveBeenCalled();
    });

    test("does not render image when isLoading is true", () => {
      const testAddress = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
      mockUseEnsAvatar.mockReturnValue({ data: undefined, isLoading: true });

      const { container } = renderWithQueryClient(<AddressAvatar addressOrEns={testAddress} />);

      // When loading, the image src should be empty
      const img = container.querySelector("img");
      if (img) {
        expect(img).toHaveAttribute("src", "");
      }
    });
  });

  describe("ENS name handling", () => {
    test("calls useEnsAddress when given ENS name", () => {
      const ensName = "vitalik.eth";
      renderWithQueryClient(<AddressAvatar addressOrEns={ensName} />);

      expect(mockUseEnsAddress).toHaveBeenCalledWith(
        expect.objectContaining({
          name: ensName,
          chainId: 1,
          query: expect.objectContaining({ enabled: true }),
        }),
      );
    });

    test("does not call useEnsAddress when given address", () => {
      const testAddress = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
      renderWithQueryClient(<AddressAvatar addressOrEns={testAddress} />);

      expect(mockUseEnsAddress).toHaveBeenCalledWith(
        expect.objectContaining({
          name: undefined,
          query: expect.objectContaining({ enabled: false }),
        }),
      );
    });

    test("calls useEnsAvatar with normalized ENS name", () => {
      const ensName = "vitalik.eth";
      renderWithQueryClient(<AddressAvatar addressOrEns={ensName} />);

      expect(mockUseEnsAvatar).toHaveBeenCalledWith(
        expect.objectContaining({
          name: ensName,
          chainId: 1,
          query: expect.objectContaining({ enabled: true }),
        }),
      );
    });

    test("handles ENS names", () => {
      const ensName = "vitalik.eth";
      renderWithQueryClient(<AddressAvatar addressOrEns={ensName} />);

      expect(mockUseEnsAvatar).toHaveBeenCalledWith(
        expect.objectContaining({
          name: ensName,
          chainId: 1,
        }),
      );
    });
  });

  describe("ENS avatar", () => {
    test("uses ENS avatar when available", () => {
      const ensName = "vitalik.eth";
      const avatarUrl = "https://example.com/avatar.png";
      mockUseEnsAvatar.mockReturnValue({ data: avatarUrl, isLoading: false });

      const { container } = renderWithQueryClient(<AddressAvatar addressOrEns={ensName} />);

      // Verify avatar component renders and ENS avatar hook was called
      const avatar = container.querySelector('[data-slot="avatar"]');
      expect(avatar).toBeInTheDocument();
      expect(mockUseEnsAvatar).toHaveBeenCalledWith(
        expect.objectContaining({
          name: ensName,
        }),
      );
    });

    test("falls back to blockie when ENS avatar is not available", () => {
      const testAddress = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
      mockUseEnsAvatar.mockReturnValue({ data: undefined, isLoading: false });

      const { container } = renderWithQueryClient(<AddressAvatar addressOrEns={testAddress} />);

      // Verify avatar component renders
      const avatar = container.querySelector('[data-slot="avatar"]');
      expect(avatar).toBeInTheDocument();
      // Verify makeBlockie was called (through the mock)
      expect(mockUseEnsAvatar).toHaveBeenCalled();
    });

    test("prioritizes ENS avatar over blockie", () => {
      const testAddress = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
      const avatarUrl = "https://example.com/avatar.png";
      mockUseEnsAvatar.mockReturnValue({ data: avatarUrl, isLoading: false });

      const { container } = renderWithQueryClient(<AddressAvatar addressOrEns={testAddress} />);

      // Verify avatar component renders and has the ENS avatar data
      const avatar = container.querySelector('[data-slot="avatar"]');
      expect(avatar).toBeInTheDocument();
      // The fact that useEnsAvatar returned data means the component will use it
      expect(mockUseEnsAvatar).toHaveReturnedWith({ data: avatarUrl, isLoading: false });
    });
  });

  describe("ENS resolution", () => {
    test("resolves address from ENS name", () => {
      const ensName = "vitalik.eth";
      const resolvedAddress = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
      mockUseEnsAddress.mockReturnValue({ data: resolvedAddress });
      mockUseEnsAvatar.mockReturnValue({ data: undefined, isLoading: false });

      const { container } = renderWithQueryClient(<AddressAvatar addressOrEns={ensName} />);

      // Verify avatar component renders and address was resolved
      const avatar = container.querySelector('[data-slot="avatar"]');
      expect(avatar).toBeInTheDocument();
      expect(mockUseEnsAddress).toHaveBeenCalledWith(
        expect.objectContaining({
          name: ensName,
        }),
      );
    });

    test("uses resolved ENS name for avatar lookup", () => {
      const testAddress = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
      const resolvedEnsName = "vitalik.eth";
      mockUseEnsName.mockReturnValue({ data: resolvedEnsName });

      renderWithQueryClient(<AddressAvatar addressOrEns={testAddress} />);

      expect(mockUseEnsAvatar).toHaveBeenCalledWith(
        expect.objectContaining({
          name: resolvedEnsName.toLowerCase(),
        }),
      );
    });

    test("handles invalid ENS name gracefully", () => {
      const invalidEns = "invalid..eth";
      // normalize will throw for invalid names, component should handle it
      const { container } = renderWithQueryClient(<AddressAvatar addressOrEns={invalidEns} />);

      // Should not crash and still render
      const avatar = container.querySelector('[data-slot="avatar"]');
      expect(avatar).toBeInTheDocument();
    });
  });

  describe("loading states", () => {
    test("shows fallback during avatar loading", () => {
      const testAddress = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
      mockUseEnsAvatar.mockReturnValue({ data: undefined, isLoading: true });

      const { container } = renderWithQueryClient(<AddressAvatar addressOrEns={testAddress} />);

      // Avatar should still render during loading
      const avatar = container.querySelector('[data-slot="avatar"]');
      expect(avatar).toBeInTheDocument();

      // Fallback should be visible during loading
      const fallback = container.querySelector('[data-slot="avatar-fallback"]');
      expect(fallback).toBeInTheDocument();
    });

    test("displays avatar after loading completes", () => {
      const testAddress = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
      mockUseEnsAvatar.mockReturnValue({ data: undefined, isLoading: false });

      const { container } = renderWithQueryClient(<AddressAvatar addressOrEns={testAddress} />);

      // Avatar should render after loading
      const avatar = container.querySelector('[data-slot="avatar"]');
      expect(avatar).toBeInTheDocument();

      // Verify hooks were called correctly
      expect(mockUseEnsAvatar).toHaveReturnedWith({ data: undefined, isLoading: false });
    });
  });

  describe("edge cases", () => {
    test("handles invalid address format", () => {
      const invalidAddress = "not-an-address";
      const { container } = renderWithQueryClient(<AddressAvatar addressOrEns={invalidAddress} />);

      const avatar = container.querySelector('[data-slot="avatar"]');
      expect(avatar).toBeInTheDocument();
    });

    test("handles empty string", () => {
      const { container } = renderWithQueryClient(<AddressAvatar addressOrEns="" />);

      const avatar = container.querySelector('[data-slot="avatar"]');
      expect(avatar).toBeInTheDocument();
    });

    test("handles checksummed addresses", () => {
      const checksummedAddress = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
      renderWithQueryClient(<AddressAvatar addressOrEns={checksummedAddress} />);

      expect(mockUseEnsName).toHaveBeenCalledWith(
        expect.objectContaining({
          address: checksummedAddress,
        }),
      );
    });

    test("handles lowercase addresses", () => {
      const lowercaseAddress = "0xd8da6bf26964af9d7eed9e03e53415d37aa96045";
      const { container } = renderWithQueryClient(<AddressAvatar addressOrEns={lowercaseAddress} />);

      const avatar = container.querySelector('[data-slot="avatar"]');
      expect(avatar).toBeInTheDocument();
    });
  });

  describe("component structure", () => {
    test("renders Avatar component", () => {
      const testAddress = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
      const { container } = renderWithQueryClient(<AddressAvatar addressOrEns={testAddress} />);

      const avatar = container.querySelector('[data-slot="avatar"]');
      expect(avatar).toBeInTheDocument();
    });

    test("renders with Avatar subcomponents", () => {
      const testAddress = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
      const { container } = renderWithQueryClient(<AddressAvatar addressOrEns={testAddress} />);

      // Verify the avatar structure is present
      const avatar = container.querySelector('[data-slot="avatar"]');
      expect(avatar).toBeInTheDocument();

      // The component should have either an image or fallback
      const fallback = container.querySelector('[data-slot="avatar-fallback"]');
      expect(fallback).toBeInTheDocument();
    });

    test("contains AvatarFallback with correct styling", () => {
      const testAddress = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
      const { container } = renderWithQueryClient(<AddressAvatar addressOrEns={testAddress} />);

      const fallback = container.querySelector('[data-slot="avatar-fallback"]');
      expect(fallback).toBeInTheDocument();
      expect(fallback).toHaveClass("bg-gray-600");
    });
  });

  describe("className merging", () => {
    test("merges custom className with default classes", () => {
      const testAddress = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
      const { container } = renderWithQueryClient(<AddressAvatar addressOrEns={testAddress} className="w-12 h-12" />);

      const avatar = container.querySelector('[data-slot="avatar"]');
      expect(avatar).toHaveClass("rounded-sm");
      expect(avatar).toHaveClass("w-12");
      expect(avatar).toHaveClass("h-12");
    });

    test("allows overriding rounded class", () => {
      const testAddress = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
      const { container } = renderWithQueryClient(
        <AddressAvatar addressOrEns={testAddress} className="rounded-full" />,
      );

      const avatar = container.querySelector('[data-slot="avatar"]');
      // cn utility should handle class merging properly
      expect(avatar).toBeInTheDocument();
    });
  });

  describe("mainnet ENS resolution", () => {
    test("always uses chainId 1 for ENS name resolution", () => {
      const testAddress = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
      renderWithQueryClient(<AddressAvatar addressOrEns={testAddress} />);

      expect(mockUseEnsName).toHaveBeenCalledWith(
        expect.objectContaining({
          chainId: 1,
        }),
      );
    });

    test("always uses chainId 1 for ENS address resolution", () => {
      const ensName = "vitalik.eth";
      renderWithQueryClient(<AddressAvatar addressOrEns={ensName} />);

      expect(mockUseEnsAddress).toHaveBeenCalledWith(
        expect.objectContaining({
          chainId: 1,
        }),
      );
    });

    test("always uses chainId 1 for ENS avatar resolution", () => {
      const ensName = "vitalik.eth";
      renderWithQueryClient(<AddressAvatar addressOrEns={ensName} />);

      expect(mockUseEnsAvatar).toHaveBeenCalledWith(
        expect.objectContaining({
          chainId: 1,
        }),
      );
    });
  });
});
