import { ConnectButton } from "@rainbow-me/rainbowkit";
import { Link, useLocation } from "react-router";
import { SITE_NAME } from "~/data/site";
import { useConnectedAddresses } from "~/hooks/use-connected-addresses";

export function SiteHeader() {
  const connectedAddresses = useConnectedAddresses();
  const location = useLocation();
  const isHome = location.pathname === "/";
  const isHistory = location.pathname.startsWith("/history");

  return (
    <header className="w-full p-4">
      <div className="flex items-center justify-between w-full max-w-7xl mx-auto">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <div className="rounded flex items-center justify-center">
              <span className="text-white font-bold text-lg">🐙</span>
            </div>
            <h1 className="text-xl font-bold text-red-600">{SITE_NAME}</h1>
          </div>
          <nav className="flex items-center gap-2 ml-2">
            <Link
              to="/"
              className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                isHome ? "bg-white/70 text-red-700" : "text-gray-700 hover:text-red-600"
              }`}
            >
              Home
            </Link>
            <Link
              to="/history"
              className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                isHistory ? "bg-white/70 text-red-700" : "text-gray-700 hover:text-red-600"
              }`}
            >
              History
            </Link>
          </nav>
        </div>
        {connectedAddresses.length > 0 ? (
          <div>
            <ConnectButton showBalance={false} chainStatus="none" />
          </div>
        ) : null}
      </div>
    </header>
  );
}
