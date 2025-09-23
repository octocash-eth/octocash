import { ConnectButton } from "@rainbow-me/rainbowkit";
import { Link, useLocation } from "react-router";
import { SITE_NAME } from "~/data/site";
import { useConnectedAddresses } from "~/hooks/use-connected-addresses";
import { ThemeToggle } from "./theme-toggle";

export function SiteHeader() {
  const connectedAddresses = useConnectedAddresses();
  const location = useLocation();
  const isHome = location.pathname === "/";
  const isHistory = location.pathname.startsWith("/history");

  return (
    <header className="w-full px-4 py-3 md:py-4">
      <div className="flex items-center justify-between w-full max-w-7xl mx-auto">
        <div className="flex items-center gap-4">
          <Link to="/" className="flex items-center gap-2" aria-label={SITE_NAME}>
            <img src="/brand/wordmark.svg" alt={SITE_NAME} className="h-7 md:h-8 w-auto block dark:hidden" />
            <img src="/brand/wordmark-dark.svg" alt={SITE_NAME} className="h-7 md:h-8 w-auto hidden dark:block" />
          </Link>
          <nav className="flex items-center gap-2 ml-2">
            <Link
              to="/"
              className={`px-3 py-1.5 rounded-md text-sm transition-colors ${
                isHome
                  ? "bg-card/70 text-primary font-semibold"
                  : "text-muted-foreground hover:text-primary font-medium"
              }`}
            >
              Home
            </Link>
            <Link
              to="/history"
              className={`px-3 py-1.5 rounded-md text-sm transition-colors ${
                isHistory
                  ? "bg-card/70 text-primary font-semibold"
                  : "text-muted-foreground hover:text-primary font-medium"
              }`}
            >
              History
            </Link>
          </nav>
        </div>
        <div className="flex items-center gap-2">
          <ThemeToggle />
          {connectedAddresses.length > 0 ? (
            <div>
              <ConnectButton showBalance={false} chainStatus="none" />
            </div>
          ) : null}
        </div>
      </div>
    </header>
  );
}
