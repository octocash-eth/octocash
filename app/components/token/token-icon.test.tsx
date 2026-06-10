import { render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { TokenIcon } from "./token-icon";

describe("TokenIcon", () => {
  describe("rendering", () => {
    test("renders avatar with token name", () => {
      const { container } = render(<TokenIcon token="ETH" />);

      const avatar = container.querySelector('[data-slot="avatar"]');
      expect(avatar).toBeInTheDocument();
    });

    test("applies custom className", () => {
      const { container } = render(<TokenIcon token="ETH" className="custom-class" />);

      const avatar = container.querySelector('[data-slot="avatar"]');
      expect(avatar).toHaveClass("custom-class");
    });

    test("renders without className when not provided", () => {
      const { container } = render(<TokenIcon token="ETH" />);

      const avatar = container.querySelector('[data-slot="avatar"]');
      expect(avatar).toBeInTheDocument();
    });
  });

  describe("icon URL handling", () => {
    test("renders avatar with iconUrl provided", () => {
      const iconUrl = "https://example.com/eth.png";
      const { container } = render(<TokenIcon token="ETH" iconUrl={iconUrl} />);

      const avatar = container.querySelector('[data-slot="avatar"]');
      expect(avatar).toBeInTheDocument();
    });

    test("renders without iconUrl", () => {
      const { container } = render(<TokenIcon token="ETH" />);

      const avatar = container.querySelector('[data-slot="avatar"]');
      expect(avatar).toBeInTheDocument();
    });

    test("handles empty iconUrl", () => {
      const { container } = render(<TokenIcon token="ETH" iconUrl="" />);

      const avatar = container.querySelector('[data-slot="avatar"]');
      expect(avatar).toBeInTheDocument();
    });

    test("renders with various icon URL formats", () => {
      const urls = [
        "https://example.com/token.png",
        "/local/path/token.svg",
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg",
      ];

      urls.forEach((url) => {
        const { container } = render(<TokenIcon token="TEST" iconUrl={url} />);
        const avatar = container.querySelector('[data-slot="avatar"]');
        expect(avatar).toBeInTheDocument();
      });
    });
  });

  describe("fallback behavior", () => {
    test("shows first character of token in uppercase as fallback", () => {
      const { container } = render(<TokenIcon token="eth" />);

      const fallback = container.querySelector('[data-slot="avatar-fallback"]');
      expect(fallback).toBeInTheDocument();
      expect(fallback).toHaveTextContent("E");
    });

    test("handles uppercase token names", () => {
      const { container } = render(<TokenIcon token="USDC" />);

      const fallback = container.querySelector('[data-slot="avatar-fallback"]');
      expect(fallback).toHaveTextContent("U");
    });

    test("handles lowercase token names", () => {
      const { container } = render(<TokenIcon token="dai" />);

      const fallback = container.querySelector('[data-slot="avatar-fallback"]');
      expect(fallback).toHaveTextContent("D");
    });

    test("handles mixed case token names", () => {
      const { container } = render(<TokenIcon token="wEth" />);

      const fallback = container.querySelector('[data-slot="avatar-fallback"]');
      expect(fallback).toHaveTextContent("W");
    });

    test("shows question mark for empty token", () => {
      const { container } = render(<TokenIcon token="" />);

      const fallback = container.querySelector('[data-slot="avatar-fallback"]');
      expect(fallback).toHaveTextContent("?");
    });

    test("fallback has correct styling classes", () => {
      const { container } = render(<TokenIcon token="ETH" />);

      const fallback = container.querySelector('[data-slot="avatar-fallback"]');
      expect(fallback).toHaveClass("text-[10px]");
      expect(fallback).toHaveClass("bg-muted");
      expect(fallback).toHaveClass("text-muted-foreground");
    });
  });

  describe("token name handling", () => {
    test("handles single character token", () => {
      const { container } = render(<TokenIcon token="X" />);

      const fallback = container.querySelector('[data-slot="avatar-fallback"]');
      expect(fallback).toHaveTextContent("X");
    });

    test("handles multi-character token", () => {
      const { container } = render(<TokenIcon token="ETHEREUM" />);

      const fallback = container.querySelector('[data-slot="avatar-fallback"]');
      expect(fallback).toHaveTextContent("E");
    });

    test("handles token with numbers", () => {
      const { container } = render(<TokenIcon token="1inch" />);

      const fallback = container.querySelector('[data-slot="avatar-fallback"]');
      expect(fallback).toHaveTextContent("1");
    });

    test("handles token with special characters", () => {
      const { container } = render(<TokenIcon token="$TOKEN" />);

      const fallback = container.querySelector('[data-slot="avatar-fallback"]');
      expect(fallback).toHaveTextContent("$");
    });

    test("handles token with spaces", () => {
      const { container } = render(<TokenIcon token=" ETH" />);

      const fallback = container.querySelector('[data-slot="avatar-fallback"]');
      // First character is a space, charAt(0) will get it
      expect(fallback).toBeInTheDocument();
    });

    test("handles common token symbols", () => {
      const tokens = ["ETH", "BTC", "USDC", "DAI", "USDT", "WETH", "WBTC"];

      tokens.forEach((token) => {
        const { container } = render(<TokenIcon token={token} />);
        const fallback = container.querySelector('[data-slot="avatar-fallback"]');
        expect(fallback).toHaveTextContent(token.charAt(0).toUpperCase());
      });
    });
  });

  describe("component structure", () => {
    test("renders Avatar component", () => {
      const { container } = render(<TokenIcon token="ETH" />);

      const avatar = container.querySelector('[data-slot="avatar"]');
      expect(avatar).toBeInTheDocument();
    });

    test("contains AvatarFallback", () => {
      const { container } = render(<TokenIcon token="ETH" />);

      const fallback = container.querySelector('[data-slot="avatar-fallback"]');
      expect(fallback).toBeInTheDocument();
    });
  });

  describe("className merging", () => {
    test("applies custom size classes", () => {
      const { container } = render(<TokenIcon token="ETH" className="w-12 h-12" />);

      const avatar = container.querySelector('[data-slot="avatar"]');
      expect(avatar).toHaveClass("w-12");
      expect(avatar).toHaveClass("h-12");
    });

    test("applies multiple custom classes", () => {
      const { container } = render(<TokenIcon token="ETH" className="w-8 h-8 rounded-full shadow-lg" />);

      const avatar = container.querySelector('[data-slot="avatar"]');
      expect(avatar).toHaveClass("w-8");
      expect(avatar).toHaveClass("h-8");
      expect(avatar).toHaveClass("rounded-full");
      expect(avatar).toHaveClass("shadow-lg");
    });
  });

  describe("edge cases", () => {
    test("handles non-alphabetic first character", () => {
      const { container } = render(<TokenIcon token="123TOKEN" />);

      const fallback = container.querySelector('[data-slot="avatar-fallback"]');
      expect(fallback).toHaveTextContent("1");
    });

    test("handles emoji in token name", () => {
      const { container } = render(<TokenIcon token="🚀ROCKET" />);

      const fallback = container.querySelector('[data-slot="avatar-fallback"]');
      expect(fallback).toBeInTheDocument();
    });

    test("handles token with only spaces", () => {
      const { container } = render(<TokenIcon token="   " />);

      const fallback = container.querySelector('[data-slot="avatar-fallback"]');
      expect(fallback).toBeInTheDocument();
    });

    test("handles very long token names", () => {
      const longToken = "A".repeat(100);
      const { container } = render(<TokenIcon token={longToken} />);

      const fallback = container.querySelector('[data-slot="avatar-fallback"]');
      expect(fallback).toHaveTextContent("A");
    });
  });

  describe("props handling", () => {
    test("accepts token and iconUrl props without error", () => {
      const { container } = render(<TokenIcon token="Ethereum" iconUrl="https://example.com/eth.png" />);

      const avatar = container.querySelector('[data-slot="avatar"]');
      expect(avatar).toBeInTheDocument();
    });

    test("accepts all valid prop combinations", () => {
      const testCases = [
        { token: "ETH", iconUrl: "https://example.com/eth.png", className: "w-12" },
        { token: "BTC", iconUrl: undefined, className: "h-12" },
        { token: "USDC", iconUrl: "", className: undefined },
      ];

      testCases.forEach(({ token, iconUrl, className }) => {
        const { container } = render(<TokenIcon token={token} iconUrl={iconUrl} className={className} />);
        const avatar = container.querySelector('[data-slot="avatar"]');
        expect(avatar).toBeInTheDocument();
      });
    });
  });
});

/**
 * Stubs the global `Image` so Radix's <AvatarImage> immediately resolves to
 * "loaded" (and therefore renders the underlying <img>), and records the last
 * `src` that gets requested.
 */
class MockImage {
  complete = false;
  naturalWidth = 0;
  referrerPolicy = "";
  crossOrigin: string | null = null;
  #listeners: Record<string, Set<() => void>> = {};
  #src = "";

  addEventListener(type: string, cb: () => void) {
    const set = this.#listeners[type] ?? new Set();
    set.add(cb);
    this.#listeners[type] = set;
  }

  removeEventListener(type: string, cb: () => void) {
    this.#listeners[type]?.delete(cb);
  }

  set src(value: string) {
    this.#src = value;
    this.complete = true;
    this.naturalWidth = 1;
    queueMicrotask(() => {
      for (const cb of this.#listeners.load ?? []) cb();
    });
  }

  get src() {
    return this.#src;
  }
}

describe("TokenIcon automatic asset variant", () => {
  const ICON_URL = "https://assets.octo.cash/token/1/0xabc";
  const originalClientWidth = Object.getOwnPropertyDescriptor(Element.prototype, "clientWidth");

  function setRenderedWidth(width: number) {
    Object.defineProperty(Element.prototype, "clientWidth", { configurable: true, get: () => width });
  }

  beforeEach(() => {
    vi.stubGlobal("Image", MockImage);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalClientWidth) {
      Object.defineProperty(Element.prototype, "clientWidth", originalClientWidth);
    } else {
      delete (Element.prototype as { clientWidth?: number }).clientWidth;
    }
  });

  async function renderedSrc(width: number) {
    setRenderedWidth(width);
    const { container } = render(<TokenIcon token="USDC" iconUrl={ICON_URL} />);
    await waitFor(() => {
      expect(container.querySelector("img")).toBeInTheDocument();
    });
    return container.querySelector("img")?.getAttribute("src");
  }

  test("keeps the default (thumb) url for small icons", async () => {
    // size-4/size-5 desktop icons (~16-20px) stay on the proxy default.
    expect(await renderedSrc(16)).toBe(ICON_URL);
  });

  test("requests ?size=small for a 44px (mobile list) icon", async () => {
    expect(await renderedSrc(44)).toBe(`${ICON_URL}?size=small`);
  });

  test("requests ?size=large for an oversized icon", async () => {
    expect(await renderedSrc(200)).toBe(`${ICON_URL}?size=large`);
  });

  test("an explicit size prop overrides the measured size", async () => {
    setRenderedWidth(44);
    const { container } = render(<TokenIcon token="USDC" iconUrl={ICON_URL} size="large" />);
    await waitFor(() => {
      expect(container.querySelector("img")).toHaveAttribute("src", `${ICON_URL}?size=large`);
    });
  });
});
