import { render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import App, { ErrorBoundary, HydrateFallback, Layout, links } from "./root";

// Mock react-router components
vi.mock("react-router", () => ({
  Links: () => <div data-testid="links">Links</div>,
  Meta: () => <div data-testid="meta">Meta</div>,
  Outlet: () => <div data-testid="outlet">Outlet</div>,
  Scripts: () => <div data-testid="scripts">Scripts</div>,
  ScrollRestoration: () => <div data-testid="scroll-restoration">ScrollRestoration</div>,
  isRouteErrorResponse: vi.fn((error) => {
    return error && typeof error === "object" && "status" in error && "statusText" in error;
  }),
}));

// Mock theme components
vi.mock("./components/theme", () => ({
  ThemeMeta: () => <div data-testid="theme-meta">ThemeMeta</div>,
  ThemeProvider: ({ children }: { children: React.ReactNode }) => <div data-testid="theme-provider">{children}</div>,
}));

describe("root.tsx", () => {
  describe("links function", () => {
    test("returns an empty array", () => {
      const result = links();
      expect(result).toEqual([]);
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(0);
    });
  });

  describe("Layout component", () => {
    test("renders children in body", () => {
      render(
        <Layout>
          <div data-testid="test-child">Test Child Content</div>
        </Layout>,
      );

      expect(screen.getByTestId("test-child")).toBeInTheDocument();
      expect(screen.getByText("Test Child Content")).toBeInTheDocument();
    });

    test("renders ScrollRestoration in body", () => {
      render(
        <Layout>
          <div>Test Content</div>
        </Layout>,
      );

      expect(screen.getByTestId("scroll-restoration")).toBeInTheDocument();
    });

    test("renders Scripts in body", () => {
      render(
        <Layout>
          <div>Test Content</div>
        </Layout>,
      );

      expect(screen.getByTestId("scripts")).toBeInTheDocument();
    });

    test("renders all expected elements", () => {
      render(
        <Layout>
          <div data-testid="test-child">Content</div>
        </Layout>,
      );

      // Check all elements are present
      expect(screen.getByTestId("test-child")).toBeInTheDocument();
      expect(screen.getByTestId("scroll-restoration")).toBeInTheDocument();
      expect(screen.getByTestId("scripts")).toBeInTheDocument();
    });
  });

  describe("App component", () => {
    test("renders without crashing", () => {
      render(<App />);
      expect(screen.getByTestId("theme-provider")).toBeInTheDocument();
    });

    test("wraps Outlet with ThemeProvider", () => {
      render(<App />);

      const themeProvider = screen.getByTestId("theme-provider");
      const outlet = screen.getByTestId("outlet");

      expect(themeProvider).toBeInTheDocument();
      expect(outlet).toBeInTheDocument();
      expect(themeProvider).toContainElement(outlet);
    });

    test("renders Outlet component", () => {
      render(<App />);
      expect(screen.getByTestId("outlet")).toBeInTheDocument();
    });
  });

  describe("HydrateFallback component", () => {
    test("renders without crashing", () => {
      render(<HydrateFallback />);
      expect(screen.getByTestId("theme-provider")).toBeInTheDocument();
    });

    test("wraps Outlet with ThemeProvider", () => {
      render(<HydrateFallback />);

      const themeProvider = screen.getByTestId("theme-provider");
      const outlet = screen.getByTestId("outlet");

      expect(themeProvider).toBeInTheDocument();
      expect(outlet).toBeInTheDocument();
      expect(themeProvider).toContainElement(outlet);
    });

    test("renders Outlet component", () => {
      render(<HydrateFallback />);
      expect(screen.getByTestId("outlet")).toBeInTheDocument();
    });

    test("has same structure as App component", () => {
      const { unmount: unmountApp } = render(<App />);
      const appThemeProvider = screen.getByTestId("theme-provider");
      const appOutlet = screen.getByTestId("outlet");

      // Both should have ThemeProvider with Outlet
      expect(appThemeProvider).toBeInTheDocument();
      expect(appOutlet).toBeInTheDocument();

      unmountApp();

      render(<HydrateFallback />);
      expect(screen.getByTestId("theme-provider")).toBeInTheDocument();
      expect(screen.getByTestId("outlet")).toBeInTheDocument();
    });
  });

  describe("ErrorBoundary component", () => {
    describe("404 errors", () => {
      test("renders 404 message for 404 status", () => {
        const error = {
          status: 404,
          statusText: "Not Found",
          data: null,
        };

        render(<ErrorBoundary error={error} params={{}} />);

        expect(screen.getByRole("heading", { name: "404" })).toBeInTheDocument();
        expect(screen.getByText("The requested page could not be found.")).toBeInTheDocument();
      });

      test("ignores statusText for 404 errors", () => {
        const error = {
          status: 404,
          statusText: "Custom Status Text",
          data: null,
        };

        render(<ErrorBoundary error={error} params={{}} />);

        expect(screen.getByText("The requested page could not be found.")).toBeInTheDocument();
        expect(screen.queryByText("Custom Status Text")).not.toBeInTheDocument();
      });
    });

    describe("other route errors", () => {
      test("renders error message for non-404 route errors", () => {
        const error = {
          status: 500,
          statusText: "Internal Server Error",
          data: null,
        };

        render(<ErrorBoundary error={error} params={{}} />);

        expect(screen.getByRole("heading", { name: "Error" })).toBeInTheDocument();
        expect(screen.getByText("Internal Server Error")).toBeInTheDocument();
      });

      test("uses default message when statusText is empty", () => {
        const error = {
          status: 500,
          statusText: "",
          data: null,
        };

        render(<ErrorBoundary error={error} params={{}} />);

        expect(screen.getByText("An unexpected error occurred.")).toBeInTheDocument();
      });

      test("renders 403 error", () => {
        const error = {
          status: 403,
          statusText: "Forbidden",
          data: null,
        };

        render(<ErrorBoundary error={error} params={{}} />);

        expect(screen.getByRole("heading", { name: "Error" })).toBeInTheDocument();
        expect(screen.getByText("Forbidden")).toBeInTheDocument();
      });
    });

    describe("development mode errors", () => {
      test("shows error details in development mode", () => {
        // In test environment, DEV is true, so Error instances show details
        const error = new Error("Test error message");
        error.stack = "Error: Test error message\n    at test.ts:1:1";

        render(<ErrorBoundary error={error} params={{}} />);

        // In DEV mode, error message is shown
        expect(screen.getByText("Test error message")).toBeInTheDocument();
        expect(screen.getByText(/Error: Test error message/)).toBeInTheDocument();
      });

      test("shows stack trace when error has stack property", () => {
        // In test environment with Error instance, stack is shown
        const error = new Error("Test error");
        error.stack = "Error: Test error\n    at test.ts:1:1";

        const { container } = render(<ErrorBoundary error={error} params={{}} />);

        const pre = container.querySelector("pre");
        const code = container.querySelector("code");

        expect(pre).toBeInTheDocument();
        expect(code).toBeInTheDocument();
        expect(code).toHaveTextContent(/Error: Test error/);
      });
    });

    describe("default error handling", () => {
      test("renders default message for unknown errors", () => {
        const error = { unknown: "error" };

        render(<ErrorBoundary error={error} params={{}} />);

        expect(screen.getByRole("heading", { name: "Oops!" })).toBeInTheDocument();
        expect(screen.getByText("An unexpected error occurred.")).toBeInTheDocument();
      });

      test("handles null error", () => {
        render(<ErrorBoundary error={null} params={{}} />);

        expect(screen.getByRole("heading", { name: "Oops!" })).toBeInTheDocument();
        expect(screen.getByText("An unexpected error occurred.")).toBeInTheDocument();
      });

      test("handles undefined error", () => {
        // biome-ignore lint/style/noNonNullAssertion: Testing undefined explicitly
        render(<ErrorBoundary error={undefined!} params={{}} />);

        expect(screen.getByRole("heading", { name: "Oops!" })).toBeInTheDocument();
        expect(screen.getByText("An unexpected error occurred.")).toBeInTheDocument();
      });
    });

    describe("component structure", () => {
      test("renders main element with proper classes", () => {
        const error = { status: 404, statusText: "Not Found", data: null };

        const { container } = render(<ErrorBoundary error={error} params={{}} />);

        const main = container.querySelector("main");
        expect(main).toBeInTheDocument();
        expect(main).toHaveClass("pt-16", "p-4", "container", "mx-auto");
      });

      test("renders heading and paragraph", () => {
        const error = { status: 404, statusText: "Not Found", data: null };

        render(<ErrorBoundary error={error} params={{}} />);

        expect(screen.getByRole("heading")).toBeInTheDocument();
        expect(screen.getByText("The requested page could not be found.")).toBeInTheDocument();
      });

      test("renders stack trace with proper styling", () => {
        const error = new Error("Test error");
        error.stack = "Error: Test error\n    at test.ts:1:1";

        const { container } = render(<ErrorBoundary error={error} params={{}} />);

        const pre = container.querySelector("pre");
        const code = container.querySelector("code");

        expect(pre).toBeInTheDocument();
        expect(code).toBeInTheDocument();
        expect(pre).toHaveClass("w-full", "p-4", "overflow-x-auto");
        expect(code).toHaveTextContent(/Error: Test error/);
      });

      test("does not render pre/code when no stack trace", () => {
        const error = { status: 404, statusText: "Not Found", data: null };

        const { container } = render(<ErrorBoundary error={error} params={{}} />);

        expect(container.querySelector("pre")).not.toBeInTheDocument();
        expect(container.querySelector("code")).not.toBeInTheDocument();
      });
    });
  });
});
