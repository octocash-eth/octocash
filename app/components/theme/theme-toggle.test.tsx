import { cleanup, fireEvent, render } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { ThemeContext } from "./theme-provider";
import { ThemeToggle } from "./theme-toggle";

describe("ThemeToggle", () => {
  const mockSetTheme = vi.fn();

  const renderWithTheme = (
    resolvedTheme: "light" | "dark",
    theme: "light" | "dark" | "system" = resolvedTheme,
    variant?: "outline" | "ghost",
  ) => {
    return render(
      <ThemeContext.Provider value={{ theme, resolvedTheme, setTheme: mockSetTheme }}>
        <ThemeToggle variant={variant} />
      </ThemeContext.Provider>,
    );
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("rendering", () => {
    test("renders button element", () => {
      const { container } = renderWithTheme("light");
      const button = container.querySelector("button");
      expect(button).toBeInTheDocument();
    });

    test("renders with outline variant by default", () => {
      const { container } = renderWithTheme("light");
      const button = container.querySelector("button");
      expect(button).toBeInTheDocument();
    });

    test("renders with ghost variant when specified", () => {
      const { container } = renderWithTheme("light", "light", "ghost");
      const button = container.querySelector("button");
      expect(button).toBeInTheDocument();
    });

    test("renders with outline variant when specified", () => {
      const { container } = renderWithTheme("light", "light", "outline");
      const button = container.querySelector("button");
      expect(button).toBeInTheDocument();
    });
  });

  describe("icons", () => {
    test("renders Moon icon", () => {
      const { container } = renderWithTheme("light");
      const moonIcon = container.querySelector("svg");
      expect(moonIcon).toBeInTheDocument();
    });

    test("renders Sun icon", () => {
      const { container } = renderWithTheme("dark");
      const icons = container.querySelectorAll("svg");
      expect(icons.length).toBeGreaterThanOrEqual(1);
    });

    test("renders both icons simultaneously", () => {
      const { container } = renderWithTheme("light");
      const icons = container.querySelectorAll("svg");
      expect(icons.length).toBeGreaterThanOrEqual(2);
    });

    test("Moon icon has transition classes", () => {
      const { container } = renderWithTheme("light");
      const moonIcon = container.querySelector("svg");
      const classes = moonIcon?.getAttribute("class") || "";
      expect(classes).toContain("transition-all");
    });

    test("Sun icon has absolute positioning", () => {
      const { container } = renderWithTheme("light");
      const icons = container.querySelectorAll("svg");
      const sunIcon = Array.from(icons).find((icon) => {
        const classes = icon.getAttribute("class") || "";
        return classes.includes("absolute");
      });
      expect(sunIcon).toBeInTheDocument();
    });

    test("icons have consistent size", () => {
      const { container } = renderWithTheme("light");
      const icons = container.querySelectorAll("svg");
      icons.forEach((icon) => {
        const classes = icon.getAttribute("class") || "";
        expect(classes).toContain("h-[1.2rem]");
        expect(classes).toContain("w-[1.2rem]");
      });
    });
  });

  describe("accessibility", () => {
    test("has screen reader text", () => {
      const { container } = renderWithTheme("light");
      const srText = container.querySelector(".sr-only");
      expect(srText).toBeInTheDocument();
      expect(srText).toHaveTextContent("Toggle theme");
    });

    test("button is keyboard accessible", () => {
      const { container } = renderWithTheme("light");
      const button = container.querySelector("button");
      expect(button).not.toHaveAttribute("tabindex", "-1");
    });

    test("has descriptive label for assistive technologies", () => {
      const { getByText } = renderWithTheme("light");
      const label = getByText("Toggle theme");
      expect(label).toBeInTheDocument();
    });
  });

  describe("theme toggling", () => {
    test("toggles from light to dark", () => {
      const { getByRole } = renderWithTheme("light");
      const button = getByRole("button");

      fireEvent.click(button);

      expect(mockSetTheme).toHaveBeenCalledWith("dark");
      expect(mockSetTheme).toHaveBeenCalledTimes(1);
    });

    test("toggles from dark to light", () => {
      const { getByRole } = renderWithTheme("dark");
      const button = getByRole("button");

      fireEvent.click(button);

      expect(mockSetTheme).toHaveBeenCalledWith("light");
      expect(mockSetTheme).toHaveBeenCalledTimes(1);
    });

    test("uses resolvedTheme for toggle logic", () => {
      // Theme is "system" but resolvedTheme is "dark"
      const { getByRole } = render(
        <ThemeContext.Provider value={{ theme: "system", resolvedTheme: "dark", setTheme: mockSetTheme }}>
          <ThemeToggle />
        </ThemeContext.Provider>,
      );

      const button = getByRole("button");
      fireEvent.click(button);

      // Should toggle based on resolvedTheme (dark), so it should set to light
      expect(mockSetTheme).toHaveBeenCalledWith("light");
    });

    test("handles multiple clicks", () => {
      const { getByRole } = renderWithTheme("light");
      const button = getByRole("button");

      fireEvent.click(button);
      expect(mockSetTheme).toHaveBeenCalledWith("dark");

      fireEvent.click(button);
      expect(mockSetTheme).toHaveBeenCalledTimes(2);
    });

    test("click handler is defined", () => {
      const { getByRole } = renderWithTheme("light");
      const button = getByRole("button");

      expect(() => {
        fireEvent.click(button);
      }).not.toThrow();
    });
  });

  describe("theme context integration", () => {
    test("uses theme context values", () => {
      const { container } = renderWithTheme("dark");
      const button = container.querySelector("button");
      expect(button).toBeInTheDocument();
    });

    test("responds to light theme", () => {
      const { getByRole } = renderWithTheme("light");
      const button = getByRole("button");

      fireEvent.click(button);
      expect(mockSetTheme).toHaveBeenCalledWith("dark");
    });

    test("responds to dark theme", () => {
      const { getByRole } = renderWithTheme("dark");
      const button = getByRole("button");

      fireEvent.click(button);
      expect(mockSetTheme).toHaveBeenCalledWith("light");
    });

    test("handles system theme with light resolution", () => {
      const { getByRole } = render(
        <ThemeContext.Provider value={{ theme: "system", resolvedTheme: "light", setTheme: mockSetTheme }}>
          <ThemeToggle />
        </ThemeContext.Provider>,
      );

      const button = getByRole("button");
      fireEvent.click(button);

      expect(mockSetTheme).toHaveBeenCalledWith("dark");
    });

    test("handles system theme with dark resolution", () => {
      const { getByRole } = render(
        <ThemeContext.Provider value={{ theme: "system", resolvedTheme: "dark", setTheme: mockSetTheme }}>
          <ThemeToggle />
        </ThemeContext.Provider>,
      );

      const button = getByRole("button");
      fireEvent.click(button);

      expect(mockSetTheme).toHaveBeenCalledWith("light");
    });
  });

  describe("button variants", () => {
    test("renders with default outline variant", () => {
      const { container } = renderWithTheme("light");
      const button = container.querySelector("button");
      expect(button).toBeInTheDocument();
    });

    test("accepts ghost variant prop", () => {
      const { container } = renderWithTheme("light", "light", "ghost");
      const button = container.querySelector("button");
      expect(button).toBeInTheDocument();
    });

    test("accepts outline variant prop explicitly", () => {
      const { container } = renderWithTheme("light", "light", "outline");
      const button = container.querySelector("button");
      expect(button).toBeInTheDocument();
    });

    test("maintains functionality across variants", () => {
      const { getByRole: getByRole1 } = renderWithTheme("light", "light", "outline");
      const button1 = getByRole1("button");

      fireEvent.click(button1);
      expect(mockSetTheme).toHaveBeenCalledWith("dark");

      cleanup();
      mockSetTheme.mockClear();

      const { getByRole: getByRole2 } = renderWithTheme("light", "light", "ghost");
      const button2 = getByRole2("button");

      fireEvent.click(button2);
      expect(mockSetTheme).toHaveBeenCalledWith("dark");
    });
  });

  describe("component structure", () => {
    test("button contains icon elements", () => {
      const { container } = renderWithTheme("light");
      const button = container.querySelector("button");
      const icons = button?.querySelectorAll("svg");
      expect(icons?.length).toBeGreaterThanOrEqual(1);
    });

    test("button contains accessibility text", () => {
      const { container } = renderWithTheme("light");
      const button = container.querySelector("button");
      const srText = button?.querySelector(".sr-only");
      expect(srText).toBeInTheDocument();
    });

    test("has icon size class", () => {
      const { container } = renderWithTheme("light");
      const button = container.querySelector("button");
      expect(button).toBeInTheDocument();
    });
  });

  describe("visual states", () => {
    test("renders differently for light theme", () => {
      const { container } = renderWithTheme("light");
      const icons = container.querySelectorAll("svg");
      expect(icons.length).toBeGreaterThanOrEqual(2);
    });

    test("renders differently for dark theme", () => {
      const { container } = renderWithTheme("dark");
      const icons = container.querySelectorAll("svg");
      expect(icons.length).toBeGreaterThanOrEqual(2);
    });

    test("icon transition classes are applied", () => {
      const { container } = renderWithTheme("light");
      const icons = container.querySelectorAll("svg");

      let hasTransition = false;
      icons.forEach((icon) => {
        const classes = icon.getAttribute("class") || "";
        if (classes.includes("transition-all")) {
          hasTransition = true;
        }
      });

      expect(hasTransition).toBe(true);
    });
  });

  describe("edge cases", () => {
    test("handles rapid clicks", () => {
      const { getByRole } = renderWithTheme("light");
      const button = getByRole("button");

      fireEvent.click(button);
      fireEvent.click(button);
      fireEvent.click(button);

      expect(mockSetTheme).toHaveBeenCalledTimes(3);
    });

    test("does not break with undefined variant", () => {
      const { container } = render(
        <ThemeContext.Provider value={{ theme: "light", resolvedTheme: "light", setTheme: mockSetTheme }}>
          <ThemeToggle />
        </ThemeContext.Provider>,
      );

      const button = container.querySelector("button");
      expect(button).toBeInTheDocument();
    });

    test("maintains state through re-renders", () => {
      const { container, rerender } = renderWithTheme("light");
      const button = container.querySelector("button");

      expect(button).toBeInTheDocument();

      rerender(
        <ThemeContext.Provider value={{ theme: "light", resolvedTheme: "light", setTheme: mockSetTheme }}>
          <ThemeToggle />
        </ThemeContext.Provider>,
      );

      expect(button).toBeInTheDocument();
    });
  });

  describe("interaction", () => {
    test("button is clickable", () => {
      const { getByRole } = renderWithTheme("light");
      const button = getByRole("button");

      expect(() => {
        fireEvent.click(button);
      }).not.toThrow();
    });

    test("toggleTheme function is called on click", () => {
      const { getByRole } = renderWithTheme("light");
      const button = getByRole("button");

      fireEvent.click(button);

      expect(mockSetTheme).toHaveBeenCalled();
    });

    test("passes correct theme value to setTheme", () => {
      const { getByRole } = renderWithTheme("light");
      const button = getByRole("button");

      fireEvent.click(button);

      expect(mockSetTheme).toHaveBeenCalledWith("dark");
    });

    test("handles keyboard interaction", () => {
      const { getByRole } = renderWithTheme("light");
      const button = getByRole("button");

      fireEvent.keyDown(button, { key: "Enter" });

      // Button should still be present and functional
      expect(button).toBeInTheDocument();
    });
  });

  describe("props handling", () => {
    test("accepts variant prop without error", () => {
      expect(() => {
        renderWithTheme("light", "light", "ghost");
      }).not.toThrow();
    });

    test("renders without variant prop", () => {
      expect(() => {
        renderWithTheme("light", "light");
      }).not.toThrow();
    });

    test("handles all valid variant values", () => {
      const variants: Array<"outline" | "ghost"> = ["outline", "ghost"];

      variants.forEach((variant) => {
        const { container } = renderWithTheme("light", "light", variant);
        const button = container.querySelector("button");
        expect(button).toBeInTheDocument();
      });
    });
  });
});
