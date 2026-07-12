import { Card, CardContent, CardDescription, CardTitle } from "~/components/ui/card";
import { FEATURES_CONTENT } from "~/data/homepage";
import { FeatureCard } from "../feature-card";

export default function FeaturesSection() {
  return (
    <section id="features" className="relative px-4 sm:px-6 lg:px-8 py-20 md:py-32 overflow-hidden">
      <div className="max-w-7xl mx-auto">
        {/* Section Header */}
        <div className="text-center mb-16 max-w-4xl mx-auto">
          <h2 className="font-grotesque text-4xl md:text-5xl font-bold mb-6 text-primary leading-none">
            {FEATURES_CONTENT.title}
          </h2>
          <p className="text-3xl md:text-4xl text-foreground leading-tight">{FEATURES_CONTENT.subtitle}</p>
        </div>

        {/* Feature Cards Grid */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-6">
          {FEATURES_CONTENT.cards.map((card) => (
            <FeatureCard
              key={card.title}
              title={card.title}
              description={card.description}
              imageSrc={card.imageSrc}
              imageSrcDark={card.imageSrcDark}
              imageAlt={card.imageAlt}
              imageWidth={card.imageWidth}
              imageHeight={card.imageHeight}
              className="shadow-md"
            />
          ))}
        </div>

        {/* Trusted Technologies Card */}
        <Card className="shadow-md">
          <CardContent className="p-8 flex flex-col items-center justify-center space-y-6">
            <div className="md:text-center space-y-4">
              <CardTitle className="font-grotesque text-3xl md:text-4xl font-bold text-secondary">
                {FEATURES_CONTENT.trustedTech.title}
              </CardTitle>
              <CardDescription className="text-2xl md:text-3xl text-foreground">
                {FEATURES_CONTENT.trustedTech.description}
              </CardDescription>
            </div>
            <div className="flex flex-wrap items-center justify-center gap-x-12 gap-y-6">
              <img
                src="/other-icons/circle-light.webp"
                alt=""
                width={800}
                height={205}
                className="h-14 w-auto dark:hidden"
                loading="lazy"
                decoding="async"
              />
              <img
                src="/other-icons/circle-dark.webp"
                alt=""
                width={800}
                height={205}
                className="h-14 w-auto hidden dark:block"
                loading="lazy"
                decoding="async"
              />
              <img
                src="/other-icons/delora-light.webp"
                alt=""
                width={781}
                height={205}
                className="h-14 w-auto dark:hidden"
                loading="lazy"
                decoding="async"
              />
              <img
                src="/other-icons/delora-dark.webp"
                alt=""
                width={781}
                height={205}
                className="h-14 w-auto hidden dark:block"
                loading="lazy"
                decoding="async"
              />
              <img
                src="/other-icons/gnosis-light.webp"
                alt=""
                width={784}
                height={205}
                className="h-12 w-auto dark:hidden"
                loading="lazy"
                decoding="async"
              />
              <img
                src="/other-icons/gnosis-dark.webp"
                alt=""
                width={784}
                height={205}
                className="h-12 w-auto hidden dark:block"
                loading="lazy"
                decoding="async"
              />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Coral Decoration */}
      <img
        src="/decorations/coral-1.svg"
        alt=""
        width={251}
        height={329}
        className="absolute top-0 left-0 h-50 w-auto hidden lg:block xl:h-70"
        loading="lazy"
        decoding="async"
      />
    </section>
  );
}
