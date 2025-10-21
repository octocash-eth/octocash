import { Link } from "react-router";
import { SiteHeader } from "~/components/site-header";
import { Button } from "~/components/ui/button";
import { SITE_DESCRIPTION, SITE_NAME } from "~/data/site";
import { SupportedChains } from "./supported-chains";

export function meta() {
  return [{ title: SITE_NAME }, { name: "description", content: SITE_DESCRIPTION }];
}

export default function Home() {
  return (
    <div className="flex flex-col min-h-svh bg-gradient-to-br from-background to-accent/10">
      <SiteHeader />

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
              <h2 className="text-4xl lg:text-5xl font-semibold text-primary mb-5 tracking-[0.01em]">{SITE_NAME}</h2>
              <p className="text-base md:text-lg text-muted-foreground mb-9 max-w-md">{SITE_DESCRIPTION}</p>

              {/* CTA Buttons */}
              <div className="flex flex-col sm:flex-row items-center gap-3 mb-8">
                <Link to="/dashboard">
                  <Button size="lg">Consolidate Your Tokens</Button>
                </Link>
              </div>
            </div>
          </div>

          {/* Supported Chains Section */}
          <SupportedChains />
        </div>
      </div>
    </div>
  );
}
