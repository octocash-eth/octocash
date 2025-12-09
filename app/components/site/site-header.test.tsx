import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { SiteHeader } from "./site-header";

// Mock react-router
const mockUseLocation = vi.fn();
const mockLink = vi.fn(
  ({ to, children, className, ...props }: { to: string; children: React.ReactNode; className?: string }) => (
    <a href={to} className={className} {...props}>
      {children}
    </a>
  ),
);
const mockNavLink = vi.fn(
  ({ to, children, className, ...props }: { to: string; children: React.ReactNode; className?: string }) => (
    <a href={to} className={className} {...props}>
      {children}
    </a>
  ),
);

vi.mock("react-router", () => ({
  useLocation: () => mockUseLocation(),
  Link: (props: { to: string; children: React.ReactNode; className?: string }) => mockLink(props),
  NavLink: (props: { to: string; children: React.ReactNode; className?: string }) => mockNavLink(props),
}));

// Mock NavAnchor
const mockNavAnchor = vi.fn(
  ({
    href,
    children,
    className,
    onClick,
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
    onClick?: () => void;
  }) => (
    <a href={href} className={className} onClick={onClick}>
      {children}
    </a>
  ),
);
vi.mock("~/components/site/nav-anchor", () => ({
  NavAnchor: (props: { href: string; children: React.ReactNode; className?: string; onClick?: () => void }) =>
    mockNavAnchor(props),
}));

// Mock ThemeToggle
vi.mock("~/components/theme", () => ({
  ThemeToggle: ({ variant }: { variant?: string }) => (
    <button type="button" data-testid="theme-toggle" data-variant={variant}>
      Toggle Theme
    </button>
  ),
}));

// Mock Button and buttonVariants
vi.mock("~/components/ui/button", () => ({
  Button: ({
    children,
    variant,
    size,
    className,
    onClick,
    asChild,
    disabled,
    ...props
  }: {
    children: React.ReactNode;
    variant?: string;
    size?: string;
    className?: string;
    onClick?: () => void;
    asChild?: boolean;
    disabled?: boolean;
  }) => {
    if (asChild) {
      // When asChild is true, Button renders its children directly
      return children;
    }
    return (
      <button
        type="button"
        className={className}
        onClick={onClick}
        disabled={disabled}
        data-variant={variant}
        data-size={size}
        {...props}
      >
        {children}
      </button>
    );
  },
  buttonVariants: ({ variant, size }: { variant?: string; size?: string }) => `button-${variant}-${size}`,
}));

// Mock lucide-react icons
vi.mock("lucide-react", () => ({
  Menu: () => <div data-testid="menu-icon">Menu</div>,
  X: () => <div data-testid="x-icon">X</div>,
  Moon: () => <div data-testid="moon-icon">Moon</div>,
  Sun: () => <div data-testid="sun-icon">Sun</div>,
}));

// Mock lazy loaded GatedConnectButton
const mockGatedConnectButton = vi.fn(() => <button type="button">Connect Wallet</button>);
vi.mock("~/components/site", () => ({
  GatedConnectButton: () => mockGatedConnectButton(),
}));

// Mock site data
vi.mock("~/data/site", () => ({
  SITE_NAME: "Octocash",
}));

describe("SiteHeader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("rendering on home page", () => {
    beforeEach(() => {
      mockUseLocation.mockReturnValue({ pathname: "/" });
    });

    test("renders header element", () => {
      render(<SiteHeader />);
      const header = screen.getByRole("banner");
      expect(header).toBeInTheDocument();
    });

    test("renders logo with site name", () => {
      render(<SiteHeader />);
      const logo = screen.getByRole("link", { name: "Octocash" });
      expect(logo).toBeInTheDocument();
    });

    test("renders light mode logo image", () => {
      render(<SiteHeader />);
      const lightLogo = document.querySelector('img[src="/brand/wordmark.svg"]');
      expect(lightLogo).toBeInTheDocument();
      expect(lightLogo).toHaveAttribute("alt", "Octocash");
      expect(lightLogo).toHaveClass("block");
      expect(lightLogo).toHaveClass("dark:hidden");
    });

    test("renders dark mode logo image", () => {
      render(<SiteHeader />);
      const darkLogo = document.querySelector('img[src="/brand/wordmark-dark.svg"]');
      expect(darkLogo).toBeInTheDocument();
      expect(darkLogo).toHaveAttribute("alt", "Octocash");
      expect(darkLogo).toHaveClass("hidden");
      expect(darkLogo).toHaveClass("dark:block");
    });

    test("logo links to home page", () => {
      render(<SiteHeader />);
      const logo = screen.getByRole("link", { name: "Octocash" });
      expect(logo).toHaveAttribute("href", "/");
    });

    test("renders home navigation items", () => {
      render(<SiteHeader />);
      expect(screen.getByText("How it works")).toBeInTheDocument();
      expect(screen.getByText("Features")).toBeInTheDocument();
      expect(screen.getByText("Join")).toBeInTheDocument();
      expect(screen.getByText("FAQ")).toBeInTheDocument();
    });

    test("uses NavAnchor for home page navigation", () => {
      render(<SiteHeader />);
      expect(mockNavAnchor).toHaveBeenCalled();
    });

    test("renders Go to Dashboard button", () => {
      render(<SiteHeader />);
      const dashboardButton = screen.getByText("Go to Dashboard");
      expect(dashboardButton).toBeInTheDocument();
    });

    test("Go to Dashboard button links to /dashboard", () => {
      render(<SiteHeader />);
      const dashboardLink = screen.getByText("Go to Dashboard").closest("a");
      expect(dashboardLink).toHaveAttribute("href", "/dashboard");
    });

    test("renders theme toggle", () => {
      render(<SiteHeader />);
      const themeToggles = screen.getAllByTestId("theme-toggle");
      expect(themeToggles.length).toBeGreaterThan(0);
    });

    test("renders main navigation with aria-label", () => {
      render(<SiteHeader />);
      const nav = screen.getByRole("navigation", { name: "Main navigation" });
      expect(nav).toBeInTheDocument();
    });
  });

  describe("rendering on app pages", () => {
    beforeEach(() => {
      mockUseLocation.mockReturnValue({ pathname: "/dashboard" });
    });

    test("renders app navigation items", () => {
      render(<SiteHeader />);
      expect(screen.getByText("Dashboard")).toBeInTheDocument();
      expect(screen.getByText("History")).toBeInTheDocument();
    });

    test("uses NavLink for app page navigation", () => {
      render(<SiteHeader />);
      expect(mockNavLink).toHaveBeenCalled();
    });

    test("does not render home navigation items", () => {
      render(<SiteHeader />);
      expect(screen.queryByText("How it works")).not.toBeInTheDocument();
      expect(screen.queryByText("Features")).not.toBeInTheDocument();
    });

    test("renders Connect Wallet button in Suspense", async () => {
      render(<SiteHeader />);
      // Should show fallback initially or loaded button
      await waitFor(() => {
        const connectButton = screen.getByText("Connect Wallet");
        expect(connectButton).toBeInTheDocument();
      });
    });

    test("shows fallback button while loading GatedConnectButton", () => {
      render(<SiteHeader />);
      // The Suspense fallback is a disabled "Connect Wallet" button
      const buttons = screen.getAllByText("Connect Wallet");
      expect(buttons.length).toBeGreaterThan(0);
    });
  });

  describe("mobile menu functionality", () => {
    beforeEach(() => {
      mockUseLocation.mockReturnValue({ pathname: "/" });
    });

    test("mobile menu button is hidden on desktop", () => {
      render(<SiteHeader />);
      const mobileButton = screen.getByLabelText("Toggle menu");
      expect(mobileButton).toHaveClass("md:hidden");
    });

    test("mobile menu button shows Menu icon when closed", () => {
      render(<SiteHeader />);
      const menuIcon = screen.getByTestId("menu-icon");
      expect(menuIcon).toBeInTheDocument();
    });

    test("mobile menu button has correct aria attributes when closed", () => {
      render(<SiteHeader />);
      const mobileButton = screen.getByLabelText("Toggle menu");
      expect(mobileButton).toHaveAttribute("aria-expanded", "false");
      expect(mobileButton).toHaveAttribute("aria-controls");
    });

    test("mobile menu is closed by default", () => {
      render(<SiteHeader />);
      const mobileNav = screen.queryByRole("navigation", { name: "Mobile navigation" });
      expect(mobileNav).not.toBeInTheDocument();
    });

    test("clicking menu button opens mobile menu", async () => {
      const user = userEvent.setup();
      render(<SiteHeader />);

      const menuButton = screen.getByLabelText("Toggle menu");
      await user.click(menuButton);

      const mobileNav = screen.getByRole("navigation", { name: "Mobile navigation" });
      expect(mobileNav).toBeInTheDocument();
    });

    test("mobile menu button shows X icon when open", async () => {
      const user = userEvent.setup();
      render(<SiteHeader />);

      const menuButton = screen.getByLabelText("Toggle menu");
      await user.click(menuButton);

      const xIcon = screen.getByTestId("x-icon");
      expect(xIcon).toBeInTheDocument();
    });

    test("mobile menu button has correct aria-expanded when open", async () => {
      const user = userEvent.setup();
      render(<SiteHeader />);

      const menuButton = screen.getByLabelText("Toggle menu");
      await user.click(menuButton);

      expect(menuButton).toHaveAttribute("aria-expanded", "true");
    });

    test("clicking menu button again closes mobile menu", async () => {
      const user = userEvent.setup();
      render(<SiteHeader />);

      const menuButton = screen.getByLabelText("Toggle menu");
      await user.click(menuButton);
      await user.click(menuButton);

      const mobileNav = screen.queryByRole("navigation", { name: "Mobile navigation" });
      expect(mobileNav).not.toBeInTheDocument();
    });

    test("mobile menu contains navigation links", async () => {
      const user = userEvent.setup();
      render(<SiteHeader />);

      const menuButton = screen.getByLabelText("Toggle menu");
      await user.click(menuButton);

      const mobileNav = screen.getByRole("navigation", { name: "Mobile navigation" });
      expect(mobileNav).toContainHTML("How it works");
      expect(mobileNav).toContainHTML("Features");
      expect(mobileNav).toContainHTML("Join");
      expect(mobileNav).toContainHTML("FAQ");
    });

    test("clicking link in mobile menu closes menu", async () => {
      const user = userEvent.setup();
      render(<SiteHeader />);

      const menuButton = screen.getByLabelText("Toggle menu");
      await user.click(menuButton);

      const mobileNav = screen.getByRole("navigation", { name: "Mobile navigation" });
      const link = mobileNav.querySelector("a");
      if (link) {
        await user.click(link);
      }

      // Menu should close after clicking a link
      await waitFor(() => {
        expect(screen.queryByRole("navigation", { name: "Mobile navigation" })).not.toBeInTheDocument();
      });
    });

    test("mobile menu has correct ID matching aria-controls", async () => {
      const user = userEvent.setup();
      render(<SiteHeader />);

      const menuButton = screen.getByLabelText("Toggle menu");
      const controlsId = menuButton.getAttribute("aria-controls");

      await user.click(menuButton);

      const mobileMenuContainer = screen.getByRole("navigation", { name: "Mobile navigation" }).closest("div");
      expect(mobileMenuContainer).toHaveAttribute("id", controlsId);
    });
  });

  describe("mobile menu on app pages", () => {
    beforeEach(() => {
      mockUseLocation.mockReturnValue({ pathname: "/dashboard" });
    });

    test("mobile menu contains app navigation links", async () => {
      const user = userEvent.setup();
      render(<SiteHeader />);

      const menuButton = screen.getByLabelText("Toggle menu");
      await user.click(menuButton);

      const mobileNav = screen.getByRole("navigation", { name: "Mobile navigation" });
      expect(mobileNav).toContainHTML("Dashboard");
      expect(mobileNav).toContainHTML("History");
    });
  });

  describe("accessibility", () => {
    beforeEach(() => {
      mockUseLocation.mockReturnValue({ pathname: "/" });
    });

    test("header has role banner", () => {
      render(<SiteHeader />);
      const header = screen.getByRole("banner");
      expect(header).toBeInTheDocument();
    });

    test("logo has aria-label", () => {
      render(<SiteHeader />);
      const logo = screen.getByRole("link", { name: "Octocash" });
      expect(logo).toHaveAttribute("aria-label", "Octocash");
    });

    test("main navigation has aria-label", () => {
      render(<SiteHeader />);
      const nav = screen.getByRole("navigation", { name: "Main navigation" });
      expect(nav).toBeInTheDocument();
    });

    test("mobile menu button has aria-label", () => {
      render(<SiteHeader />);
      const button = screen.getByLabelText("Toggle menu");
      expect(button).toBeInTheDocument();
    });

    test("mobile navigation has aria-label", async () => {
      const user = userEvent.setup();
      render(<SiteHeader />);

      const menuButton = screen.getByLabelText("Toggle menu");
      await user.click(menuButton);

      const mobileNav = screen.getByRole("navigation", { name: "Mobile navigation" });
      expect(mobileNav).toBeInTheDocument();
    });
  });

  describe("responsive behavior", () => {
    beforeEach(() => {
      mockUseLocation.mockReturnValue({ pathname: "/" });
    });

    test("desktop navigation is hidden on mobile", () => {
      render(<SiteHeader />);
      const desktopNav = screen.getByRole("navigation", { name: "Main navigation" });
      expect(desktopNav).toHaveClass("hidden");
      expect(desktopNav).toHaveClass("md:flex");
    });

    test("mobile menu button is hidden on desktop", () => {
      render(<SiteHeader />);
      const menuButton = screen.getByLabelText("Toggle menu");
      expect(menuButton).toHaveClass("md:hidden");
    });

    test("theme toggle has different variants for mobile and desktop", () => {
      render(<SiteHeader />);
      const themeToggles = screen.getAllByTestId("theme-toggle");
      const variants = themeToggles.map((toggle) => toggle.getAttribute("data-variant"));
      expect(variants).toContain("ghost"); // Mobile variant
    });
  });

  describe("sticky header behavior", () => {
    beforeEach(() => {
      mockUseLocation.mockReturnValue({ pathname: "/" });
    });

    test("header has sticky positioning", () => {
      render(<SiteHeader />);
      const header = screen.getByRole("banner");
      expect(header).toHaveClass("sticky");
      expect(header).toHaveClass("top-0");
    });

    test("header has z-index for stacking", () => {
      render(<SiteHeader />);
      const header = screen.getByRole("banner");
      expect(header).toHaveClass("z-50");
    });

    test("header has backdrop blur effect", () => {
      render(<SiteHeader />);
      const header = screen.getByRole("banner");
      expect(header).toHaveClass("backdrop-blur");
    });

    test("header has border", () => {
      render(<SiteHeader />);
      const header = screen.getByRole("banner");
      expect(header).toHaveClass("border-b");
    });
  });

  describe("navigation structure", () => {
    test("home navigation has correct items", () => {
      mockUseLocation.mockReturnValue({ pathname: "/" });
      render(<SiteHeader />);

      expect(mockNavAnchor).toHaveBeenCalledWith(expect.objectContaining({ href: "#how-it-works" }));
      expect(mockNavAnchor).toHaveBeenCalledWith(expect.objectContaining({ href: "#features" }));
      expect(mockNavAnchor).toHaveBeenCalledWith(expect.objectContaining({ href: "#join" }));
      expect(mockNavAnchor).toHaveBeenCalledWith(expect.objectContaining({ href: "#faq" }));
    });

    test("app navigation has correct items", () => {
      mockUseLocation.mockReturnValue({ pathname: "/dashboard" });
      render(<SiteHeader />);

      expect(mockNavLink).toHaveBeenCalledWith(expect.objectContaining({ to: "/dashboard" }));
      expect(mockNavLink).toHaveBeenCalledWith(expect.objectContaining({ to: "/history" }));
    });
  });

  describe("different page routes", () => {
    test("detects home page correctly", () => {
      mockUseLocation.mockReturnValue({ pathname: "/" });
      render(<SiteHeader />);

      expect(screen.getByText("Go to Dashboard")).toBeInTheDocument();
      expect(screen.getByText("How it works")).toBeInTheDocument();
    });

    test("detects dashboard page correctly", () => {
      mockUseLocation.mockReturnValue({ pathname: "/dashboard" });
      render(<SiteHeader />);

      expect(screen.queryByText("Go to Dashboard")).not.toBeInTheDocument();
      expect(screen.getByText("Dashboard")).toBeInTheDocument();
    });

    test("detects history page correctly", () => {
      mockUseLocation.mockReturnValue({ pathname: "/history" });
      render(<SiteHeader />);

      expect(screen.queryByText("Go to Dashboard")).not.toBeInTheDocument();
      expect(screen.getByText("History")).toBeInTheDocument();
    });

    test("treats any non-home path as app page", () => {
      mockUseLocation.mockReturnValue({ pathname: "/some-other-route" });
      render(<SiteHeader />);

      expect(screen.queryByText("How it works")).not.toBeInTheDocument();
      expect(screen.getByText("Dashboard")).toBeInTheDocument();
    });
  });

  describe("component integration", () => {
    beforeEach(() => {
      mockUseLocation.mockReturnValue({ pathname: "/" });
    });

    test("renders all key components together", () => {
      render(<SiteHeader />);

      // Logo
      expect(screen.getByRole("link", { name: "Octocash" })).toBeInTheDocument();
      // Navigation
      expect(screen.getByRole("navigation", { name: "Main navigation" })).toBeInTheDocument();
      // Theme toggle
      expect(screen.getAllByTestId("theme-toggle").length).toBeGreaterThan(0);
      // Main button
      expect(screen.getByText("Go to Dashboard")).toBeInTheDocument();
      // Mobile menu button
      expect(screen.getByLabelText("Toggle menu")).toBeInTheDocument();
    });

    test("mobile and desktop theme toggles are separate", () => {
      render(<SiteHeader />);
      const themeToggles = screen.getAllByTestId("theme-toggle");
      expect(themeToggles.length).toBe(2); // One for mobile, one for desktop
    });
  });

  describe("layout structure", () => {
    beforeEach(() => {
      mockUseLocation.mockReturnValue({ pathname: "/" });
    });

    test("header contains max-width container", () => {
      const { container } = render(<SiteHeader />);
      const maxWidthDiv = container.querySelector(".max-w-7xl");
      expect(maxWidthDiv).toBeInTheDocument();
    });

    test("container uses flexbox layout", () => {
      const { container } = render(<SiteHeader />);
      const flexContainer = container.querySelector(".flex.items-center.justify-between");
      expect(flexContainer).toBeInTheDocument();
    });

    test("header has responsive padding", () => {
      render(<SiteHeader />);
      const header = screen.getByRole("banner");
      expect(header).toHaveClass("px-4");
      expect(header).toHaveClass("sm:px-6");
      expect(header).toHaveClass("lg:px-8");
    });
  });
});
