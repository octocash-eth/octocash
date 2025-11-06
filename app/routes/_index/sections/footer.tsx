import { useEffect, useRef } from "react";
import { FOOTER_CONTENT } from "~/data/homepage";

export default function FooterSection() {
  const footerRef = useRef<HTMLElement>(null);
  const isVisibleRef = useRef(false);

  useEffect(() => {
    const footer = footerRef.current;
    if (!footer) return;

    const updateBackgroundColor = () => {
      if (isVisibleRef.current) {
        const isDark = document.documentElement.classList.contains("dark");
        const color = isDark ? "#624e20" : "#ecdfc1";
        document.documentElement.style.setProperty("background-color", color);
      } else {
        document.documentElement.style.removeProperty("background-color");
      }
    };

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          isVisibleRef.current = entry.isIntersecting;
          updateBackgroundColor();
        });
      },
      {
        threshold: 0.1, // Trigger when at least 10% of footer is visible
      },
    );

    observer.observe(footer);

    // Watch for theme changes
    const themeObserver = new MutationObserver(updateBackgroundColor);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });

    return () => {
      observer.disconnect();
      themeObserver.disconnect();
      document.documentElement.style.removeProperty("background-color");
    };
  }, []);

  return (
    <footer ref={footerRef} className="relative">
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
