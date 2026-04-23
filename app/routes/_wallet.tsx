import { Outlet } from "react-router";
import { WalletProvider } from "~/context/wallet-provider";

/**
 * Pathless layout route that wraps wallet-dependent pages with WalletProvider.
 * This isolates heavy wallet dependencies (Wagmi, query clients, wallet UI) from the homepage.
 */
export default function WalletLayout() {
  return (
    <WalletProvider>
      <Outlet />
    </WalletProvider>
  );
}
