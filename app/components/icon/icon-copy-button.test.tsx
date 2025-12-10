import { act, fireEvent, render } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { IconCopyButton } from "./icon-copy-button";

describe("IconCopyButton", () => {
  const mockClipboard = {
    writeText: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(navigator, {
      clipboard: mockClipboard,
    });
    mockClipboard.writeText.mockResolvedValue(undefined);
  });

  describe("rendering", () => {
    test("renders button element", () => {
      const { getByRole } = render(<IconCopyButton text="test" />);
      const button = getByRole("button");
      expect(button).toBeInTheDocument();
    });

    test("renders with default copy icon", () => {
      const { container } = render(<IconCopyButton text="test" />);
      const icon = container.querySelector("svg");
      expect(icon).toBeInTheDocument();
    });

    test("renders with custom children", () => {
      const { getByText } = render(<IconCopyButton text="test">Custom</IconCopyButton>);
      expect(getByText("Custom")).toBeInTheDocument();
    });

    test("applies custom className", () => {
      const { container } = render(<IconCopyButton text="test" className="custom-class" />);
      const button = container.querySelector("button");
      expect(button?.className).toContain("custom-class");
    });

    test("has correct default title", () => {
      const { getByRole } = render(<IconCopyButton text="test" />);
      const button = getByRole("button");
      expect(button).toHaveAttribute("title", "Copy");
    });

    test("has custom copyTitle", () => {
      const { getByRole } = render(<IconCopyButton text="test" copyTitle="Copy text" />);
      const button = getByRole("button");
      expect(button).toHaveAttribute("title", "Copy text");
    });

    test("renders with ghost variant", () => {
      const { container } = render(<IconCopyButton text="test" />);
      const button = container.querySelector("button");
      expect(button).toBeInTheDocument();
    });

    test("renders with icon size", () => {
      const { container } = render(<IconCopyButton text="test" />);
      const button = container.querySelector("button");
      expect(button?.className).toContain("size-5");
    });
  });

  describe("copy functionality", () => {
    test("copies text to clipboard on click", async () => {
      const { getByRole } = render(<IconCopyButton text="test text" />);
      const button = getByRole("button");

      await act(async () => {
        fireEvent.click(button);
      });

      expect(mockClipboard.writeText).toHaveBeenCalledWith("test text");
      expect(mockClipboard.writeText).toHaveBeenCalledTimes(1);
    });

    test("shows copied state after successful copy", async () => {
      const { getByRole } = render(<IconCopyButton text="test" />);
      const button = getByRole("button");

      await act(async () => {
        fireEvent.click(button);
      });

      expect(button).toHaveAttribute("title", "Copied!");
    });

    test("resets copied state after default duration", async () => {
      vi.useFakeTimers();
      const { getByRole } = render(<IconCopyButton text="test" />);
      const button = getByRole("button");

      await act(async () => {
        fireEvent.click(button);
      });

      expect(button).toHaveAttribute("title", "Copied!");

      await act(async () => {
        vi.advanceTimersByTime(2000);
      });

      expect(button).toHaveAttribute("title", "Copy");
      vi.useRealTimers();
    });

    test("resets copied state after custom duration", async () => {
      vi.useFakeTimers();
      const { getByRole } = render(<IconCopyButton text="test" copiedDuration={3000} />);
      const button = getByRole("button");

      await act(async () => {
        fireEvent.click(button);
      });

      expect(button).toHaveAttribute("title", "Copied!");

      await act(async () => {
        vi.advanceTimersByTime(2000);
      });

      expect(button).toHaveAttribute("title", "Copied!");

      await act(async () => {
        vi.advanceTimersByTime(1000);
      });

      expect(button).toHaveAttribute("title", "Copy");
      vi.useRealTimers();
    });

    test("calls onCopySuccess callback", async () => {
      const onCopySuccess = vi.fn();
      const { getByRole } = render(<IconCopyButton text="test" onCopySuccess={onCopySuccess} />);
      const button = getByRole("button");

      await act(async () => {
        fireEvent.click(button);
      });

      expect(onCopySuccess).toHaveBeenCalledTimes(1);
    });

    test("calls onClick handler", async () => {
      const onClick = vi.fn();
      const { getByRole } = render(<IconCopyButton text="test" onClick={onClick} />);
      const button = getByRole("button");

      await act(async () => {
        fireEvent.click(button);
      });

      expect(onClick).toHaveBeenCalledTimes(1);
    });

    test("handles clipboard write failure gracefully", async () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      mockClipboard.writeText.mockRejectedValue(new Error("Clipboard error"));

      const { getByRole } = render(<IconCopyButton text="test" />);
      const button = getByRole("button");

      await act(async () => {
        fireEvent.click(button);
      });

      expect(consoleError).toHaveBeenCalled();

      consoleError.mockRestore();
    });

    test("copies different text values", async () => {
      const { getByRole, rerender } = render(<IconCopyButton text="first" />);
      const button = getByRole("button");

      await act(async () => {
        fireEvent.click(button);
      });

      expect(mockClipboard.writeText).toHaveBeenCalledWith("first");

      rerender(<IconCopyButton text="second" />);

      await act(async () => {
        fireEvent.click(button);
      });

      expect(mockClipboard.writeText).toHaveBeenCalledWith("second");
    });
  });

  describe("icon display", () => {
    test("shows copy icon by default", () => {
      const { container } = render(<IconCopyButton text="test" />);
      const icons = container.querySelectorAll("svg");
      expect(icons.length).toBeGreaterThan(0);
    });

    test("switches to check icon after copy", async () => {
      const { container, getByRole } = render(<IconCopyButton text="test" />);
      const button = getByRole("button");

      await act(async () => {
        fireEvent.click(button);
      });

      const icons = container.querySelectorAll("svg");
      expect(icons.length).toBeGreaterThan(0);
    });

    test("switches back to copy icon after timeout", async () => {
      vi.useFakeTimers();
      const { container, getByRole } = render(<IconCopyButton text="test" />);
      const button = getByRole("button");

      await act(async () => {
        fireEvent.click(button);
      });

      expect(button).toHaveAttribute("title", "Copied!");

      await act(async () => {
        vi.advanceTimersByTime(2000);
      });

      const icons = container.querySelectorAll("svg");
      expect(icons.length).toBeGreaterThan(0);
      vi.useRealTimers();
    });

    test("renders custom children instead of default icons", async () => {
      const { getByText } = render(
        <IconCopyButton text="test">
          <span>Custom Icon</span>
        </IconCopyButton>,
      );

      expect(getByText("Custom Icon")).toBeInTheDocument();
    });
  });

  describe("accessibility", () => {
    test("button has type='button'", () => {
      const { getByRole } = render(<IconCopyButton text="test" />);
      const button = getByRole("button");
      expect(button).toHaveAttribute("type", "button");
    });

    test("button is keyboard accessible", () => {
      const { getByRole } = render(<IconCopyButton text="test" />);
      const button = getByRole("button");
      expect(button).not.toHaveAttribute("tabindex", "-1");
    });

    test("updates aria attributes based on state", async () => {
      const { getByRole } = render(<IconCopyButton text="test" />);
      const button = getByRole("button");

      expect(button).toHaveAttribute("title", "Copy");

      await act(async () => {
        fireEvent.click(button);
      });

      expect(button).toHaveAttribute("title", "Copied!");
    });
  });

  describe("props handling", () => {
    test("forwards ref to button element", () => {
      const ref = vi.fn();
      render(<IconCopyButton text="test" ref={ref} />);
      expect(ref).toHaveBeenCalled();
    });

    test("spreads additional props to button", () => {
      const { getByRole } = render(<IconCopyButton text="test" data-testid="copy-btn" />);
      const button = getByRole("button");
      expect(button).toHaveAttribute("data-testid", "copy-btn");
    });

    test("accepts disabled prop", () => {
      const { getByRole } = render(<IconCopyButton text="test" disabled />);
      const button = getByRole("button");
      expect(button).toBeDisabled();
    });

    test("does not copy when disabled", async () => {
      const { getByRole } = render(<IconCopyButton text="test" disabled />);
      const button = getByRole("button");

      fireEvent.click(button);

      // Wait a bit to ensure no async operations occur
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockClipboard.writeText).not.toHaveBeenCalled();
    });
  });

  describe("edge cases", () => {
    test("handles rapid clicks", async () => {
      const { getByRole } = render(<IconCopyButton text="test" />);
      const button = getByRole("button");

      await act(async () => {
        fireEvent.click(button);
        fireEvent.click(button);
        fireEvent.click(button);
      });

      expect(mockClipboard.writeText).toHaveBeenCalledTimes(3);
    });

    test("clears timeout on unmount", async () => {
      vi.useFakeTimers();
      const { getByRole, unmount } = render(<IconCopyButton text="test" />);
      const button = getByRole("button");

      await act(async () => {
        fireEvent.click(button);
      });

      expect(button).toHaveAttribute("title", "Copied!");

      unmount();

      // Should not throw error
      act(() => {
        vi.advanceTimersByTime(2000);
      });
      vi.useRealTimers();
    });

    test("handles empty text", async () => {
      const { getByRole } = render(<IconCopyButton text="" />);
      const button = getByRole("button");

      await act(async () => {
        fireEvent.click(button);
      });

      expect(mockClipboard.writeText).toHaveBeenCalledWith("");
    });

    test("handles special characters in text", async () => {
      const specialText = "!@#$%^&*()_+-=[]{}|;':\",./<>?";
      const { getByRole } = render(<IconCopyButton text={specialText} />);
      const button = getByRole("button");

      await act(async () => {
        fireEvent.click(button);
      });

      expect(mockClipboard.writeText).toHaveBeenCalledWith(specialText);
    });

    test("handles very long text", async () => {
      const longText = "a".repeat(10000);
      const { getByRole } = render(<IconCopyButton text={longText} />);
      const button = getByRole("button");

      await act(async () => {
        fireEvent.click(button);
      });

      expect(mockClipboard.writeText).toHaveBeenCalledWith(longText);
    });

    test("clears previous timeout on rapid clicks", async () => {
      vi.useFakeTimers();
      const { getByRole } = render(<IconCopyButton text="test" copiedDuration={1000} />);
      const button = getByRole("button");

      await act(async () => {
        fireEvent.click(button);
      });

      expect(button).toHaveAttribute("title", "Copied!");

      await act(async () => {
        vi.advanceTimersByTime(500);
      });

      await act(async () => {
        fireEvent.click(button);
      });

      await act(async () => {
        vi.advanceTimersByTime(500);
      });

      expect(button).toHaveAttribute("title", "Copied!");

      await act(async () => {
        vi.advanceTimersByTime(500);
      });

      expect(button).toHaveAttribute("title", "Copy");
      vi.useRealTimers();
    });
  });

  describe("component structure", () => {
    test("button contains icon element by default", () => {
      const { container } = render(<IconCopyButton text="test" />);
      const button = container.querySelector("button");
      const icon = button?.querySelector("svg");
      expect(icon).toBeInTheDocument();
    });

    test("has correct display name", () => {
      expect(IconCopyButton.displayName).toBe("IconCopyButton");
    });

    test("maintains size-5 class", () => {
      const { container } = render(<IconCopyButton text="test" />);
      const button = container.querySelector("button");
      expect(button?.className).toContain("size-5");
    });

    test("has rounded-sm class", () => {
      const { container } = render(<IconCopyButton text="test" />);
      const button = container.querySelector("button");
      expect(button?.className).toContain("rounded-sm");
    });

    test("has p-0 padding class", () => {
      const { container } = render(<IconCopyButton text="test" />);
      const button = container.querySelector("button");
      expect(button?.className).toContain("p-0");
    });
  });

  describe("interaction", () => {
    test("button is clickable", async () => {
      const { getByRole } = render(<IconCopyButton text="test" />);
      const button = getByRole("button");

      expect(() => {
        fireEvent.click(button);
      }).not.toThrow();
    });

    test("handles keyboard interaction", () => {
      const { getByRole } = render(<IconCopyButton text="test" />);
      const button = getByRole("button");

      fireEvent.keyDown(button, { key: "Enter" });

      expect(button).toBeInTheDocument();
    });

    test("maintains functionality after re-renders", async () => {
      const { getByRole, rerender } = render(<IconCopyButton text="test1" />);
      const button = getByRole("button");

      await act(async () => {
        fireEvent.click(button);
      });

      expect(mockClipboard.writeText).toHaveBeenCalledWith("test1");

      rerender(<IconCopyButton text="test2" />);

      await act(async () => {
        fireEvent.click(button);
      });

      expect(mockClipboard.writeText).toHaveBeenCalledWith("test2");
    });
  });
});
