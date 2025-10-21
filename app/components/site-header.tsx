import { Link, NavLink } from "react-router";
import { SITE_NAME } from "~/data/site";
import { cn } from "~/lib/utils";
import { GatedConnectButton } from "./gated-connect-button";
import { ThemeToggle } from "./theme-toggle";

type NavItem = {
  to: string;
  label: string;
  end?: boolean;
};

const NAV: NavItem[] = [
  { to: "/dashboard", label: "Dashboard" },
  { to: "/history", label: "History" },
] as const;

export function SiteHeader() {
  return (
    <header className="w-full px-4 py-3 md:py-4">
      <div className="mx-auto flex w-full max-w-7xl items-center justify-between">
        <div className="flex items-center gap-4">
          <Link to="/" className="flex items-center gap-2" aria-label={SITE_NAME}>
            <img src="/brand/wordmark.svg" alt={SITE_NAME} className="block h-7 w-auto dark:hidden md:h-8" />
            <img src="/brand/wordmark-dark.svg" alt={SITE_NAME} className="hidden h-7 w-auto dark:block md:h-8" />
          </Link>

          <nav className="ml-2 flex items-center gap-2" aria-label="Primary">
            {NAV.map(({ to, label, end }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                className={({ isActive }) =>
                  cn(
                    "px-3 py-1.5 rounded-md text-sm transition-colors font-medium",
                    isActive ? "bg-card/70 text-primary font-semibold" : "text-muted-foreground hover:text-primary",
                  )
                }
              >
                {label}
              </NavLink>
            ))}
          </nav>
        </div>

        <div className="flex items-center gap-2">
          <ThemeToggle />
          <GatedConnectButton />
        </div>
      </div>
    </header>
  );
}
