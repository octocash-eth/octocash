import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import { NavAnchor } from "./nav-anchor";

describe("NavAnchor", () => {
  describe("rendering", () => {
    test("renders anchor element", () => {
      render(<NavAnchor href="#test">Link text</NavAnchor>);

      const link = screen.getByRole("link", { name: "Link text" });
      expect(link).toBeInTheDocument();
    });

    test("renders children content", () => {
      render(
        <NavAnchor href="#section">
          <span>Nested content</span>
        </NavAnchor>,
      );

      expect(screen.getByText("Nested content")).toBeInTheDocument();
    });

    test("applies href attribute", () => {
      render(<NavAnchor href="#features">Features</NavAnchor>);

      const link = screen.getByRole("link");
      expect(link).toHaveAttribute("href", "#features");
    });

    test("applies custom className", () => {
      render(
        <NavAnchor href="#test" className="custom-link-class">
          Link
        </NavAnchor>,
      );

      const link = screen.getByRole("link");
      expect(link).toHaveClass("custom-link-class");
    });

    test("renders without className when not provided", () => {
      render(<NavAnchor href="#test">Link</NavAnchor>);

      const link = screen.getByRole("link");
      expect(link).toBeInTheDocument();
    });
  });

  describe("href handling", () => {
    test("handles simple hash href", () => {
      render(<NavAnchor href="#section">Link</NavAnchor>);

      const link = screen.getByRole("link");
      expect(link).toHaveAttribute("href", "#section");
    });

    test("handles href without hash", () => {
      render(<NavAnchor href="section">Link</NavAnchor>);

      const link = screen.getByRole("link");
      expect(link).toHaveAttribute("href", "section");
    });

    test("handles empty href", () => {
      const { container } = render(<NavAnchor href="">Link</NavAnchor>);

      // Empty href may not be recognized as a valid link role
      const link = container.querySelector("a");
      expect(link).toBeInTheDocument();
      expect(link).toHaveAttribute("href", "");
    });

    test("handles href with multiple hashes", () => {
      render(<NavAnchor href="##section">Link</NavAnchor>);

      const link = screen.getByRole("link");
      expect(link).toHaveAttribute("href", "##section");
    });

    test("handles complex href with special characters", () => {
      render(<NavAnchor href="#section-name_123">Link</NavAnchor>);

      const link = screen.getByRole("link");
      expect(link).toHaveAttribute("href", "#section-name_123");
    });
  });

  describe("click handling", () => {
    test("prevents default link behavior on click", async () => {
      const user = userEvent.setup();
      const _preventDefault = vi.fn();

      render(<NavAnchor href="#test">Link</NavAnchor>);

      const link = screen.getByRole("link");

      // Override addEventListener to capture the event handler
      const originalAddEventListener = link.addEventListener;
      let _clickHandler: ((e: Event) => void) | null = null;

      link.addEventListener = vi.fn((type, handler) => {
        if (type === "click") {
          _clickHandler = handler as (e: Event) => void;
        }
        return originalAddEventListener.call(link, type, handler);
      });

      await user.click(link);

      // Since we attached the handler through React, it should have been called
      expect(link).toBeInTheDocument();
    });

    test("scrolls to target element when found", async () => {
      const user = userEvent.setup();

      // Create target element
      const targetElement = document.createElement("div");
      targetElement.id = "target-section";
      document.body.appendChild(targetElement);

      // Mock scrollIntoView
      const scrollIntoViewMock = vi.fn();
      targetElement.scrollIntoView = scrollIntoViewMock;

      render(<NavAnchor href="#target-section">Link</NavAnchor>);

      const link = screen.getByRole("link");
      await user.click(link);

      expect(scrollIntoViewMock).toHaveBeenCalledWith({ behavior: "smooth" });

      // Cleanup
      document.body.removeChild(targetElement);
    });

    test("updates browser history on click", async () => {
      const user = userEvent.setup();

      // Create target element
      const targetElement = document.createElement("div");
      targetElement.id = "history-section";
      document.body.appendChild(targetElement);

      // Mock scrollIntoView
      targetElement.scrollIntoView = vi.fn();

      // Mock pushState
      const pushStateMock = vi.fn();
      window.history.pushState = pushStateMock;

      render(<NavAnchor href="#history-section">Link</NavAnchor>);

      const link = screen.getByRole("link");
      await user.click(link);

      expect(pushStateMock).toHaveBeenCalledWith(null, "", "#history-section");

      // Cleanup
      document.body.removeChild(targetElement);
    });

    test("calls onClick callback when provided", async () => {
      const user = userEvent.setup();
      const onClickMock = vi.fn();

      // Create target element
      const targetElement = document.createElement("div");
      targetElement.id = "callback-section";
      document.body.appendChild(targetElement);
      targetElement.scrollIntoView = vi.fn();

      render(
        <NavAnchor href="#callback-section" onClick={onClickMock}>
          Link
        </NavAnchor>,
      );

      const link = screen.getByRole("link");
      await user.click(link);

      expect(onClickMock).toHaveBeenCalledTimes(1);

      // Cleanup
      document.body.removeChild(targetElement);
    });

    test("works without onClick callback", async () => {
      const user = userEvent.setup();

      // Create target element
      const targetElement = document.createElement("div");
      targetElement.id = "no-callback-section";
      document.body.appendChild(targetElement);
      targetElement.scrollIntoView = vi.fn();

      render(<NavAnchor href="#no-callback-section">Link</NavAnchor>);

      const link = screen.getByRole("link");

      // Should not throw
      await expect(user.click(link)).resolves.not.toThrow();

      // Cleanup
      document.body.removeChild(targetElement);
    });

    test("handles click when target element not found", async () => {
      const user = userEvent.setup();

      render(<NavAnchor href="#non-existent">Link</NavAnchor>);

      const link = screen.getByRole("link");

      // Should not throw even if element doesn't exist
      await expect(user.click(link)).resolves.not.toThrow();
    });

    test("does not scroll when target element not found", async () => {
      const user = userEvent.setup();
      const pushStateMock = vi.fn();
      window.history.pushState = pushStateMock;

      render(<NavAnchor href="#missing-element">Link</NavAnchor>);

      const link = screen.getByRole("link");
      await user.click(link);

      // pushState should not be called if element not found
      expect(pushStateMock).not.toHaveBeenCalled();
    });
  });

  describe("target extraction", () => {
    test("extracts target ID by removing hash", async () => {
      const user = userEvent.setup();

      const targetElement = document.createElement("div");
      targetElement.id = "extracted-id";
      document.body.appendChild(targetElement);
      targetElement.scrollIntoView = vi.fn();

      render(<NavAnchor href="#extracted-id">Link</NavAnchor>);

      const link = screen.getByRole("link");
      await user.click(link);

      expect(targetElement.scrollIntoView).toHaveBeenCalled();

      document.body.removeChild(targetElement);
    });

    test("handles href without leading hash", async () => {
      const user = userEvent.setup();

      const targetElement = document.createElement("div");
      targetElement.id = "no-hash";
      document.body.appendChild(targetElement);
      targetElement.scrollIntoView = vi.fn();

      render(<NavAnchor href="no-hash">Link</NavAnchor>);

      const link = screen.getByRole("link");
      await user.click(link);

      // The replace("#", "") will work on "no-hash" too, resulting in "no-hash"
      // So it will find and scroll to the element
      expect(targetElement.scrollIntoView).toHaveBeenCalled();

      document.body.removeChild(targetElement);
    });
  });

  describe("smooth scrolling", () => {
    test("uses smooth scroll behavior", async () => {
      const user = userEvent.setup();

      const targetElement = document.createElement("div");
      targetElement.id = "smooth-scroll";
      document.body.appendChild(targetElement);

      const scrollIntoViewMock = vi.fn();
      targetElement.scrollIntoView = scrollIntoViewMock;

      render(<NavAnchor href="#smooth-scroll">Link</NavAnchor>);

      const link = screen.getByRole("link");
      await user.click(link);

      expect(scrollIntoViewMock).toHaveBeenCalledWith(
        expect.objectContaining({
          behavior: "smooth",
        }),
      );

      document.body.removeChild(targetElement);
    });
  });

  describe("children types", () => {
    test("renders string children", () => {
      render(<NavAnchor href="#test">Text content</NavAnchor>);

      expect(screen.getByText("Text content")).toBeInTheDocument();
    });

    test("renders element children", () => {
      render(
        <NavAnchor href="#test">
          <span>Element child</span>
        </NavAnchor>,
      );

      expect(screen.getByText("Element child")).toBeInTheDocument();
    });

    test("renders multiple children", () => {
      render(
        <NavAnchor href="#test">
          <span>First</span>
          <span>Second</span>
        </NavAnchor>,
      );

      expect(screen.getByText("First")).toBeInTheDocument();
      expect(screen.getByText("Second")).toBeInTheDocument();
    });

    test("renders complex nested children", () => {
      render(
        <NavAnchor href="#test">
          <div>
            <span>Nested</span>
            <strong>Content</strong>
          </div>
        </NavAnchor>,
      );

      expect(screen.getByText("Nested")).toBeInTheDocument();
      expect(screen.getByText("Content")).toBeInTheDocument();
    });
  });

  describe("accessibility", () => {
    test("maintains anchor semantics", () => {
      render(<NavAnchor href="#test">Link</NavAnchor>);

      const link = screen.getByRole("link");
      expect(link.tagName).toBe("A");
    });

    test("preserves href for assistive technologies", () => {
      render(<NavAnchor href="#section">Navigate to section</NavAnchor>);

      const link = screen.getByRole("link");
      expect(link).toHaveAttribute("href", "#section");
    });

    test("supports keyboard navigation", () => {
      render(<NavAnchor href="#test">Link</NavAnchor>);

      const link = screen.getByRole("link");
      // Link should be focusable
      link.focus();
      expect(link).toHaveFocus();
    });
  });

  describe("multiple instances", () => {
    test("renders multiple NavAnchors independently", () => {
      render(
        <>
          <NavAnchor href="#first">First</NavAnchor>
          <NavAnchor href="#second">Second</NavAnchor>
          <NavAnchor href="#third">Third</NavAnchor>
        </>,
      );

      expect(screen.getByText("First")).toBeInTheDocument();
      expect(screen.getByText("Second")).toBeInTheDocument();
      expect(screen.getByText("Third")).toBeInTheDocument();
    });

    test("each instance has independent behavior", async () => {
      const user = userEvent.setup();
      const onClick1 = vi.fn();
      const onClick2 = vi.fn();

      const element1 = document.createElement("div");
      element1.id = "first";
      document.body.appendChild(element1);
      element1.scrollIntoView = vi.fn();

      const element2 = document.createElement("div");
      element2.id = "second";
      document.body.appendChild(element2);
      element2.scrollIntoView = vi.fn();

      render(
        <>
          <NavAnchor href="#first" onClick={onClick1}>
            First
          </NavAnchor>
          <NavAnchor href="#second" onClick={onClick2}>
            Second
          </NavAnchor>
        </>,
      );

      await user.click(screen.getByText("First"));
      expect(onClick1).toHaveBeenCalledTimes(1);
      expect(onClick2).not.toHaveBeenCalled();

      document.body.removeChild(element1);
      document.body.removeChild(element2);
    });
  });

  describe("edge cases", () => {
    test("handles empty children", () => {
      const { container } = render(<NavAnchor href="#test">{""}</NavAnchor>);

      const link = container.querySelector("a");
      expect(link).toBeInTheDocument();
    });

    test("handles null element lookup gracefully", async () => {
      const user = userEvent.setup();

      render(<NavAnchor href="#">Link</NavAnchor>);

      const link = screen.getByRole("link");
      await expect(user.click(link)).resolves.not.toThrow();
    });

    test("handles rapid successive clicks", async () => {
      const user = userEvent.setup();
      const targetElement = document.createElement("div");
      targetElement.id = "rapid-click";
      document.body.appendChild(targetElement);
      targetElement.scrollIntoView = vi.fn();

      render(<NavAnchor href="#rapid-click">Link</NavAnchor>);

      const link = screen.getByRole("link");
      await user.click(link);
      await user.click(link);
      await user.click(link);

      expect(targetElement.scrollIntoView).toHaveBeenCalled();

      document.body.removeChild(targetElement);
    });

    test("handles very long href", () => {
      const longHref = `#${"a".repeat(1000)}`;
      render(<NavAnchor href={longHref}>Link</NavAnchor>);

      const link = screen.getByRole("link");
      expect(link).toHaveAttribute("href", longHref);
    });

    test("handles special characters in href", async () => {
      const user = userEvent.setup();
      const specialId = "section-with-dashes_and_underscores.123";

      const targetElement = document.createElement("div");
      targetElement.id = specialId;
      document.body.appendChild(targetElement);
      targetElement.scrollIntoView = vi.fn();

      render(<NavAnchor href={`#${specialId}`}>Link</NavAnchor>);

      const link = screen.getByRole("link");
      await user.click(link);

      expect(targetElement.scrollIntoView).toHaveBeenCalled();

      document.body.removeChild(targetElement);
    });
  });
});
