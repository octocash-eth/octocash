import { HOW_IT_WORKS_CONTENT } from "~/data/homepage";
import { SupportedChains } from "../supported-chains";

export default function HowItWorksSection() {
  return (
    <section id="how-it-works" className="relative px-4 sm:px-6 lg:px-8 py-20 md:py-32">
      <div className="max-w-7xl mx-auto">
        <div className="flex flex-col lg:flex-row items-center gap-12 lg:gap-24 lg:w-1/2">
          {/* Text Content */}
          <div className="flex-1 space-y-8">
            <div>
              <h2 className="font-grotesque text-4xl md:text-5xl font-bold mb-8 text-primary">
                {HOW_IT_WORKS_CONTENT.title}
              </h2>
              <p className="font-grotesque text-3xl md:text-4xl text-foreground leading-tight">
                {HOW_IT_WORKS_CONTENT.paragraphs[0]}
              </p>
              <p className="font-grotesque text-3xl md:text-4xl text-foreground leading-tight mt-4">
                {HOW_IT_WORKS_CONTENT.paragraphs[1]}
              </p>
            </div>

            {/* Chain Icons */}
            <div className="pt-8">
              <SupportedChains />
            </div>
          </div>

          {/* Illustration */}
          <div className="lg:absolute lg:top-0 right-0 ml-auto translate-x-4 lg:translate-x-0">
            <img
              src="/decorations/how-it-works-illustration.svg"
              alt="How it works illustration"
              width={694}
              height={903}
              className="w-full max-w-md h-auto"
              loading="lazy"
              decoding="async"
            />
          </div>
        </div>
      </div>
    </section>
  );
}
