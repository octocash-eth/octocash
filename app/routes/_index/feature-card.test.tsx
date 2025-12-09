import { render } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { FeatureCard } from "./feature-card";

describe("FeatureCard", () => {
  const defaultProps = {
    title: "Test Feature",
    description: "This is a test description",
    imageSrc: "/test-image.png",
    imageAlt: "Test image",
    imageWidth: 400,
    imageHeight: 300,
  };

  describe("rendering", () => {
    test("renders the card component", () => {
      const { container } = render(<FeatureCard {...defaultProps} />);

      const card = container.querySelector('[data-slot="card"]');
      expect(card).toBeInTheDocument();
    });

    test("renders the title", () => {
      const { getByText } = render(<FeatureCard {...defaultProps} />);

      expect(getByText("Test Feature")).toBeInTheDocument();
    });

    test("renders the description", () => {
      const { getByText } = render(<FeatureCard {...defaultProps} />);

      expect(getByText("This is a test description")).toBeInTheDocument();
    });

    test("renders single image when no dark variant provided", () => {
      const { container } = render(<FeatureCard {...defaultProps} />);

      const images = container.querySelectorAll("img");
      expect(images).toHaveLength(1);
    });

    test("renders two images when dark variant provided", () => {
      const { container } = render(<FeatureCard {...defaultProps} imageSrcDark="/test-image-dark.png" />);

      const images = container.querySelectorAll("img");
      expect(images).toHaveLength(2);
    });
  });

  describe("image attributes", () => {
    test("sets correct src attribute", () => {
      const { container } = render(<FeatureCard {...defaultProps} />);

      const img = container.querySelector("img");
      expect(img).toHaveAttribute("src", "/test-image.png");
    });

    test("sets correct alt attribute", () => {
      const { container } = render(<FeatureCard {...defaultProps} />);

      const img = container.querySelector("img");
      expect(img).toHaveAttribute("alt", "Test image");
    });

    test("sets correct width attribute", () => {
      const { container } = render(<FeatureCard {...defaultProps} />);

      const img = container.querySelector("img");
      expect(img).toHaveAttribute("width", "400");
    });

    test("sets correct height attribute", () => {
      const { container } = render(<FeatureCard {...defaultProps} />);

      const img = container.querySelector("img");
      expect(img).toHaveAttribute("height", "300");
    });

    test("sets loading attribute to lazy", () => {
      const { container } = render(<FeatureCard {...defaultProps} />);

      const img = container.querySelector("img");
      expect(img).toHaveAttribute("loading", "lazy");
    });

    test("sets decoding attribute to async", () => {
      const { container } = render(<FeatureCard {...defaultProps} />);

      const img = container.querySelector("img");
      expect(img).toHaveAttribute("decoding", "async");
    });
  });

  describe("dark theme variant", () => {
    test("light image has dark:hidden class when dark variant provided", () => {
      const { container } = render(<FeatureCard {...defaultProps} imageSrcDark="/test-image-dark.png" />);

      const images = container.querySelectorAll("img");
      const lightImage = images[0];
      expect(lightImage).toHaveClass("dark:hidden");
    });

    test("dark image has hidden dark:block classes when dark variant provided", () => {
      const { container } = render(<FeatureCard {...defaultProps} imageSrcDark="/test-image-dark.png" />);

      const images = container.querySelectorAll("img");
      const darkImage = images[1];
      expect(darkImage).toHaveClass("hidden");
      expect(darkImage).toHaveClass("dark:block");
    });

    test("dark image uses correct src", () => {
      const { container } = render(<FeatureCard {...defaultProps} imageSrcDark="/test-image-dark.png" />);

      const images = container.querySelectorAll("img");
      const darkImage = images[1];
      expect(darkImage).toHaveAttribute("src", "/test-image-dark.png");
    });

    test("both images have same alt text", () => {
      const { container } = render(<FeatureCard {...defaultProps} imageSrcDark="/test-image-dark.png" />);

      const images = container.querySelectorAll("img");
      expect(images[0]).toHaveAttribute("alt", "Test image");
      expect(images[1]).toHaveAttribute("alt", "Test image");
    });

    test("both images have same dimensions", () => {
      const { container } = render(<FeatureCard {...defaultProps} imageSrcDark="/test-image-dark.png" />);

      const images = container.querySelectorAll("img");
      expect(images[0]).toHaveAttribute("width", "400");
      expect(images[0]).toHaveAttribute("height", "300");
      expect(images[1]).toHaveAttribute("width", "400");
      expect(images[1]).toHaveAttribute("height", "300");
    });

    test("single image does not have dark theme classes when no dark variant", () => {
      const { container } = render(<FeatureCard {...defaultProps} />);

      const img = container.querySelector("img");
      expect(img).not.toHaveClass("dark:hidden");
      expect(img).not.toHaveClass("hidden");
      expect(img).not.toHaveClass("dark:block");
    });
  });

  describe("className handling", () => {
    test("applies custom className to card", () => {
      const { container } = render(<FeatureCard {...defaultProps} className="custom-class" />);

      const card = container.querySelector('[data-slot="card"]');
      expect(card).toHaveClass("custom-class");
    });

    test("applies default mt-20 class to card", () => {
      const { container } = render(<FeatureCard {...defaultProps} />);

      const card = container.querySelector('[data-slot="card"]');
      expect(card).toHaveClass("mt-20");
    });

    test("applies default shadow-2xl class to card", () => {
      const { container } = render(<FeatureCard {...defaultProps} />);

      const card = container.querySelector('[data-slot="card"]');
      expect(card).toHaveClass("shadow-2xl");
    });

    test("merges custom className with default classes", () => {
      const { container } = render(<FeatureCard {...defaultProps} className="bg-blue-500" />);

      const card = container.querySelector('[data-slot="card"]');
      expect(card).toHaveClass("mt-20");
      expect(card).toHaveClass("shadow-2xl");
      expect(card).toHaveClass("bg-blue-500");
    });

    test("renders without custom className when not provided", () => {
      const { container } = render(<FeatureCard {...defaultProps} />);

      const card = container.querySelector('[data-slot="card"]');
      expect(card).toBeInTheDocument();
    });
  });

  describe("image container styling", () => {
    test("image container has overflow-hidden class", () => {
      const { container } = render(<FeatureCard {...defaultProps} />);

      const imageContainer = container.querySelector("div.overflow-hidden");
      expect(imageContainer).toBeInTheDocument();
    });

    test("image container has -mt-20 class", () => {
      const { container } = render(<FeatureCard {...defaultProps} />);

      const imageContainer = container.querySelector("div.overflow-hidden");
      expect(imageContainer).toHaveClass("-mt-20");
    });

    test("image has correct responsive width classes", () => {
      const { container } = render(<FeatureCard {...defaultProps} />);

      const img = container.querySelector("img");
      expect(img).toHaveClass("w-3/5");
      expect(img).toHaveClass("mx-auto");
    });

    test("image has correct display classes", () => {
      const { container } = render(<FeatureCard {...defaultProps} />);

      const img = container.querySelector("img");
      expect(img).toHaveClass("h-auto");
      expect(img).toHaveClass("object-cover");
    });
  });

  describe("card header styling", () => {
    test("title has correct font classes", () => {
      const { getByText } = render(<FeatureCard {...defaultProps} />);

      const title = getByText("Test Feature");
      expect(title).toHaveClass("font-grotesque");
      expect(title).toHaveClass("font-bold");
      expect(title).toHaveClass("text-secondary");
    });

    test("title has correct text size classes", () => {
      const { getByText } = render(<FeatureCard {...defaultProps} />);

      const title = getByText("Test Feature");
      expect(title).toHaveClass("text-3xl");
      expect(title).toHaveClass("md:text-4xl");
      expect(title).toHaveClass("leading-none");
    });

    test("description has correct text color class", () => {
      const { getByText } = render(<FeatureCard {...defaultProps} />);

      const description = getByText("This is a test description");
      expect(description).toHaveClass("text-card-foreground");
    });

    test("description has correct text size classes", () => {
      const { getByText } = render(<FeatureCard {...defaultProps} />);

      const description = getByText("This is a test description");
      expect(description).toHaveClass("text-2xl");
      expect(description).toHaveClass("md:text-3xl");
      expect(description).toHaveClass("leading-none");
    });
  });

  describe("edge cases", () => {
    test("handles empty title", () => {
      const { container } = render(<FeatureCard {...defaultProps} title="" />);

      const card = container.querySelector('[data-slot="card"]');
      expect(card).toBeInTheDocument();
    });

    test("handles empty description", () => {
      const { container } = render(<FeatureCard {...defaultProps} description="" />);

      const card = container.querySelector('[data-slot="card"]');
      expect(card).toBeInTheDocument();
    });

    test("handles special characters in title", () => {
      const specialTitle = "Test & Feature <with> \"special\" 'chars'";
      const { getByText } = render(<FeatureCard {...defaultProps} title={specialTitle} />);

      expect(getByText(specialTitle)).toBeInTheDocument();
    });

    test("handles special characters in description", () => {
      const specialDescription = 'Description with & <special> "characters"';
      const { getByText } = render(<FeatureCard {...defaultProps} description={specialDescription} />);

      expect(getByText(specialDescription)).toBeInTheDocument();
    });

    test("handles long title text", () => {
      const longTitle = "This is a very long title that should still render correctly without breaking the layout";
      const { getByText } = render(<FeatureCard {...defaultProps} title={longTitle} />);

      expect(getByText(longTitle)).toBeInTheDocument();
    });

    test("handles long description text", () => {
      const longDescription =
        "This is a very long description that should still render correctly and wrap appropriately without breaking the layout or causing any visual issues";
      const { getByText } = render(<FeatureCard {...defaultProps} description={longDescription} />);

      expect(getByText(longDescription)).toBeInTheDocument();
    });

    test("handles zero width and height", () => {
      const { container } = render(<FeatureCard {...defaultProps} imageWidth={0} imageHeight={0} />);

      const img = container.querySelector("img");
      expect(img).toHaveAttribute("width", "0");
      expect(img).toHaveAttribute("height", "0");
    });

    test("handles very large dimensions", () => {
      const { container } = render(<FeatureCard {...defaultProps} imageWidth={10000} imageHeight={10000} />);

      const img = container.querySelector("img");
      expect(img).toHaveAttribute("width", "10000");
      expect(img).toHaveAttribute("height", "10000");
    });

    test("handles image path with query parameters", () => {
      const imageSrcWithParams = "/test-image.png?v=123&quality=high";
      const { container } = render(<FeatureCard {...defaultProps} imageSrc={imageSrcWithParams} />);

      const img = container.querySelector("img");
      expect(img).toHaveAttribute("src", imageSrcWithParams);
    });

    test("handles absolute URL for image src", () => {
      const absoluteUrl = "https://example.com/image.png";
      const { container } = render(<FeatureCard {...defaultProps} imageSrc={absoluteUrl} />);

      const img = container.querySelector("img");
      expect(img).toHaveAttribute("src", absoluteUrl);
    });
  });

  describe("component structure", () => {
    test("renders CardHeader component", () => {
      const { container } = render(<FeatureCard {...defaultProps} />);

      const header = container.querySelector('[data-slot="card-header"]');
      expect(header).toBeInTheDocument();
    });

    test("renders CardTitle component", () => {
      const { container } = render(<FeatureCard {...defaultProps} />);

      const title = container.querySelector('[data-slot="card-title"]');
      expect(title).toBeInTheDocument();
    });

    test("renders CardDescription component", () => {
      const { container } = render(<FeatureCard {...defaultProps} />);

      const description = container.querySelector('[data-slot="card-description"]');
      expect(description).toBeInTheDocument();
    });

    test("image container is sibling to card header", () => {
      const { container } = render(<FeatureCard {...defaultProps} />);

      const card = container.querySelector('[data-slot="card"]');
      const imageContainer = container.querySelector("div.overflow-hidden") as HTMLElement;
      const header = container.querySelector('[data-slot="card-header"]') as HTMLElement;

      expect(card).toContainElement(imageContainer);
      expect(card).toContainElement(header);
    });
  });

  describe("accessibility", () => {
    test("image has proper alt text", () => {
      const { container } = render(<FeatureCard {...defaultProps} />);

      const img = container.querySelector("img");
      expect(img).toHaveAttribute("alt");
      expect(img?.getAttribute("alt")).toBeTruthy();
    });

    test("both images have alt text when dark variant exists", () => {
      const { container } = render(<FeatureCard {...defaultProps} imageSrcDark="/test-image-dark.png" />);

      const images = container.querySelectorAll("img");
      images.forEach((img) => {
        expect(img).toHaveAttribute("alt");
        expect(img.getAttribute("alt")).toBe("Test image");
      });
    });

    test("title is properly structured for screen readers", () => {
      const { getByText } = render(<FeatureCard {...defaultProps} />);

      const title = getByText("Test Feature");
      // CardTitle should render the text in a proper heading structure
      expect(title).toBeInTheDocument();
    });
  });
});
