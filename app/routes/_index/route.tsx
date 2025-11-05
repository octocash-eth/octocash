import { Link } from "react-router";
import { DeferredSection } from "~/components/deferred-section";
import { SiteHeader } from "~/components/site-header";
import { Button } from "~/components/ui/button";
import { HERO_CONTENT } from "~/data/homepage";
import { HeroBg } from "~/images/hero-bg";
import { generateMeta } from "~/utils/meta";
import { generateHomepageStructuredData, structuredDataToMetaTags } from "~/utils/structured-data";
import FAQSection from "./sections/faq";
import FeaturesSection from "./sections/features";
import FooterSection from "./sections/footer";
// Import sections directly for SSR/SSG
import HowItWorksSection from "./sections/how-it-works";
import SupportSection from "./sections/support";

export function meta() {
  const metaTags = generateMeta();
  const structuredData = generateHomepageStructuredData();
  const structuredDataTags = structuredDataToMetaTags(structuredData);

  return [...metaTags, ...structuredDataTags];
}

// Preload critical above-the-fold resources
export function links() {
  return [
    // Preload hero image
    {
      rel: "preload",
      href: "/decorations/octo-header.svg",
      as: "image",
      fetchPriority: "high",
    },
  ];
}

export default function Home() {
  return (
    <div className="relative flex flex-col min-h-screen">
      <SiteHeader />

      <main>
        {/* Hero Section - Above the fold, loads immediately */}
        <section
          id="hero"
          className="relative flex flex-col px-4 sm:px-6 lg:px-8 pt-4 sm:pt-8 md:pt-12 lg:pt-16 pb-0 overflow-hidden min-h-[calc(100svh-60px)]"
        >
          {/* Background Decorations */}
          <div className="absolute inset-0 pointer-events-none overflow-hidden">
            <HeroBg className="absolute inset-0 bottom-0 block h-full w-full" />
          </div>

          {/* Content Container - Centered in available space */}
          <div className="relative z-10 flex-1 flex flex-col items-center justify-center gap-2 sm:gap-3 md:gap-4 lg:gap-6 text-center max-w-6xl mx-auto w-full">
            <h1 className="font-grotesque text-5xl md:text-8xl font-bold leading-none text-secondary px-4 dark:text-primary">
              {HERO_CONTENT.title}
            </h1>
            <p className="font-grotesque text-3xl md:text-4xl font-normal leading-tight text-foreground max-w-6xl px-4">
              {HERO_CONTENT.subtitle}
            </p>
            <Button size="2xl" asChild>
              <Link to={HERO_CONTENT.ctaLink} className="mt-1 sm:mt-2 md:mt-3 lg:mt-4">
                {HERO_CONTENT.cta}
              </Link>
            </Button>
          </div>

          {/* Octo Header Image - positioned at bottom */}
          <div className="relative z-10 w-full max-w-[200px] sm:max-w-xs md:max-w-sm lg:max-w-md xl:max-w-lg mx-auto">
            <img
              src="/decorations/octo-header.svg"
              alt="Octo mascot"
              width={567}
              height={430}
              className="w-full h-auto"
            />
          </div>
        </section>

        {/* Rest of page with ocean background */}
        <div className="relative">
          {/* Background Ocean - Starts After Hero */}
          <div className="absolute inset-0 pointer-events-none overflow-hidden">
            <img
              src="/decorations/background-ocean-light.svg"
              alt=""
              width={1728}
              height={4895}
              className="w-full h-full object-top object-cover dark:hidden"
              loading="lazy"
              decoding="async"
            />
            <img
              src="/decorations/background-ocean-dark.svg"
              alt=""
              width={1728}
              height={4895}
              className="w-full h-full object-top object-cover hidden dark:block"
              loading="lazy"
              decoding="async"
            />
          </div>

          {/* Below-the-fold sections - Rendered on server, deferred hydration on client */}
          <DeferredSection>
            <HowItWorksSection />
          </DeferredSection>

          <DeferredSection>
            <FeaturesSection />
          </DeferredSection>

          <DeferredSection>
            <SupportSection />
          </DeferredSection>

          <DeferredSection>
            <FAQSection />
          </DeferredSection>

          <DeferredSection>
            <FooterSection />
          </DeferredSection>
        </div>
      </main>
    </div>
  );
}
