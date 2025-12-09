import { Wallet } from "lucide-react";
import { GatedConnectButton, SiteHeader } from "~/components/site";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "~/components/ui/empty";
import { WalletTable } from "~/components/wallet-table";
import { useConnectedAddresses } from "~/hooks/use-connected-addresses";
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

  return (
    <div className="flex flex-col min-h-svh bg-linear-to-br from-background to-accent/10">
      <SiteHeader />

      {connectedAddresses.length > 0 ? (
        <div className="flex-1 p-4">
          <div className="w-full max-w-7xl mx-auto">
            <WalletTable connectedAddresses={connectedAddresses} />
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
