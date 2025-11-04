import { Button } from "~/components/ui/button";
import { SUPPORT_CONTENT } from "~/data/homepage";

export default function SupportSection() {
  return (
    <section id="join" className="relative px-4 sm:px-6 lg:px-8 py-20 md:py-32">
      <div className="max-w-7xl mx-auto">
        <div className="flex flex-col lg:flex-row items-center gap-12 lg:gap-24">
          {/* Text and Buttons */}
          <div className="flex-1 space-y-8">
            <div>
              <h2 className="font-grotesque text-4xl md:text-5xl font-bold mb-8 text-primary leading-none">
                {SUPPORT_CONTENT.title}
              </h2>
              <p className="text-3xl md:text-4xl text-foreground max-w-2xl leading-tight">
                {SUPPORT_CONTENT.description}
              </p>
            </div>

            <div className="flex flex-row gap-4">
              <a href={SUPPORT_CONTENT.ctaLink} target="_blank" rel="noopener noreferrer">
                <Button size="2xl">{SUPPORT_CONTENT.cta}</Button>
              </a>
            </div>
          </div>

          {/* Illustration */}
          <div className="shrink-0">
            <img
              src="/decorations/support-illustration.svg"
              alt="Support illustration"
              width={441}
              height={450}
              className="w-full max-w-md h-auto"
              loading="lazy"
              decoding="async"
            />
          </div>
        </div>
      </div>

      {/* Coral Decoration */}
      <img
        src="/decorations/coral-3-light.svg"
        alt=""
        width={188}
        height={152}
        className="absolute top-0 left-0 h-50 w-auto hidden xl:dark:hidden xl:block"
        loading="lazy"
        decoding="async"
      />
      <img
        src="/decorations/coral-3-dark.svg"
        alt=""
        width={188}
        height={152}
        className="absolute top-0 left-0 h-50 w-auto hidden xl:dark:block"
        loading="lazy"
        decoding="async"
      />
    </section>
  );
}
