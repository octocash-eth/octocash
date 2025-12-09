import { render } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { ChainIcon } from "./chain-icon";

describe("ChainIcon", () => {
  describe("rendering", () => {
    test("renders avatar component", () => {
      const { container } = render(<ChainIcon chain="Ethereum" />);

      const avatar = container.querySelector('[data-slot="avatar"]');
      expect(avatar).toBeInTheDocument();
    });

    test("renders avatar fallback", () => {
      const { container } = render(<ChainIcon chain="Ethereum" />);

      const fallback = container.querySelector('[data-slot="avatar-fallback"]');
      expect(fallback).toBeInTheDocument();
    });

    test("applies custom className to avatar", () => {
      const { container } = render(<ChainIcon chain="Ethereum" className="custom-class" />);

      const avatar = container.querySelector('[data-slot="avatar"]');
      expect(avatar).toHaveClass("custom-class");
    });

    test("renders without className when not provided", () => {
      const { container } = render(<ChainIcon chain="Ethereum" />);

      const avatar = container.querySelector('[data-slot="avatar"]');
      expect(avatar).toBeInTheDocument();
      expect(avatar).not.toHaveClass("custom-class");
    });

    test("can override default classes with custom className", () => {
      const { container } = render(<ChainIcon chain="Polygon" className="w-12 h-12" />);

      const avatar = container.querySelector('[data-slot="avatar"]');
      expect(avatar).toHaveClass("w-12");
      expect(avatar).toHaveClass("h-12");
    });
  });

  describe("fallback rendering", () => {
    test("displays first letter of chain name in uppercase", () => {
      const { container } = render(<ChainIcon chain="ethereum" />);

      const fallback = container.querySelector('[data-slot="avatar-fallback"]');
      expect(fallback).toHaveTextContent("E");
    });

    test("displays correct first letter for different chains", () => {
      const chains = [
        { name: "Polygon", expectedLetter: "P" },
        { name: "Arbitrum", expectedLetter: "A" },
        { name: "Optimism", expectedLetter: "O" },
        { name: "Base", expectedLetter: "B" },
        { name: "Binance Smart Chain", expectedLetter: "B" },
      ];

      for (const chain of chains) {
        const { container } = render(<ChainIcon chain={chain.name} />);
        const fallback = container.querySelector('[data-slot="avatar-fallback"]');
        expect(fallback).toHaveTextContent(chain.expectedLetter);
      }
    });

    test("converts first letter to uppercase even if chain name is lowercase", () => {
      const { container } = render(<ChainIcon chain="avalanche" />);

      const fallback = container.querySelector('[data-slot="avatar-fallback"]');
      expect(fallback).toHaveTextContent("A");
    });

    test("converts first letter to uppercase even if chain name is mixed case", () => {
      const { container } = render(<ChainIcon chain="eThErEuM" />);

      const fallback = container.querySelector('[data-slot="avatar-fallback"]');
      expect(fallback).toHaveTextContent("E");
    });

    test("fallback has correct styling classes", () => {
      const { container } = render(<ChainIcon chain="Ethereum" />);

      const fallback = container.querySelector('[data-slot="avatar-fallback"]');
      expect(fallback).toHaveClass("text-[10px]");
      expect(fallback).toHaveClass("text-muted-foreground");
      expect(fallback).toHaveClass("bg-muted");
    });
  });

  describe("edge cases", () => {
    test("handles empty string chain name", () => {
      const { container } = render(<ChainIcon chain="" />);

      const avatar = container.querySelector('[data-slot="avatar"]');
      expect(avatar).toBeInTheDocument();

      const fallback = container.querySelector('[data-slot="avatar-fallback"]');
      expect(fallback).toBeInTheDocument();
      // Empty string's first character uppercased is empty
      expect(fallback?.textContent).toBe("");
    });

    test("handles single character chain name", () => {
      const { container } = render(<ChainIcon chain="X" />);

      const avatar = container.querySelector('[data-slot="avatar"]');
      expect(avatar).toBeInTheDocument();

      const fallback = container.querySelector('[data-slot="avatar-fallback"]');
      expect(fallback).toHaveTextContent("X");
    });

    test("handles chain name with leading spaces", () => {
      const { container } = render(<ChainIcon chain="  Ethereum" />);

      const avatar = container.querySelector('[data-slot="avatar"]');
      expect(avatar).toBeInTheDocument();

      const fallback = container.querySelector('[data-slot="avatar-fallback"]');
      // Space character at position 0
      expect(fallback).toBeInTheDocument();
    });

    test("handles chain name with trailing spaces", () => {
      const { container } = render(<ChainIcon chain="Ethereum  " />);

      const avatar = container.querySelector('[data-slot="avatar"]');
      expect(avatar).toBeInTheDocument();

      const fallback = container.querySelector('[data-slot="avatar-fallback"]');
      expect(fallback).toHaveTextContent("E");
    });

    test("handles chain name with special characters", () => {
      const { container } = render(<ChainIcon chain="Chain-2.0" />);

      const avatar = container.querySelector('[data-slot="avatar"]');
      expect(avatar).toBeInTheDocument();

      const fallback = container.querySelector('[data-slot="avatar-fallback"]');
      expect(fallback).toHaveTextContent("C");
    });

    test("handles numeric chain name", () => {
      const { container } = render(<ChainIcon chain="123" />);

      const avatar = container.querySelector('[data-slot="avatar"]');
      expect(avatar).toBeInTheDocument();

      const fallback = container.querySelector('[data-slot="avatar-fallback"]');
      expect(fallback).toHaveTextContent("1");
    });

    test("handles lowercase chain name", () => {
      const { container } = render(<ChainIcon chain="polygon" />);

      const avatar = container.querySelector('[data-slot="avatar"]');
      expect(avatar).toBeInTheDocument();

      const fallback = container.querySelector('[data-slot="avatar-fallback"]');
      expect(fallback).toHaveTextContent("P");
    });

    test("handles UPPERCASE chain name", () => {
      const { container } = render(<ChainIcon chain="ETHEREUM" />);

      const avatar = container.querySelector('[data-slot="avatar"]');
      expect(avatar).toBeInTheDocument();

      const fallback = container.querySelector('[data-slot="avatar-fallback"]');
      expect(fallback).toHaveTextContent("E");
    });
  });

  describe("common chain names", () => {
    const commonChains = [
      { name: "Ethereum", letter: "E" },
      { name: "Polygon", letter: "P" },
      { name: "Arbitrum", letter: "A" },
      { name: "Optimism", letter: "O" },
      { name: "Base", letter: "B" },
      { name: "Avalanche", letter: "A" },
      { name: "Binance Smart Chain", letter: "B" },
    ];

    for (const chain of commonChains) {
      test(`renders ${chain.name} correctly`, () => {
        const { container } = render(<ChainIcon chain={chain.name} />);

        const avatar = container.querySelector('[data-slot="avatar"]');
        expect(avatar).toBeInTheDocument();

        const fallback = container.querySelector('[data-slot="avatar-fallback"]');
        expect(fallback).toHaveTextContent(chain.letter);
      });
    }
  });

  describe("component structure", () => {
    test("renders Avatar component", () => {
      const { container } = render(<ChainIcon chain="Ethereum" />);

      const avatar = container.querySelector('[data-slot="avatar"]');
      expect(avatar).toBeInTheDocument();
    });

    test("contains AvatarFallback", () => {
      const { container } = render(<ChainIcon chain="Ethereum" />);

      const fallback = container.querySelector('[data-slot="avatar-fallback"]');
      expect(fallback).toBeInTheDocument();
    });

    test("avatar fallback contains text", () => {
      const { container } = render(<ChainIcon chain="Ethereum" />);

      const fallback = container.querySelector('[data-slot="avatar-fallback"]');
      expect(fallback).toBeInTheDocument();
      expect(fallback?.textContent).toBeTruthy();
    });

    test("avatar has rounded styling by default", () => {
      const { container } = render(<ChainIcon chain="Ethereum" />);

      const avatar = container.querySelector('[data-slot="avatar"]');
      // The Avatar component has rounded-full by default
      expect(avatar).toHaveClass("rounded-full");
    });
  });

  describe("className handling", () => {
    test("applies single custom class", () => {
      const { container } = render(<ChainIcon chain="Ethereum" className="test-class" />);

      const avatar = container.querySelector('[data-slot="avatar"]');
      expect(avatar).toHaveClass("test-class");
    });

    test("applies multiple custom classes", () => {
      const { container } = render(<ChainIcon chain="Ethereum" className="test-class-1 test-class-2" />);

      const avatar = container.querySelector('[data-slot="avatar"]');
      expect(avatar).toHaveClass("test-class-1");
      expect(avatar).toHaveClass("test-class-2");
    });

    test("merges custom className with default classes", () => {
      const { container } = render(<ChainIcon chain="Ethereum" className="w-16 h-16" />);

      const avatar = container.querySelector('[data-slot="avatar"]');
      // Should have both custom and default classes
      expect(avatar).toHaveClass("w-16");
      expect(avatar).toHaveClass("h-16");
      expect(avatar).toHaveClass("rounded-full"); // default class
    });
  });
});
