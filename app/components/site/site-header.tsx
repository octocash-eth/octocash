import { Menu, X } from "lucide-react";
import { lazy, Suspense, useId, useState } from "react";
import { Link, NavLink, useLocation } from "react-router";
import { ThemeToggle } from "~/components/theme";
import { Button, buttonVariants } from "~/components/ui/button";
import { SITE_NAME } from "~/data/site";
import { cn } from "~/lib/utils";
import { NavAnchor } from "./nav-anchor";

// Lazy load wallet button to keep it out of the homepage bundle
const GatedConnectButton = lazy(() =>
  import("~/components/site/gated-connect-button").then((m) => ({ default: m.GatedConnectButton })),
);

// Lazy for the same reason: it pulls wagmi + TanStack Query via its dialog.
const ConnectSafesButton = lazy(() =>
  import("~/components/site/connect-safes-button").then((m) => ({ default: m.ConnectSafesButton })),
);

// Lazy load currency selector — it lives inside <CurrencyProvider> (which is
// only mounted on /dashboard and /history) and depends on TanStack Query +
// the CoinGecko fetcher, so we keep it out of the marketing bundle.
const CurrencySelector = lazy(() =>
  import("~/components/site/currency-selector").then((m) => ({ default: m.CurrencySelector })),
);

type NavItem = {
  to: string;
  label: string;
};

const HOME_NAV: NavItem[] = [
  { to: "#how-it-works", label: "How it works" },
  { to: "#features", label: "Features" },
  { to: "#join", label: "Join" },
  { to: "#faq", label: "FAQ" },
] as const;

const APP_NAV: NavItem[] = [
  { to: "/dashboard", label: "Dashboard" },
  { to: "/history", label: "History" },
] as const;

function MainButton({ isAppPage }: { isAppPage: boolean }) {
  if (!isAppPage) {
    return (
      <Button asChild>
        <Link to="/dashboard">Go to Dashboard</Link>
      </Button>
    );
  }
  return (
    <>
      <Suspense
        fallback={
          <Button variant="outline" disabled>
            Connect Safes
          </Button>
        }
      >
        <ConnectSafesButton />
      </Suspense>
      <Suspense fallback={<Button disabled>Connect Wallet</Button>}>
        <GatedConnectButton />
      </Suspense>
    </>
  );
}

function Links({
  items,
  isAppPage,
  isMobile,
  onLinkClick,
}: {
  items: readonly NavItem[];
  isAppPage: boolean;
  isMobile?: boolean;
  onLinkClick?: () => void;
}) {
  const linkClassName = cn(
    buttonVariants({ variant: "link", size: isMobile ? "default" : "lg" }),
    isMobile && "justify-start",
  );

  return (
    <>
      {items.map(({ to, label }) =>
        isAppPage ? (
          <NavLink key={to} to={to} onClick={onLinkClick} className={linkClassName}>
            {label}
          </NavLink>
        ) : (
          <NavAnchor key={to} href={to} onClick={onLinkClick} className={linkClassName}>
            {label}
          </NavAnchor>
        ),
      )}
    </>
  );
}

export function SiteHeader() {
  const location = useLocation();
  const isAppPage = location.pathname.startsWith("/dashboard") || location.pathname.startsWith("/history");
  const NAV = isAppPage ? APP_NAV : HOME_NAV;
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const mobileMenuId = useId();

  return (
    <header className="sticky top-0 z-50 w-full border-b border-border/40 bg-background/80 px-4 py-3 backdrop-blur supports-backdrop-filter:bg-background/60 sm:px-6 lg:px-8 md:py-4">
      <div className="mx-auto flex w-full max-w-7xl items-center justify-between">
        <div className="flex items-center gap-4">
          <Link to="/" className="flex items-center gap-2" aria-label={SITE_NAME}>
            <img src="/brand/wordmark.svg" alt={SITE_NAME} className="block h-7 w-auto dark:hidden md:h-8" />
            <img src="/brand/wordmark-dark.svg" alt={SITE_NAME} className="hidden h-7 w-auto dark:block md:h-8" />
          </Link>
        </div>

        <div className="flex items-center gap-2">
          <div className="md:hidden">
            <ThemeToggle variant="ghost" />
          </div>
          <nav className="hidden md:flex items-center gap-2" aria-label="Main navigation">
            <Links items={NAV} isAppPage={isAppPage} />
            {isAppPage && (
              <Suspense
                fallback={
                  <Button variant="ghost" size="sm" disabled aria-hidden="true">
                    USD
                  </Button>
                }
              >
                <CurrencySelector />
              </Suspense>
            )}
            <ThemeToggle />
            <MainButton isAppPage={isAppPage} />
          </nav>

          {/* Mobile Menu Button */}
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden"
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            aria-label="Toggle menu"
            aria-expanded={mobileMenuOpen}
            aria-controls={mobileMenuId}
          >
            {mobileMenuOpen ? <X className="h-6 w-6" /> : <Menu className="h-6 w-6" />}
          </Button>
        </div>
      </div>

      {/* Mobile Menu */}
      {mobileMenuOpen && (
        <div id={mobileMenuId} className="md:hidden mt-4 pb-4 border-t pt-4">
          <nav className="flex flex-col gap-2" aria-label="Mobile navigation">
            <Links items={NAV} isAppPage={isAppPage} isMobile onLinkClick={() => setMobileMenuOpen(false)} />
          </nav>
          {isAppPage && (
            <div className="mt-2 px-3">
              <Suspense
                fallback={
                  <Button variant="ghost" size="default" disabled className="w-full justify-between">
                    USD
                  </Button>
                }
              >
                <CurrencySelector variant="wide" />
              </Suspense>
            </div>
          )}
          <div className="flex items-center gap-2 mt-4 px-3">
            <MainButton isAppPage={isAppPage} />
          </div>
        </div>
      )}
    </header>
  );
}
