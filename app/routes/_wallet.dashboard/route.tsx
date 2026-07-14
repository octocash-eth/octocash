import { Wallet } from "lucide-react";
import { SafeAccountsPanel } from "~/components/safe/safe-accounts-panel";
import { GatedConnectButton, SiteHeader } from "~/components/site";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "~/components/ui/empty";
import { WalletTable } from "~/components/wallet-table";
import { useConnectedAddresses } from "~/hooks/use-connected-addresses";
import { useSpendableAccounts } from "~/hooks/use-spendable-accounts";
import { generateMeta } from "~/utils/meta";

export function meta() {
  return generateMeta({
    title: "Dashboard",
    description: "View and manage your tokens across multiple chains",
    url: "/dashboard",
    noIndex: true,
  });
}

export default function Dashboard() {
  const connectedAddresses = useConnectedAddresses();
  const { addresses, accounts, discoveredSafes, isDiscovering, isSafeEnabled, setSafeEnabled } = useSpendableAccounts();

  return (
    <div className="flex flex-col min-h-svh bg-linear-to-br from-background to-accent/10">
      <SiteHeader />

      {connectedAddresses.length > 0 ? (
        <div className="flex-1 p-4">
          <div className="w-full max-w-7xl mx-auto space-y-4">
            <WalletTable
              connectedAddresses={addresses}
              accounts={accounts}
              // The Safes tab (and the panel inside it) only appears once
              // discovery finds something — everyone else keeps the plain table.
              safesPanel={
                discoveredSafes.length > 0 || isDiscovering ? (
                  <SafeAccountsPanel
                    safes={discoveredSafes}
                    isDiscovering={isDiscovering}
                    isSafeEnabled={isSafeEnabled}
                    setSafeEnabled={setSafeEnabled}
                  />
                ) : undefined
              }
            />
          </div>
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center p-4">
          <Empty className="max-w-md">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Wallet />
              </EmptyMedia>
              <EmptyTitle>Connect Your Wallet</EmptyTitle>
              <EmptyDescription>
                Connect your wallet to view and consolidate your tokens across multiple chains.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <GatedConnectButton />
            </EmptyContent>
          </Empty>
        </div>
      )}
    </div>
  );
}
