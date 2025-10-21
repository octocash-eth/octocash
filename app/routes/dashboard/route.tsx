import { Wallet } from "lucide-react";
import { GatedConnectButton } from "~/components/gated-connect-button";
import { SiteHeader } from "~/components/site-header";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "~/components/ui/empty";
import { WalletTable } from "~/components/wallet-table";
import { SITE_DESCRIPTION, SITE_NAME } from "~/data/site";
import { useConnectedAddresses } from "~/hooks/use-connected-addresses";

export function meta() {
  return [{ title: `Dashboard — ${SITE_NAME}` }, { name: "description", content: SITE_DESCRIPTION }];
}

export default function Dashboard() {
  const connectedAddresses = useConnectedAddresses();

  return (
    <div className="flex flex-col min-h-svh bg-gradient-to-br from-background to-accent/10">
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
