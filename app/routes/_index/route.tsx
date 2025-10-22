import { Link } from "react-router";
import { FeatureCard } from "~/components/feature-card";
import { SiteHeader } from "~/components/site-header";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "~/components/ui/accordion";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardTitle } from "~/components/ui/card";
import {
  FAQ_CONTENT,
  FAQ_ITEMS,
  FEATURES_CONTENT,
  FOOTER_CONTENT,
  HERO_CONTENT,
  HOW_IT_WORKS_CONTENT,
  SUPPORT_CONTENT,
} from "~/data/homepage";
import { SITE_DESCRIPTION, SITE_NAME } from "~/data/site";
import { SupportedChains } from "./supported-chains";

export function meta() {
  return [{ title: SITE_NAME }, { name: "description", content: SITE_DESCRIPTION }];
}

export default function Home() {
  return (
    <div className="relative flex flex-col min-h-screen">
      <SiteHeader />

      {/* Hero Section */}
      {/* biome-ignore lint/correctness/useUniqueElementIds: Static IDs are intentional for navigation anchors on homepage */}
      <section
        id="hero"
        className="relative flex flex-col px-4 sm:px-6 lg:px-8 pt-4 sm:pt-8 md:pt-12 lg:pt-16 pb-0 overflow-hidden min-h-[calc(100dvh-60px)]"
      >
        {/* Background Decorations */}
        <div className="absolute inset-0 pointer-events-none overflow-hidden">
          <img
            src="/decorations/section-1-bg.svg"
            alt=""
            width={1728}
            height={989}
            className="absolute bottom-0 left-1/2 -translate-x-1/2 h-auto w-auto min-w-full object-cover object-bottom min-h-[80%]"
          />
        </div>

        {/* Content Container - Centered in available space */}
        <div className="relative z-10 flex-1 flex flex-col items-center justify-center gap-2 sm:gap-3 md:gap-4 lg:gap-6 text-center max-w-6xl mx-auto w-full">
          <h1 className="font-grotesc text-5xl md:text-8xl font-bold leading-none text-purple-500 px-4">
            {HERO_CONTENT.title}
          </h1>
          <p className="font-grotesc text-3xl md:text-4xl font-normal leading-tight text-violet-500 max-w-6xl px-4">
            {HERO_CONTENT.subtitle}
          </p>
          <Link to={HERO_CONTENT.ctaLink} className="mt-1 sm:mt-2 md:mt-3 lg:mt-4">
            <Button size="2xl">{HERO_CONTENT.cta}</Button>
          </Link>
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
            src="/decorations/background-ocean.svg"
            alt=""
            width={1728}
            height={4895}
            className="w-full h-full object-top object-cover"
          />
        </div>

        {/* How It Works Section */}
        {/* biome-ignore lint/correctness/useUniqueElementIds: Static IDs are intentional for navigation anchors on homepage */}
        <section id="how-it-works" className="relative px-4 sm:px-6 lg:px-8 py-20 md:py-32">
          <div className="max-w-7xl mx-auto">
            <div className="flex flex-col lg:flex-row items-center gap-12 lg:gap-24 lg:w-1/2">
              {/* Text Content */}
              <div className="flex-1 space-y-8">
                <div>
                  <h2 className="font-grotesc text-4xl md:text-5xl font-bold mb-8 text-primary">
                    {HOW_IT_WORKS_CONTENT.title}
                  </h2>
                  <p className="font-grotesc text-3xl md:text-4xl text-violet-500 leading-tight">
                    {HOW_IT_WORKS_CONTENT.paragraphs[0]}
                  </p>
                  <p className="font-grotesc text-3xl md:text-4xl text-violet-500 leading-tight mt-4">
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
                />
              </div>
            </div>
          </div>
        </section>

        {/* Key Features Section */}
        {/* biome-ignore lint/correctness/useUniqueElementIds: Static IDs are intentional for navigation anchors on homepage */}
        <section id="features" className="relative px-4 sm:px-6 lg:px-8 py-20 md:py-32 overflow-hidden">
          <div className="max-w-7xl mx-auto">
            {/* Section Header */}
            <div className="text-center mb-16 max-w-4xl mx-auto">
              <h2 className="font-grotesc text-4xl md:text-5xl font-bold mb-6 text-pink-500 leading-none">
                {FEATURES_CONTENT.title}
              </h2>
              <p className="text-3xl md:text-4xl text-violet-500 leading-tight">{FEATURES_CONTENT.subtitle}</p>
            </div>

            {/* Feature Cards Grid */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-6">
              {FEATURES_CONTENT.cards.map((card) => (
                <FeatureCard
                  key={card.title}
                  title={card.title}
                  description={card.description}
                  imageSrc={card.imageSrc}
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
                  <CardTitle className="font-grotesc text-3xl md:text-4xl font-bold text-purple-500">
                    {FEATURES_CONTENT.trustedTech.title}
                  </CardTitle>
                  <CardDescription className="text-2xl md:text-3xl text-violet-500">
                    {FEATURES_CONTENT.trustedTech.description}
                  </CardDescription>
                </div>
                <img
                  src="/decorations/trusted-tech.svg"
                  alt="Circle CCTP and Odos logos"
                  width={716}
                  height={107}
                  className="w-full max-w-2xl h-auto"
                />
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
          />
        </section>

        {/* Support Section */}
        {/* biome-ignore lint/correctness/useUniqueElementIds: Static IDs are intentional for navigation anchors on homepage */}
        <section id="join" className="relative px-4 sm:px-6 lg:px-8 py-20 md:py-32">
          <div className="max-w-7xl mx-auto">
            <div className="flex flex-col lg:flex-row items-center gap-12 lg:gap-24">
              {/* Text and Buttons */}
              <div className="flex-1 space-y-8">
                <div>
                  <h2 className="font-grotesc text-4xl md:text-5xl font-bold mb-8 text-pink-500 leading-none">
                    {SUPPORT_CONTENT.title}
                  </h2>
                  <p className="text-3xl md:text-4xl text-violet-500 max-w-2xl leading-tight">
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
              <div className="flex-shrink-0">
                <img
                  src="/decorations/support-illustration.svg"
                  alt="Support illustration"
                  width={441}
                  height={450}
                  className="w-full max-w-md h-auto"
                />
              </div>
            </div>
          </div>

          {/* Coral Decoration */}
          <img
            src="/decorations/coral-3.svg"
            alt=""
            width={188}
            height={152}
            className="absolute top-0 left-0 h-50 w-auto hidden xl:block"
          />
        </section>

        {/* FAQ Section */}
        {/* biome-ignore lint/correctness/useUniqueElementIds: Static IDs are intentional for navigation anchors on homepage */}
        <section id="faq" className="relative px-4 sm:px-6 lg:px-8 py-20 md:py-32">
          <div className="max-w-7xl mx-auto">
            <img
              src="/decorations/coral-2.svg"
              alt=""
              width={269}
              height={338}
              className="absolute top-0 right-0 h-80 w-auto hidden lg:block"
            />

            {/* Section Header */}
            <div className="mb-12">
              <h2 className="font-grotesc text-4xl md:text-5xl font-bold mb-6 text-pink-500 leading-none">
                {FAQ_CONTENT.title}
              </h2>
              <p className="font-grotesc text-3xl md:text-4xl text-violet-500 lg:w-2/3 leading-tight">
                {FAQ_CONTENT.subtitle}
              </p>
            </div>

            {/* Accordion */}
            <Accordion type="single" collapsible className="space-y-4">
              {FAQ_ITEMS.map((item, index) => (
                <AccordionItem key={`item-${index + 1}`} value={`item-${index + 1}`} className="border rounded-xl px-4">
                  <AccordionTrigger className="font-grotesc text-3xl md:text-4xl font-bold text-pink-500 hover:no-underline leading-tight">
                    {item.question}
                  </AccordionTrigger>
                  <AccordionContent className="text-2xl md:text-3xl text-violet-500 leading-tight">
                    {item.answer}
                  </AccordionContent>
                </AccordionItem>
              ))}
            </Accordion>
          </div>
        </section>

        {/* Footer */}
        <footer className="relative">
          <img
            src="/decorations/footer-ocean.svg"
            alt=""
            width={1728}
            height={750}
            className="w-full h-full object-cover opacity-100"
          />
          <div className="relative px-4 sm:px-6 lg:px-8 pb-12 z-10 text-center bg-[#ECDFC1]">
            <p className="text-2xl md:text-3xl font-medium text-orange-900">{FOOTER_CONTENT.copyright}</p>
          </div>
        </footer>
      </div>
    </div>
  );
}
