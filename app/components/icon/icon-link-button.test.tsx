import { render } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { IconLinkButton } from "./icon-link-button";

describe("IconLinkButton", () => {
  describe("rendering", () => {
    test("renders link element", () => {
      const { getByRole } = render(<IconLinkButton href="https://example.com" />);
      const link = getByRole("link");
      expect(link).toBeInTheDocument();
    });

    test("renders as anchor tag with button styles", () => {
      const { container } = render(<IconLinkButton href="https://example.com" />);
      const link = container.querySelector("a");
      expect(link).toBeInTheDocument();
    });

    test("renders with default external link icon", () => {
      const { container } = render(<IconLinkButton href="https://example.com" />);
      const icon = container.querySelector("svg");
      expect(icon).toBeInTheDocument();
    });

    test("renders with custom children", () => {
      const { getByText } = render(<IconLinkButton href="https://example.com">Custom</IconLinkButton>);
      expect(getByText("Custom")).toBeInTheDocument();
    });

    test("applies custom className", () => {
      const { container } = render(<IconLinkButton href="https://example.com" className="custom-class" />);
      const link = container.querySelector("a");
      expect(link).toHaveClass("custom-class");
    });

    test("has correct default title", () => {
      const { container } = render(<IconLinkButton href="https://example.com" />);
      const link = container.querySelector("a");
      expect(link).toHaveAttribute("title", "Open link");
    });

    test("has custom linkTitle", () => {
      const { container } = render(<IconLinkButton href="https://example.com" linkTitle="View details" />);
      const link = container.querySelector("a");
      expect(link).toHaveAttribute("title", "View details");
    });

    test("renders with ghost variant styles", () => {
      const { container } = render(<IconLinkButton href="https://example.com" />);
      const link = container.querySelector("a");
      expect(link).toBeInTheDocument();
    });

    test("renders with icon size", () => {
      const { container } = render(<IconLinkButton href="https://example.com" />);
      const link = container.querySelector("a");
      expect(link).toHaveClass("size-5");
    });
  });

  describe("link attributes", () => {
    test("has correct href attribute", () => {
      const { container } = render(<IconLinkButton href="https://example.com" />);
      const link = container.querySelector("a");
      expect(link).toHaveAttribute("href", "https://example.com");
    });

    test("opens in new tab", () => {
      const { container } = render(<IconLinkButton href="https://example.com" />);
      const link = container.querySelector("a");
      expect(link).toHaveAttribute("target", "_blank");
    });

    test("has noopener noreferrer for security", () => {
      const { container } = render(<IconLinkButton href="https://example.com" />);
      const link = container.querySelector("a");
      expect(link).toHaveAttribute("rel", "noopener noreferrer");
    });

    test("handles different URL formats", () => {
      const urls = [
        "https://example.com",
        "http://example.com",
        "https://example.com/path",
        "https://example.com/path?query=value",
        "https://example.com/path#anchor",
      ];

      urls.forEach((url) => {
        const { container } = render(<IconLinkButton href={url} />);
        const link = container.querySelector("a");
        expect(link).toHaveAttribute("href", url);
      });
    });

    test("handles URLs with special characters", () => {
      const url = "https://example.com/path?query=value&other=123#anchor";
      const { container } = render(<IconLinkButton href={url} />);
      const link = container.querySelector("a");
      expect(link).toHaveAttribute("href", url);
    });

    test("handles relative URLs", () => {
      const { container } = render(<IconLinkButton href="/relative/path" />);
      const link = container.querySelector("a");
      expect(link).toHaveAttribute("href", "/relative/path");
    });
  });

  describe("icon display", () => {
    test("shows external link icon by default", () => {
      const { container } = render(<IconLinkButton href="https://example.com" />);
      const icon = container.querySelector("svg");
      expect(icon).toBeInTheDocument();
    });

    test("icon has correct size class", () => {
      const { container } = render(<IconLinkButton href="https://example.com" />);
      const icon = container.querySelector("svg");
      expect(icon).toHaveClass("size-3");
    });

    test("renders custom children instead of default icon", () => {
      const { getByText } = render(
        <IconLinkButton href="https://example.com">
          <span>Custom Icon</span>
        </IconLinkButton>,
      );

      expect(getByText("Custom Icon")).toBeInTheDocument();
    });
  });

  describe("accessibility", () => {
    test("link is keyboard accessible", () => {
      const { getByRole } = render(<IconLinkButton href="https://example.com" />);
      const link = getByRole("link");
      expect(link).not.toHaveAttribute("tabindex", "-1");
    });

    test("has descriptive title attribute", () => {
      const { container } = render(<IconLinkButton href="https://example.com" linkTitle="View on explorer" />);
      const link = container.querySelector("a");
      expect(link).toHaveAttribute("title", "View on explorer");
    });

    test("link has proper security attributes", () => {
      const { container } = render(<IconLinkButton href="https://example.com" />);
      const link = container.querySelector("a");
      expect(link).toHaveAttribute("rel", "noopener noreferrer");
      expect(link).toHaveAttribute("target", "_blank");
    });
  });

  describe("props handling", () => {
    test("forwards ref to button wrapper", () => {
      const ref = { current: null };
      render(<IconLinkButton href="https://example.com" ref={ref} />);
      expect(ref.current).not.toBeNull();
    });

    test("spreads additional props to link", () => {
      const { getByRole } = render(<IconLinkButton href="https://example.com" data-testid="link-btn" />);
      const link = getByRole("link");
      expect(link).toHaveAttribute("data-testid", "link-btn");
    });

    test("accepts disabled prop", () => {
      const { container } = render(<IconLinkButton href="https://example.com" disabled />);
      const link = container.querySelector("a");
      expect(link).toHaveAttribute("tabindex", "-1");
    });

    test("accepts different button variants", () => {
      const { container: container1 } = render(<IconLinkButton href="https://example.com" variant="ghost" />);
      const link1 = container1.querySelector("a");
      expect(link1).toBeInTheDocument();

      const { container: container2 } = render(<IconLinkButton href="https://example.com" variant="outline" />);
      const link2 = container2.querySelector("a");
      expect(link2).toBeInTheDocument();
    });
  });

  describe("edge cases", () => {
    test("handles empty href", () => {
      const { container } = render(<IconLinkButton href="" />);
      const link = container.querySelector("a");
      expect(link).toHaveAttribute("href", "");
    });

    test("handles very long URLs", () => {
      const longUrl = `https://example.com/${"a".repeat(1000)}`;
      const { container } = render(<IconLinkButton href={longUrl} />);
      const link = container.querySelector("a");
      expect(link).toHaveAttribute("href", longUrl);
    });

    test("handles URLs with encoded characters", () => {
      const encodedUrl = "https://example.com/path?query=%20value%20with%20spaces";
      const { container } = render(<IconLinkButton href={encodedUrl} />);
      const link = container.querySelector("a");
      expect(link).toHaveAttribute("href", encodedUrl);
    });

    test("maintains structure through re-renders", () => {
      const { container, rerender } = render(<IconLinkButton href="https://example.com" />);
      const link1 = container.querySelector("a");
      expect(link1).toHaveAttribute("href", "https://example.com");

      rerender(<IconLinkButton href="https://different.com" />);
      const link2 = container.querySelector("a");
      expect(link2).toHaveAttribute("href", "https://different.com");
    });
  });

  describe("component structure", () => {
    test("renders as link with button styles", () => {
      const { container } = render(<IconLinkButton href="https://example.com" />);
      const link = container.querySelector("a");
      expect(link).toBeInTheDocument();
    });

    test("link contains icon element by default", () => {
      const { container } = render(<IconLinkButton href="https://example.com" />);
      const link = container.querySelector("a");
      const icon = link?.querySelector("svg");
      expect(icon).toBeInTheDocument();
    });

    test("has correct display name", () => {
      expect(IconLinkButton.displayName).toBe("IconLinkButton");
    });

    test("maintains size-5 class", () => {
      const { container } = render(<IconLinkButton href="https://example.com" />);
      const link = container.querySelector("a");
      expect(link).toHaveClass("size-5");
    });

    test("has rounded-sm class", () => {
      const { container } = render(<IconLinkButton href="https://example.com" />);
      const link = container.querySelector("a");
      expect(link).toHaveClass("rounded-sm");
    });

    test("has p-0 padding class", () => {
      const { container } = render(<IconLinkButton href="https://example.com" />);
      const link = container.querySelector("a");
      expect(link).toHaveClass("p-0");
    });

    test("uses asChild prop for composition", () => {
      const { container } = render(<IconLinkButton href="https://example.com" />);
      const link = container.querySelector("a");
      // The asChild pattern means Button is replaced by the anchor tag
      expect(link).toBeInTheDocument();
      expect(link).toHaveAttribute("data-slot", "button");
    });
  });

  describe("interaction", () => {
    test("link is clickable", () => {
      const { container } = render(<IconLinkButton href="https://example.com" />);
      const link = container.querySelector("a");
      expect(link).toBeInTheDocument();
      // Link should be functional (we can't test actual navigation in jsdom)
    });

    test("maintains functionality after re-renders", () => {
      const { container, rerender } = render(<IconLinkButton href="https://example1.com" />);
      const link1 = container.querySelector("a");
      expect(link1).toHaveAttribute("href", "https://example1.com");

      rerender(<IconLinkButton href="https://example2.com" />);
      const link2 = container.querySelector("a");
      expect(link2).toHaveAttribute("href", "https://example2.com");
    });
  });

  describe("button variants", () => {
    test("renders with default ghost variant", () => {
      const { container } = render(<IconLinkButton href="https://example.com" />);
      const link = container.querySelector("a");
      expect(link).toBeInTheDocument();
    });

    test("accepts ghost variant prop", () => {
      const { container } = render(<IconLinkButton href="https://example.com" variant="ghost" />);
      const link = container.querySelector("a");
      expect(link).toBeInTheDocument();
    });

    test("accepts outline variant prop", () => {
      const { container } = render(<IconLinkButton href="https://example.com" variant="outline" />);
      const link = container.querySelector("a");
      expect(link).toBeInTheDocument();
    });

    test("accepts default variant prop", () => {
      const { container } = render(<IconLinkButton href="https://example.com" variant="default" />);
      const link = container.querySelector("a");
      expect(link).toBeInTheDocument();
    });

    test("maintains link functionality across variants", () => {
      const variants: Array<"default" | "outline" | "ghost"> = ["default", "outline", "ghost"];

      variants.forEach((variant) => {
        const { container } = render(<IconLinkButton href="https://example.com" variant={variant} />);
        const link = container.querySelector("a");
        expect(link).toHaveAttribute("href", "https://example.com");
        expect(link).toHaveAttribute("target", "_blank");
        expect(link).toHaveAttribute("rel", "noopener noreferrer");
      });
    });
  });

  describe("security", () => {
    test("always includes noopener for security", () => {
      const { container } = render(<IconLinkButton href="https://example.com" />);
      const link = container.querySelector("a");
      const rel = link?.getAttribute("rel") || "";
      expect(rel).toContain("noopener");
    });

    test("always includes noreferrer for security", () => {
      const { container } = render(<IconLinkButton href="https://example.com" />);
      const link = container.querySelector("a");
      const rel = link?.getAttribute("rel") || "";
      expect(rel).toContain("noreferrer");
    });

    test("opens in new tab for external links", () => {
      const { container } = render(<IconLinkButton href="https://example.com" />);
      const link = container.querySelector("a");
      expect(link).toHaveAttribute("target", "_blank");
    });

    test("maintains security attributes with custom props", () => {
      const { container } = render(<IconLinkButton href="https://example.com" className="custom" />);
      const link = container.querySelector("a");
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noopener noreferrer");
    });
  });

  describe("visual states", () => {
    test("renders consistently for different URLs", () => {
      const urls = ["https://etherscan.io", "https://polygonscan.com", "https://arbiscan.io"];

      urls.forEach((url) => {
        const { container } = render(<IconLinkButton href={url} />);
        const link = container.querySelector("a");
        const icon = container.querySelector("svg");

        expect(link).toBeInTheDocument();
        expect(icon).toBeInTheDocument();
      });
    });

    test("maintains icon size across renders", () => {
      const { container, rerender } = render(<IconLinkButton href="https://example.com" />);
      const icon1 = container.querySelector("svg");
      expect(icon1).toHaveClass("size-3");

      rerender(<IconLinkButton href="https://different.com" />);
      const icon2 = container.querySelector("svg");
      expect(icon2).toHaveClass("size-3");
    });
  });
});
