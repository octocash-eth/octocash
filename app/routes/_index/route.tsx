import { GatedConnectButton } from "~/components/gated-connect-button";
import { SiteHeader } from "~/components/site-header";
import { WalletTable } from "~/components/wallet-table";
import { SITE_DESCRIPTION, SITE_NAME } from "~/data/site";
import { useConnectedAddresses } from "~/hooks/use-connected-addresses";
import { SupportedChains } from "./supported-chains";

export function meta() {
  return [{ title: SITE_NAME }, { name: "description", content: SITE_DESCRIPTION }];
}

export default function Home() {
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
        <div className="flex-1 flex flex-col items-center justify-center p-4">
          <div className="w-full max-w-4xl mx-auto text-center">
            {/* Main Content */}
            <div className="flex flex-col lg:flex-row items-center justify-center gap-8 mb-12">
              {/* Mascot Image */}
              <div className="flex-shrink-0 animate-bounce [animation-duration:5s]">
                <img src="/brand/mascot.png" alt="Octocash mascot" className="h-[220px] w-auto" />
              </div>

              {/* Main Text Content */}
              <div className="flex flex-col items-center lg:items-start text-center lg:text-left">
                <h2 className="text-4xl lg:text-5xl font-bold text-primary mb-4">{SITE_NAME}</h2>
                <p className="text-lg text-muted-foreground mb-8 max-w-md">{SITE_DESCRIPTION}</p>

                {/* Connect Wallet Button */}
                <div className="mb-8">
                  <GatedConnectButton />
                </div>
              </div>
            </div>

            {/* Supported Chains Section */}
            <SupportedChains />
          </div>
        </div>
      )}
    </div>
  );
}
