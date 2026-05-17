import { Github } from "lucide-react";
import { useEffect, useRef } from "react";
import { Link } from "react-router";
import { FOOTER_CONTENT } from "~/data/homepage";
import { SOCIAL_LINKS } from "~/data/site";

function XIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

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
        <div className="mt-4 flex justify-center gap-6">
          <Link
            to="/terms"
            className="text-sm font-medium text-orange-900/70 hover:text-orange-900 dark:text-white/70 dark:hover:text-white transition-colors"
          >
            Terms of Service
          </Link>
          <Link
            to="/privacy"
            className="text-sm font-medium text-orange-900/70 hover:text-orange-900 dark:text-white/70 dark:hover:text-white transition-colors"
          >
            Privacy Policy
          </Link>
        </div>
        <div className="mt-6 flex justify-center gap-6">
          <a
            href={SOCIAL_LINKS.github}
            target="_blank"
            rel="noopener noreferrer"
            title="Octocash on GitHub"
            aria-label="Octocash on GitHub"
            className="text-orange-900/70 hover:text-orange-900 dark:text-white/70 dark:hover:text-white transition-colors"
          >
            <Github className="size-6" />
          </a>
          <a
            href={SOCIAL_LINKS.twitter}
            target="_blank"
            rel="noopener noreferrer"
            title="Octocash on X (Twitter)"
            aria-label="Octocash on X (Twitter)"
            className="text-orange-900/70 hover:text-orange-900 dark:text-white/70 dark:hover:text-white transition-colors"
          >
            <XIcon className="size-6" />
          </a>
        </div>
      </div>
    </footer>
  );
}
