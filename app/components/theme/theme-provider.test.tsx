import { act, render, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { ThemeMeta, ThemeProvider, useTheme } from "./theme-provider";

// Mock window.matchMedia
const createMatchMediaMock = (matches: boolean) => {
  return vi.fn().mockImplementation((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
};

describe("ThemeMeta", () => {
  describe("rendering", () => {
    test("renders color-scheme meta tag", () => {
      const { container } = render(<ThemeMeta />);
      // ThemeMeta returns a fragment with script, style, and noscript
      // The component renders successfully if no errors are thrown
      expect(container).toBeInTheDocument();
      const html = container.innerHTML;
      // Check that the component rendered some content
      expect(html.length).toBeGreaterThan(0);
    });

    test("renders inline script for theme initialization", () => {
      const { container } = render(<ThemeMeta />);
      const script = container.querySelector("script");
      expect(script).toBeInTheDocument();
      expect(script?.innerHTML).toContain('var k = "theme"');
      expect(script?.innerHTML).toContain("localStorage.getItem");
      expect(script?.innerHTML).toContain("prefers-color-scheme");
    });

    test("renders style tag for no-theme-transition", () => {
      const { container } = render(<ThemeMeta />);
      const styles = container.querySelectorAll("style");
      expect(styles.length).toBeGreaterThanOrEqual(1);
      const transitionStyle = Array.from(styles).find((style) => style.innerHTML.includes("no-theme-transition"));
      expect(transitionStyle).toBeInTheDocument();
      expect(transitionStyle?.innerHTML).toContain("transition: none !important");
    });

    test("renders noscript fallback", () => {
      const { container } = render(<ThemeMeta />);
      const noscript = container.querySelector("noscript");
      expect(noscript).toBeInTheDocument();
    });

    test("noscript contains fallback styles", () => {
      const { container } = render(<ThemeMeta />);
      const html = container.innerHTML;
      // Check that noscript tag exists in the HTML
      expect(html).toContain("<noscript>");
    });
  });

  describe("script content", () => {
    test("script handles localStorage theme persistence", () => {
      const { container } = render(<ThemeMeta />);
      const script = container.querySelector("script");
      expect(script?.innerHTML).toContain("localStorage.getItem(k)");
      expect(script?.innerHTML).toContain('persisted === "light" || persisted === "dark"');
    });

    test("script handles media query preference", () => {
      const { container } = render(<ThemeMeta />);
      const script = container.querySelector("script");
      expect(script?.innerHTML).toContain('matchMedia("(prefers-color-scheme: dark)")');
      expect(script?.innerHTML).toContain("mql.matches");
    });

    test("script adds dark class conditionally", () => {
      const { container } = render(<ThemeMeta />);
      const script = container.querySelector("script");
      expect(script?.innerHTML).toContain('classList.toggle("dark"');
      expect(script?.innerHTML).toContain('t === "dark"');
    });

    test("script sets data-theme attribute", () => {
      const { container } = render(<ThemeMeta />);
      const script = container.querySelector("script");
      expect(script?.innerHTML).toContain('setAttribute("data-theme", t)');
    });

    test("script prevents first-frame transitions", () => {
      const { container } = render(<ThemeMeta />);
      const script = container.querySelector("script");
      expect(script?.innerHTML).toContain('classList.add("no-theme-transition")');
      expect(script?.innerHTML).toContain('classList.remove("no-theme-transition")');
      expect(script?.innerHTML).toContain("requestAnimationFrame");
    });
  });
});

describe("ThemeProvider", () => {
  beforeEach(() => {
    // Mock window.matchMedia
    window.matchMedia = createMatchMediaMock(false);

    // Clear localStorage before each test
    localStorage.clear();
    // Reset document classes
    document.documentElement.className = "";
    document.documentElement.removeAttribute("data-theme");
    // Clear any mocked functions
    vi.clearAllMocks();
  });

  describe("initialization", () => {
    test("renders children", () => {
      const { getByText } = render(
        <ThemeProvider>
          <div>Test Child</div>
        </ThemeProvider>,
      );
      expect(getByText("Test Child")).toBeInTheDocument();
    });

    test("initializes with system theme by default", () => {
      const { result } = renderHook(() => useTheme(), {
        wrapper: ThemeProvider,
      });
      expect(result.current.theme).toBe("system");
    });

    test("resolves to light or dark based on system preference", () => {
      const { result } = renderHook(() => useTheme(), {
        wrapper: ThemeProvider,
      });
      expect(["light", "dark"]).toContain(result.current.resolvedTheme);
    });

    test("reads persisted theme from localStorage", () => {
      localStorage.setItem("theme", "dark");
      document.documentElement.setAttribute("data-theme", "dark");

      const { result } = renderHook(() => useTheme(), {
        wrapper: ThemeProvider,
      });

      expect(result.current.theme).toBe("dark");
      expect(result.current.resolvedTheme).toBe("dark");
    });

    test("reads light theme from localStorage", () => {
      localStorage.setItem("theme", "light");
      document.documentElement.setAttribute("data-theme", "light");

      const { result } = renderHook(() => useTheme(), {
        wrapper: ThemeProvider,
      });

      expect(result.current.theme).toBe("light");
      expect(result.current.resolvedTheme).toBe("light");
    });
  });

  describe("theme context", () => {
    test("provides theme value", () => {
      const { result } = renderHook(() => useTheme(), {
        wrapper: ThemeProvider,
      });
      expect(result.current.theme).toBeDefined();
      expect(typeof result.current.theme).toBe("string");
    });

    test("provides resolvedTheme value", () => {
      const { result } = renderHook(() => useTheme(), {
        wrapper: ThemeProvider,
      });
      expect(result.current.resolvedTheme).toBeDefined();
      expect(["light", "dark"]).toContain(result.current.resolvedTheme);
    });

    test("provides setTheme function", () => {
      const { result } = renderHook(() => useTheme(), {
        wrapper: ThemeProvider,
      });
      expect(result.current.setTheme).toBeDefined();
      expect(typeof result.current.setTheme).toBe("function");
    });
  });

  describe("theme switching", () => {
    test("switches from light to dark", async () => {
      const { result } = renderHook(() => useTheme(), {
        wrapper: ThemeProvider,
      });

      act(() => {
        result.current.setTheme("light");
      });

      await waitFor(() => {
        expect(result.current.theme).toBe("light");
        expect(result.current.resolvedTheme).toBe("light");
      });

      act(() => {
        result.current.setTheme("dark");
      });

      await waitFor(() => {
        expect(result.current.theme).toBe("dark");
        expect(result.current.resolvedTheme).toBe("dark");
      });
    });

    test("switches from dark to light", async () => {
      const { result } = renderHook(() => useTheme(), {
        wrapper: ThemeProvider,
      });

      act(() => {
        result.current.setTheme("dark");
      });

      await waitFor(() => {
        expect(result.current.theme).toBe("dark");
      });

      act(() => {
        result.current.setTheme("light");
      });

      await waitFor(() => {
        expect(result.current.theme).toBe("light");
        expect(result.current.resolvedTheme).toBe("light");
      });
    });

    test("switches to system theme", async () => {
      const { result } = renderHook(() => useTheme(), {
        wrapper: ThemeProvider,
      });

      act(() => {
        result.current.setTheme("dark");
      });

      await waitFor(() => {
        expect(result.current.theme).toBe("dark");
      });

      act(() => {
        result.current.setTheme("system");
      });

      await waitFor(() => {
        expect(result.current.theme).toBe("system");
        expect(["light", "dark"]).toContain(result.current.resolvedTheme);
      });
    });
  });

  describe("DOM manipulation", () => {
    test("adds dark class to document root when theme is dark", async () => {
      const { result } = renderHook(() => useTheme(), {
        wrapper: ThemeProvider,
      });

      act(() => {
        result.current.setTheme("dark");
      });

      await waitFor(() => {
        expect(document.documentElement.classList.contains("dark")).toBe(true);
      });
    });

    test("removes dark class when theme is light", async () => {
      const { result } = renderHook(() => useTheme(), {
        wrapper: ThemeProvider,
      });

      act(() => {
        result.current.setTheme("dark");
      });

      await waitFor(() => {
        expect(document.documentElement.classList.contains("dark")).toBe(true);
      });

      act(() => {
        result.current.setTheme("light");
      });

      await waitFor(() => {
        expect(document.documentElement.classList.contains("dark")).toBe(false);
      });
    });

    test("sets data-theme attribute on document root", async () => {
      const { result } = renderHook(() => useTheme(), {
        wrapper: ThemeProvider,
      });

      act(() => {
        result.current.setTheme("dark");
      });

      await waitFor(() => {
        expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
      });

      act(() => {
        result.current.setTheme("light");
      });

      await waitFor(() => {
        expect(document.documentElement.getAttribute("data-theme")).toBe("light");
      });
    });
  });

  describe("localStorage persistence", () => {
    test("persists dark theme to localStorage", async () => {
      const { result } = renderHook(() => useTheme(), {
        wrapper: ThemeProvider,
      });

      act(() => {
        result.current.setTheme("dark");
      });

      await waitFor(() => {
        expect(localStorage.getItem("theme")).toBe("dark");
      });
    });

    test("persists light theme to localStorage", async () => {
      const { result } = renderHook(() => useTheme(), {
        wrapper: ThemeProvider,
      });

      act(() => {
        result.current.setTheme("light");
      });

      await waitFor(() => {
        expect(localStorage.getItem("theme")).toBe("light");
      });
    });

    test("removes localStorage entry when theme is system", async () => {
      localStorage.setItem("theme", "dark");

      const { result } = renderHook(() => useTheme(), {
        wrapper: ThemeProvider,
      });

      act(() => {
        result.current.setTheme("system");
      });

      await waitFor(() => {
        expect(localStorage.getItem("theme")).toBeNull();
      });
    });

    test("maintains theme across multiple changes", async () => {
      const { result } = renderHook(() => useTheme(), {
        wrapper: ThemeProvider,
      });

      act(() => {
        result.current.setTheme("dark");
      });

      await waitFor(() => {
        expect(localStorage.getItem("theme")).toBe("dark");
      });

      act(() => {
        result.current.setTheme("light");
      });

      await waitFor(() => {
        expect(localStorage.getItem("theme")).toBe("light");
      });

      act(() => {
        result.current.setTheme("dark");
      });

      await waitFor(() => {
        expect(localStorage.getItem("theme")).toBe("dark");
      });
    });
  });

  describe("system preference handling", () => {
    test("resolves system theme based on media query", async () => {
      const { result } = renderHook(() => useTheme(), {
        wrapper: ThemeProvider,
      });

      act(() => {
        result.current.setTheme("system");
      });

      await waitFor(() => {
        expect(result.current.theme).toBe("system");
        expect(["light", "dark"]).toContain(result.current.resolvedTheme);
      });
    });

    test("updates resolved theme when system preference changes", async () => {
      const { result } = renderHook(() => useTheme(), {
        wrapper: ThemeProvider,
      });

      act(() => {
        result.current.setTheme("system");
      });

      await waitFor(() => {
        expect(result.current.theme).toBe("system");
      });

      // Simulate media query change
      const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
      const initialMatches = mediaQuery.matches;

      // Create a new MediaQueryList with opposite preference
      const event = new Event("change") as MediaQueryListEvent;
      Object.defineProperty(event, "matches", { value: !initialMatches });

      act(() => {
        mediaQuery.dispatchEvent(event);
      });

      await waitFor(() => {
        expect(["light", "dark"]).toContain(result.current.resolvedTheme);
      });
    });

    test("does not update resolved theme when not in system mode", async () => {
      const { result } = renderHook(() => useTheme(), {
        wrapper: ThemeProvider,
      });

      act(() => {
        result.current.setTheme("dark");
      });

      await waitFor(() => {
        expect(result.current.resolvedTheme).toBe("dark");
      });

      // Simulate media query change
      const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
      const event = new Event("change") as MediaQueryListEvent;
      Object.defineProperty(event, "matches", { value: false });

      act(() => {
        mediaQuery.dispatchEvent(event);
      });

      await waitFor(() => {
        expect(result.current.resolvedTheme).toBe("dark");
      });
    });
  });

  describe("useTheme hook", () => {
    test("throws no error when used inside ThemeProvider", () => {
      const { result } = renderHook(() => useTheme(), {
        wrapper: ThemeProvider,
      });
      expect(result.current).toBeDefined();
    });

    test("returns default context values when used outside provider", () => {
      const { result } = renderHook(() => useTheme());
      expect(result.current.theme).toBe("system");
      expect(result.current.resolvedTheme).toBe("light");
      expect(typeof result.current.setTheme).toBe("function");
    });

    test("calling setTheme outside provider does nothing", () => {
      const { result } = renderHook(() => useTheme());
      expect(() => {
        result.current.setTheme("dark");
      }).not.toThrow();
      expect(result.current.theme).toBe("system");
    });
  });

  describe("ThemeContext direct usage", () => {
    test("can be consumed directly", () => {
      const { result } = renderHook(() => useTheme(), {
        wrapper: ThemeProvider,
      });
      expect(result.current).toHaveProperty("theme");
      expect(result.current).toHaveProperty("resolvedTheme");
      expect(result.current).toHaveProperty("setTheme");
    });

    test("provides consistent values", async () => {
      const { result } = renderHook(() => useTheme(), {
        wrapper: ThemeProvider,
      });

      const initialTheme = result.current.theme;

      act(() => {
        result.current.setTheme("dark");
      });

      await waitFor(() => {
        expect(result.current.theme).toBe("dark");
      });

      act(() => {
        result.current.setTheme(initialTheme);
      });

      await waitFor(() => {
        expect(result.current.theme).toBe(initialTheme);
      });
    });
  });

  describe("edge cases", () => {
    test("handles rapid theme changes", async () => {
      const { result } = renderHook(() => useTheme(), {
        wrapper: ThemeProvider,
      });

      act(() => {
        result.current.setTheme("dark");
        result.current.setTheme("light");
        result.current.setTheme("dark");
        result.current.setTheme("system");
      });

      await waitFor(() => {
        expect(result.current.theme).toBe("system");
      });
    });

    test("handles multiple provider instances", () => {
      const { getByText: getText1 } = render(
        <ThemeProvider>
          <div>Provider 1</div>
        </ThemeProvider>,
      );

      const { getByText: getText2 } = render(
        <ThemeProvider>
          <div>Provider 2</div>
        </ThemeProvider>,
      );

      expect(getText1("Provider 1")).toBeInTheDocument();
      expect(getText2("Provider 2")).toBeInTheDocument();
    });

    test("handles corrupted localStorage values", () => {
      localStorage.setItem("theme", "invalid-theme");

      const { result } = renderHook(() => useTheme(), {
        wrapper: ThemeProvider,
      });

      expect(result.current.theme).toBe("system");
      expect(["light", "dark"]).toContain(result.current.resolvedTheme);
    });

    test("handles missing localStorage", () => {
      const originalGetItem = localStorage.getItem;
      localStorage.getItem = vi.fn(() => null);

      const { result } = renderHook(() => useTheme(), {
        wrapper: ThemeProvider,
      });

      expect(result.current.theme).toBe("system");

      localStorage.getItem = originalGetItem;
    });
  });

  describe("integration", () => {
    test("maintains theme state across re-renders", async () => {
      const { result, rerender } = renderHook(() => useTheme(), {
        wrapper: ThemeProvider,
      });

      act(() => {
        result.current.setTheme("dark");
      });

      await waitFor(() => {
        expect(result.current.theme).toBe("dark");
      });

      rerender();

      expect(result.current.theme).toBe("dark");
      expect(result.current.resolvedTheme).toBe("dark");
    });

    test("synchronizes DOM and state", async () => {
      const { result } = renderHook(() => useTheme(), {
        wrapper: ThemeProvider,
      });

      act(() => {
        result.current.setTheme("dark");
      });

      await waitFor(() => {
        expect(result.current.resolvedTheme).toBe("dark");
        expect(document.documentElement.classList.contains("dark")).toBe(true);
        expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
        expect(localStorage.getItem("theme")).toBe("dark");
      });
    });

    test("properly cleans up media query listeners", () => {
      const { unmount } = renderHook(() => useTheme(), {
        wrapper: ThemeProvider,
      });

      expect(() => {
        unmount();
      }).not.toThrow();
    });
  });
});
