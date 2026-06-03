import { Outlet } from "react-router";
import { SupportWidget } from "~/components/site/support-widget";
import { CurrencyProvider } from "~/context/currency-provider";
import { TokenPriceProvider } from "~/context/token-price-provider";
import { WalletProvider } from "~/context/wallet-provider";

/**
 * Pathless layout route that wraps wallet-dependent pages with WalletProvider.
 * This isolates heavy wallet dependencies (Wagmi, query clients, wallet UI) from the homepage.
 */
export default function WalletLayout() {
  return (
    <WalletProvider>
      <TokenPriceProvider>
        <CurrencyProvider>
          <Outlet />
          <SupportWidget />
        </CurrencyProvider>
      </TokenPriceProvider>
    </WalletProvider>
  );
}
