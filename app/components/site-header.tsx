import { Menu, X } from "lucide-react";
import { useState } from "react";
import { Link, NavLink, useLocation } from "react-router";
import { SITE_NAME } from "~/data/site";
import { cn } from "~/lib/utils";
import { GatedConnectButton } from "./gated-connect-button";
import { ThemeToggle } from "./theme-toggle";
import { Button, buttonVariants } from "./ui/button";

type NavItem = {
  to: string;
  label: string;
};

const HOME_NAV: NavItem[] = [
  { to: "#how-it-works", label: "How it works" },
  { to: "#features", label: "Features" },
  { to: "#join", label: "Join" },
] as const;

const APP_NAV: NavItem[] = [
  { to: "/dashboard", label: "Dashboard" },
  { to: "/history", label: "History" },
] as const;

export function SiteHeader() {
  const location = useLocation();
  const isHomePage = location.pathname === "/";
  const NAV = isHomePage ? HOME_NAV : APP_NAV;
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  return (
    <header className="w-full px-4 sm:px-6 lg:px-8 py-3 md:py-4">
      <div className="mx-auto flex w-full max-w-7xl items-center justify-between">
        <div className="flex items-center gap-4">
          <Link to="/" className="flex items-center gap-2" aria-label={SITE_NAME}>
            <img src="/brand/wordmark.svg" alt={SITE_NAME} className="block h-7 w-auto dark:hidden md:h-8" />
            <img src="/brand/wordmark-dark.svg" alt={SITE_NAME} className="hidden h-7 w-auto dark:block md:h-8" />
          </Link>
        </div>

        <div className="flex items-center gap-2">
          <div className="hidden md:flex items-center gap-2">
            {NAV.map(({ to, label }) => (
              <NavLink key={to} to={to} className={cn(buttonVariants({ variant: "link", size: "lg" }))}>
                {label}
              </NavLink>
            ))}
            <ThemeToggle />
            <GatedConnectButton />
          </div>

          {/* Mobile Menu Button */}
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden"
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            aria-label="Toggle menu"
          >
            {mobileMenuOpen ? <X className="h-6 w-6" /> : <Menu className="h-6 w-6" />}
          </Button>
        </div>
      </div>

      {/* Mobile Menu */}
      {mobileMenuOpen && (
        <div className="md:hidden mt-4 pb-4 border-t pt-4">
          <nav className="flex flex-col gap-2" aria-label="Mobile navigation">
            {NAV.map(({ to, label }) => (
              <NavLink
                key={to}
                to={to}
                onClick={() => setMobileMenuOpen(false)}
                className={cn(buttonVariants({ variant: "link" }), "justify-start")}
              >
                {label}
              </NavLink>
            ))}
          </nav>
          <div className="flex items-center gap-2 mt-4 px-3">
            <ThemeToggle />
            <GatedConnectButton />
          </div>
        </div>
      )}
    </header>
  );
}
