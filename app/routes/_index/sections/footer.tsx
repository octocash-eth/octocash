import { FOOTER_CONTENT } from "~/data/homepage";

export default function FooterSection() {
  return (
    <footer className="relative">
      <img
        src="/decorations/background-footer-light.svg"
        alt=""
        width={1728}
        height={750}
        className="w-full h-full object-cover opacity-100 dark:hidden"
        loading="lazy"
        decoding="async"
      />
      <img
        src="/decorations/background-footer-dark.svg"
        alt=""
        width={1728}
        height={750}
        className="w-full h-full object-cover opacity-100 hidden dark:block"
      />
      <div className="relative px-4 sm:px-6 lg:px-8 pb-12 z-10 text-center bg-[#ecdfc1] dark:bg-[#624e20]">
        <p className="text-2xl md:text-3xl font-medium text-orange-900 dark:text-white">{FOOTER_CONTENT.copyright}</p>
      </div>
    </footer>
  );
}
