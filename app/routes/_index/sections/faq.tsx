import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "~/components/ui/accordion";
import { FAQ_CONTENT, FAQ_ITEMS } from "~/data/homepage";

export default function FAQSection() {
  return (
    <section id="faq" className="relative px-4 sm:px-6 lg:px-8 py-20 md:py-32">
      <div className="max-w-7xl mx-auto">
        <img
          src="/decorations/coral-2.svg"
          alt=""
          width={269}
          height={338}
          className="absolute top-0 right-0 h-80 w-auto hidden lg:block"
          loading="lazy"
          decoding="async"
        />

        {/* Section Header */}
        <div className="mb-12">
          <h2 className="font-grotesque text-4xl md:text-5xl font-bold mb-6 text-primary leading-none">
            {FAQ_CONTENT.title}
          </h2>
          <p className="font-grotesque text-3xl md:text-4xl text-foreground lg:w-2/3 leading-tight">
            {FAQ_CONTENT.subtitle}
          </p>
        </div>

        {/* Accordion */}
        <Accordion type="multiple" className="space-y-4">
          {FAQ_ITEMS.map((item, index) => (
            <AccordionItem key={item.question} value={`item-${index + 1}`} className="border rounded-xl px-4">
              <AccordionTrigger className="font-grotesque text-2xl sm:text-3xl md:text-4xl font-bold text-primary hover:no-underline leading-tight">
                {item.question}
              </AccordionTrigger>
              <AccordionContent className="text-xl sm:text-2xl md:text-3xl text-foreground leading-tight">
                {item.answer}
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </div>
    </section>
  );
}
