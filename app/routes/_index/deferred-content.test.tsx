import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { DeferredContent } from "./deferred-content";

describe("DeferredContent", () => {
  describe("rendering", () => {
    test("renders children correctly", () => {
      render(
        <DeferredContent>
          <div data-testid="test-child">Test Content</div>
        </DeferredContent>,
      );

      expect(screen.getByTestId("test-child")).toBeInTheDocument();
      expect(screen.getByText("Test Content")).toBeInTheDocument();
    });

    test("renders multiple children", () => {
      render(
        <DeferredContent>
          <div data-testid="child-1">First Child</div>
          <div data-testid="child-2">Second Child</div>
          <div data-testid="child-3">Third Child</div>
        </DeferredContent>,
      );

      expect(screen.getByTestId("child-1")).toBeInTheDocument();
      expect(screen.getByTestId("child-2")).toBeInTheDocument();
      expect(screen.getByTestId("child-3")).toBeInTheDocument();
    });

    test("renders text children", () => {
      render(<DeferredContent>Plain text content</DeferredContent>);

      expect(screen.getByText("Plain text content")).toBeInTheDocument();
    });

    test("renders complex nested children", () => {
      render(
        <DeferredContent>
          <section>
            <header>
              <h1>Title</h1>
            </header>
            <article>
              <p>Paragraph content</p>
            </article>
          </section>
        </DeferredContent>,
      );

      expect(screen.getByText("Title")).toBeInTheDocument();
      expect(screen.getByText("Paragraph content")).toBeInTheDocument();
    });
  });

  describe("wrapper div structure", () => {
    test("wraps children in a div element", () => {
      const { container } = render(
        <DeferredContent>
          <div data-testid="test-child">Test</div>
        </DeferredContent>,
      );

      const wrapperDiv = container.firstChild as HTMLElement;
      expect(wrapperDiv).toBeInstanceOf(HTMLDivElement);
      expect(wrapperDiv.tagName).toBe("DIV");
    });

    test("children are direct descendants of wrapper div", () => {
      const { container } = render(
        <DeferredContent>
          <div data-testid="test-child">Test</div>
        </DeferredContent>,
      );

      const wrapperDiv = container.firstChild as HTMLElement;
      const childElement = screen.getByTestId("test-child");
      expect(wrapperDiv).toContainElement(childElement);
    });
  });

  describe("CSS styles", () => {
    test("applies content-visibility: auto style", () => {
      const { container } = render(
        <DeferredContent>
          <div>Test</div>
        </DeferredContent>,
      );

      const wrapperDiv = container.firstChild as HTMLElement;
      expect(wrapperDiv.style.contentVisibility).toBe("auto");
    });

    test("applies containIntrinsicSize style", () => {
      const { container } = render(
        <DeferredContent>
          <div>Test</div>
        </DeferredContent>,
      );

      const wrapperDiv = container.firstChild as HTMLElement;
      expect(wrapperDiv.style.containIntrinsicSize).toBe("auto 2000px");
    });

    test("has both required inline styles", () => {
      const { container } = render(
        <DeferredContent>
          <div>Test</div>
        </DeferredContent>,
      );

      const wrapperDiv = container.firstChild as HTMLElement;
      expect(wrapperDiv.style.contentVisibility).toBe("auto");
      expect(wrapperDiv.style.containIntrinsicSize).toBe("auto 2000px");
    });
  });

  describe("DOM structure", () => {
    test("maintains correct DOM hierarchy", () => {
      const { container } = render(
        <DeferredContent>
          <div data-testid="level-1">
            <div data-testid="level-2">
              <div data-testid="level-3">Deep content</div>
            </div>
          </div>
        </DeferredContent>,
      );

      const level1 = screen.getByTestId("level-1");
      const level2 = screen.getByTestId("level-2");
      const level3 = screen.getByTestId("level-3");

      expect(container.firstChild).toContainElement(level1);
      expect(level1).toContainElement(level2);
      expect(level2).toContainElement(level3);
    });

    test("preserves child element attributes", () => {
      render(
        <DeferredContent>
          <div data-testid="test-child" className="custom-class" id="custom-id" title="Custom Label">
            Test
          </div>
        </DeferredContent>,
      );

      const child = screen.getByTestId("test-child");
      expect(child).toHaveClass("custom-class");
      expect(child).toHaveAttribute("id", "custom-id");
      expect(child).toHaveAttribute("title", "Custom Label");
    });
  });

  describe("component behavior", () => {
    test("renders without crashing with empty content", () => {
      const { container } = render(<DeferredContent>{null}</DeferredContent>);

      expect(container.firstChild).toBeInTheDocument();
    });

    test("handles fragments as children", () => {
      render(
        <DeferredContent>
          <div data-testid="fragment-child-1">First</div>
          <div data-testid="fragment-child-2">Second</div>
        </DeferredContent>,
      );

      expect(screen.getByTestId("fragment-child-1")).toBeInTheDocument();
      expect(screen.getByTestId("fragment-child-2")).toBeInTheDocument();
    });

    test("renders components as children", () => {
      const ChildComponent = () => <div data-testid="component-child">Component Content</div>;

      render(
        <DeferredContent>
          <ChildComponent />
        </DeferredContent>,
      );

      expect(screen.getByTestId("component-child")).toBeInTheDocument();
      expect(screen.getByText("Component Content")).toBeInTheDocument();
    });
  });

  describe("performance optimization", () => {
    test("content is in the DOM (for SEO)", () => {
      render(
        <DeferredContent>
          <article>
            <h1>SEO Content</h1>
            <p>This content should be in the DOM for search engines.</p>
          </article>
        </DeferredContent>,
      );

      // Content should be in the document despite deferred rendering
      expect(screen.getByRole("heading", { name: "SEO Content" })).toBeInTheDocument();
      expect(screen.getByText("This content should be in the DOM for search engines.")).toBeInTheDocument();
    });

    test("wrapper div has performance optimization styles", () => {
      const { container } = render(
        <DeferredContent>
          <div>Optimized content</div>
        </DeferredContent>,
      );

      const wrapperDiv = container.firstChild as HTMLElement;
      // The wrapper should have the optimization styles
      expect(wrapperDiv.style.contentVisibility).toBe("auto");
      // containIntrinsicSize provides estimated dimensions for off-screen content
      expect(wrapperDiv.style.containIntrinsicSize).toBe("auto 2000px");
    });
  });

  describe("multiple instances", () => {
    test("renders multiple DeferredContent components independently", () => {
      render(
        <>
          <DeferredContent>
            <div data-testid="instance-1">First Instance</div>
          </DeferredContent>
          <DeferredContent>
            <div data-testid="instance-2">Second Instance</div>
          </DeferredContent>
          <DeferredContent>
            <div data-testid="instance-3">Third Instance</div>
          </DeferredContent>
        </>,
      );

      expect(screen.getByTestId("instance-1")).toBeInTheDocument();
      expect(screen.getByTestId("instance-2")).toBeInTheDocument();
      expect(screen.getByTestId("instance-3")).toBeInTheDocument();
    });

    test("each instance has independent styling", () => {
      const { container } = render(
        <>
          <DeferredContent>
            <div>First</div>
          </DeferredContent>
          <DeferredContent>
            <div>Second</div>
          </DeferredContent>
        </>,
      );

      // Get all direct children of the container (which are the wrapper divs)
      const wrapperDivs = Array.from(container.children) as HTMLElement[];
      expect(wrapperDivs.length).toBe(2);

      wrapperDivs.forEach((wrapperDiv) => {
        expect(wrapperDiv.style.contentVisibility).toBe("auto");
        expect(wrapperDiv.style.containIntrinsicSize).toBe("auto 2000px");
      });
    });
  });
});
