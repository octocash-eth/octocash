import { render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  FAQ_CONTENT,
  FAQ_ITEMS,
  FEATURES_CONTENT,
  FOOTER_CONTENT,
  HERO_CONTENT,
  HOW_IT_WORKS_CONTENT,
  SUPPORT_CONTENT,
} from "~/data/homepage";
import Home, { links, meta } from "./route";
import FAQSection from "./sections/faq";
import FeaturesSection from "./sections/features";
import FooterSection from "./sections/footer";
import HowItWorksSection from "./sections/how-it-works";
import SupportSection from "./sections/support";

// Mock react-router
vi.mock("react-router", () => ({
  Link: ({ children, to, className }: { children: React.ReactNode; to: string; className?: string }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
  useLocation: () => ({ pathname: "/" }),
}));

// Mock SiteHeader
vi.mock("~/components/site", () => ({
  SiteHeader: () => <header data-testid="site-header">Site Header</header>,
}));

// Mock DeferredContent - passthrough to render children
vi.mock("./deferred-content", () => ({
  DeferredContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="deferred-content">{children}</div>
  ),
}));

// Mock HeroBg
vi.mock("./hero-bg", () => ({
  HeroBg: ({ className }: { className?: string }) => <div data-testid="hero-bg" className={className} />,
}));

// Mock SupportedChains
vi.mock("./supported-chains", () => ({
  SupportedChains: () => <div data-testid="supported-chains">Supported Chains</div>,
}));

// Mock FeatureCard
vi.mock("./feature-card", () => ({
  FeatureCard: ({ title, description }: { title: string; description: string }) => (
    <div data-testid="feature-card">
      <h3>{title}</h3>
      <p>{description}</p>
    </div>
  ),
}));

// Mock Button component
vi.mock("~/components/ui/button", () => ({
  Button: ({ children, asChild, size: _ }: { children: React.ReactNode; asChild?: boolean; size?: string }) => {
    if (asChild && Array.isArray(children)) {
      return children[0];
    }
    return <button type="button">{children}</button>;
  },
}));

// Mock UI components
vi.mock("~/components/ui/card", () => ({
  Card: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div data-testid="card" className={className}>
      {children}
    </div>
  ),
  CardHeader: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
  CardContent: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
  CardTitle: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <h3 className={className}>{children}</h3>
  ),
  CardDescription: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <p className={className}>{children}</p>
  ),
}));

vi.mock("~/components/ui/accordion", () => ({
  Accordion: ({ children, type: _, className }: { children: React.ReactNode; type: string; className?: string }) => (
    <div data-testid="accordion" className={className}>
      {children}
    </div>
  ),
  AccordionItem: ({ children, value, className }: { children: React.ReactNode; value: string; className?: string }) => (
    <div data-testid={`accordion-item-${value}`} className={className}>
      {children}
    </div>
  ),
  AccordionTrigger: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <button type="button" className={className}>
      {children}
    </button>
  ),
  AccordionContent: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
}));

// Mock meta utilities
vi.mock("~/utils/meta", () => ({
  generateMeta: vi.fn(() => [
    { title: "OctoCash - Consolidate Your Tokens" },
    { name: "description", content: "Test description" },
  ]),
}));

vi.mock("~/utils/structured-data", () => ({
  generateHomepageStructuredData: vi.fn(() => ({
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: "OctoCash",
  })),
  structuredDataToMetaTags: vi.fn((data) => [
    {
      "script:ld+json": data,
    },
  ]),
}));

describe("Home route - Unit tests", () => {
  describe("meta function", () => {
    test("returns meta tags including structured data", () => {
      const result = meta();

      expect(result).toEqual([
        { title: "OctoCash - Consolidate Your Tokens" },
        { name: "description", content: "Test description" },
        {
          "script:ld+json": {
            "@context": "https://schema.org",
            "@type": "WebSite",
            name: "OctoCash",
          },
        },
      ]);
    });
  });

  describe("links function", () => {
    test("returns preload links for hero image", () => {
      const result = links();

      expect(result).toEqual([
        {
          rel: "preload",
          href: "/decorations/octo-header.webp",
          as: "image",
          type: "image/webp",
          fetchPriority: "high",
        },
      ]);
    });
  });

  describe("Home component", () => {
    test("renders without crashing", () => {
      render(<Home />);
      expect(screen.getByTestId("site-header")).toBeInTheDocument();
    });

    test("renders hero section with title", () => {
      render(<Home />);
      expect(screen.getByText(HERO_CONTENT.title)).toBeInTheDocument();
    });

    test("renders hero section with subtitle", () => {
      render(<Home />);
      expect(screen.getByText(HERO_CONTENT.subtitle)).toBeInTheDocument();
    });

    test("renders hero section with CTA button", () => {
      render(<Home />);
      const ctaButton = screen.getByText(HERO_CONTENT.cta);
      expect(ctaButton).toBeInTheDocument();
      expect(ctaButton.closest("a")).toHaveAttribute("href", HERO_CONTENT.ctaLink);
    });

    test("renders hero section with octopus image", () => {
      render(<Home />);
      const octoImage = screen.getByAltText("Octo mascot");
      expect(octoImage).toBeInTheDocument();
      expect(octoImage).toHaveAttribute("src", "/decorations/octo-header.webp");
    });

    test("renders hero background", () => {
      render(<Home />);
      expect(screen.getByTestId("hero-bg")).toBeInTheDocument();
    });

    test("renders ocean background images", () => {
      render(<Home />);
      const images = screen.getAllByAltText("");
      const oceanImages = images.filter(
        (img) =>
          img.getAttribute("src")?.includes("background-ocean-light.svg") ||
          img.getAttribute("src")?.includes("background-ocean-dark.svg"),
      );
      expect(oceanImages).toHaveLength(2); // Light and dark versions
    });

    test("renders all section components within DeferredContent", () => {
      render(<Home />);

      expect(screen.getByTestId("deferred-content")).toBeInTheDocument();

      // Verify sections are present by checking their content
      expect(screen.getByText(HOW_IT_WORKS_CONTENT.title)).toBeInTheDocument();
      expect(screen.getByText(FEATURES_CONTENT.title)).toBeInTheDocument();
      expect(screen.getByText(SUPPORT_CONTENT.title)).toBeInTheDocument();
      expect(screen.getByText(FAQ_CONTENT.title)).toBeInTheDocument();
      expect(screen.getByText(FOOTER_CONTENT.copyright)).toBeInTheDocument();
    });

    test("has correct page structure", () => {
      render(<Home />);

      // Check for header
      expect(screen.getByRole("banner")).toBeInTheDocument();

      // Check for main element
      expect(screen.getByRole("main")).toBeInTheDocument();

      // Check for hero section
      const heroSection = screen.getByRole("heading", { level: 1 }).closest("section");
      expect(heroSection).toHaveAttribute("id", "hero");
    });

    test("hero section has proper semantic structure", () => {
      render(<Home />);

      // H1 should exist and contain title
      const h1 = screen.getByRole("heading", { level: 1 });
      expect(h1).toHaveTextContent(HERO_CONTENT.title);

      // Check paragraph exists
      const subtitle = screen.getByText(HERO_CONTENT.subtitle);
      expect(subtitle.tagName).toBe("P");
    });
  });
});

describe("Section Components - Integration tests", () => {
  describe("HowItWorksSection", () => {
    test("renders section with correct id", () => {
      render(<HowItWorksSection />);
      const section = screen.getByRole("heading", { level: 2 }).closest("section");
      expect(section).toHaveAttribute("id", "how-it-works");
    });

    test("renders title from content data", () => {
      render(<HowItWorksSection />);
      expect(screen.getByText(HOW_IT_WORKS_CONTENT.title)).toBeInTheDocument();
    });

    test("renders all paragraphs from content data", () => {
      render(<HowItWorksSection />);
      expect(screen.getByText(HOW_IT_WORKS_CONTENT.paragraphs[0])).toBeInTheDocument();
      expect(screen.getByText(HOW_IT_WORKS_CONTENT.paragraphs[1])).toBeInTheDocument();
    });

    test("renders supported chains component", () => {
      render(<HowItWorksSection />);
      expect(screen.getByTestId("supported-chains")).toBeInTheDocument();
    });

    test("renders illustration image", () => {
      render(<HowItWorksSection />);
      const image = screen.getByAltText("How it works illustration");
      expect(image).toHaveAttribute("src", "/decorations/how-it-works-illustration.svg");
    });
  });

  describe("FeaturesSection", () => {
    test("renders section with correct id", () => {
      render(<FeaturesSection />);
      const section = screen.getByRole("heading", { level: 2 }).closest("section");
      expect(section).toHaveAttribute("id", "features");
    });

    test("renders title and subtitle from content data", () => {
      render(<FeaturesSection />);
      expect(screen.getByText(FEATURES_CONTENT.title)).toBeInTheDocument();
      expect(screen.getByText(FEATURES_CONTENT.subtitle)).toBeInTheDocument();
    });

    test("renders all feature cards", () => {
      render(<FeaturesSection />);
      const featureCards = screen.getAllByTestId("feature-card");
      expect(featureCards).toHaveLength(FEATURES_CONTENT.cards.length);

      // Verify each card title is rendered
      FEATURES_CONTENT.cards.forEach((card) => {
        expect(screen.getByText(card.title)).toBeInTheDocument();
        expect(screen.getByText(card.description)).toBeInTheDocument();
      });
    });

    test("renders trusted tech card", () => {
      render(<FeaturesSection />);
      expect(screen.getByText(FEATURES_CONTENT.trustedTech.title)).toBeInTheDocument();
      expect(screen.getByText(/Circle's CCTPv2/)).toBeInTheDocument();
      expect(screen.getByText(/Odos/)).toBeInTheDocument();
    });

    test("renders trusted tech logos for light and dark modes", () => {
      render(<FeaturesSection />);
      const logos = screen.getAllByAltText("Circle CCTP and Odos logos");
      expect(logos).toHaveLength(2); // One for light, one for dark
    });

    test("renders coral decoration", () => {
      render(<FeaturesSection />);
      const decorations = screen.getAllByAltText("");
      const coralDecoration = decorations.find((img) => img.getAttribute("src")?.includes("coral-1.svg"));
      expect(coralDecoration).toBeInTheDocument();
    });
  });

  describe("SupportSection", () => {
    test("renders section with correct id", () => {
      render(<SupportSection />);
      const section = screen.getByRole("heading", { level: 2 }).closest("section");
      expect(section).toHaveAttribute("id", "join");
    });

    test("renders title and description from content data", () => {
      render(<SupportSection />);
      expect(screen.getByText(SUPPORT_CONTENT.title)).toBeInTheDocument();
      expect(screen.getByText(SUPPORT_CONTENT.description)).toBeInTheDocument();
    });

    test("renders CTA button with correct link", () => {
      render(<SupportSection />);
      const ctaLink = screen.getByText(SUPPORT_CONTENT.cta);
      expect(ctaLink).toBeInTheDocument();
      expect(ctaLink).toHaveAttribute("href", SUPPORT_CONTENT.ctaLink);
      expect(ctaLink).toHaveAttribute("target", "_blank");
      expect(ctaLink).toHaveAttribute("rel", "noopener noreferrer");
    });

    test("renders support illustration", () => {
      render(<SupportSection />);
      const image = screen.getByAltText("Support illustration");
      expect(image).toHaveAttribute("src", "/decorations/support-illustration.svg");
    });

    test("renders coral decorations for light and dark modes", () => {
      render(<SupportSection />);
      const decorations = screen.getAllByAltText("");
      const coralDecorations = decorations.filter((img) => img.getAttribute("src")?.includes("coral-3"));
      expect(coralDecorations.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("FAQSection", () => {
    test("renders section with correct id", () => {
      render(<FAQSection />);
      const section = screen.getByRole("heading", { level: 2 }).closest("section");
      expect(section).toHaveAttribute("id", "faq");
    });

    test("renders title and subtitle from content data", () => {
      render(<FAQSection />);
      expect(screen.getByText(FAQ_CONTENT.title)).toBeInTheDocument();
      expect(screen.getByText(FAQ_CONTENT.subtitle)).toBeInTheDocument();
    });

    test("renders accordion component", () => {
      render(<FAQSection />);
      expect(screen.getByTestId("accordion")).toBeInTheDocument();
    });

    test("renders all FAQ items", () => {
      render(<FAQSection />);
      FAQ_ITEMS.forEach((item, index) => {
        expect(screen.getByTestId(`accordion-item-item-${index + 1}`)).toBeInTheDocument();
        expect(screen.getByText(item.question)).toBeInTheDocument();
        expect(screen.getByText(item.answer)).toBeInTheDocument();
      });
    });

    test("renders correct number of FAQ items", () => {
      render(<FAQSection />);
      const accordionItems = screen.getAllByRole("button");
      expect(accordionItems).toHaveLength(FAQ_ITEMS.length);
    });

    test("renders coral decoration", () => {
      render(<FAQSection />);
      const decorations = screen.getAllByAltText("");
      const coralDecoration = decorations.find((img) => img.getAttribute("src")?.includes("coral-2.svg"));
      expect(coralDecoration).toBeInTheDocument();
    });
  });

  describe("FooterSection", () => {
    test("renders footer element", () => {
      render(<FooterSection />);
      expect(screen.getByRole("contentinfo")).toBeInTheDocument();
    });

    test("renders copyright text from content data", () => {
      render(<FooterSection />);
      expect(screen.getByText(FOOTER_CONTENT.copyright)).toBeInTheDocument();
    });

    test("renders footer background images for light and dark modes", () => {
      render(<FooterSection />);
      const images = screen.getAllByAltText("");
      const footerBackgrounds = images.filter((img) => img.getAttribute("src")?.includes("background-footer"));
      expect(footerBackgrounds).toHaveLength(2); // One for light, one for dark
    });

    describe("Observer behavior tests", () => {
      let originalIntersectionObserver: typeof IntersectionObserver;
      let originalMutationObserver: typeof MutationObserver;

      beforeEach(() => {
        // Save original observers
        originalIntersectionObserver = global.IntersectionObserver;
        originalMutationObserver = global.MutationObserver;
      });

      afterEach(() => {
        // Restore original observers
        global.IntersectionObserver = originalIntersectionObserver;
        global.MutationObserver = originalMutationObserver;
        // Clean up styles
        document.documentElement.style.removeProperty("background-color");
        document.documentElement.classList.remove("dark");
      });

      test("sets up IntersectionObserver on mount", () => {
        const mockObserve = vi.fn();
        const mockDisconnect = vi.fn();

        global.IntersectionObserver = class {
          observe = mockObserve;
          unobserve = vi.fn();
          disconnect = mockDisconnect;
          constructor(
            public callback: IntersectionObserverCallback,
            public options?: IntersectionObserverInit,
          ) {}
          // biome-ignore lint/suspicious/noExplicitAny: Mocking global object
        } as any;

        const { unmount } = render(<FooterSection />);

        // Verify observe was called
        expect(mockObserve).toHaveBeenCalledTimes(1);

        // Verify disconnect is called on cleanup
        unmount();
        expect(mockDisconnect).toHaveBeenCalled();
      });

      test("updates background color when footer becomes visible", () => {
        let capturedCallback: IntersectionObserverCallback | null = null;

        global.IntersectionObserver = class {
          observe = vi.fn();
          unobserve = vi.fn();
          disconnect = vi.fn();
          constructor(callback: IntersectionObserverCallback) {
            capturedCallback = callback;
          }
          // biome-ignore lint/suspicious/noExplicitAny: Mocking global object
        } as any;

        render(<FooterSection />);

        // Simulate footer becoming visible
        expect(capturedCallback).not.toBeNull();
        const callback = capturedCallback as unknown as IntersectionObserverCallback;
        callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);

        // Verify background color was set (browsers convert hex to rgb)
        expect(document.documentElement.style.getPropertyValue("background-color")).toBe("rgb(236, 223, 193)");
      });

      test("updates background color for dark mode when footer becomes visible", () => {
        let capturedCallback: IntersectionObserverCallback | null = null;

        global.IntersectionObserver = class {
          observe = vi.fn();
          unobserve = vi.fn();
          disconnect = vi.fn();
          constructor(callback: IntersectionObserverCallback) {
            capturedCallback = callback;
          }
          // biome-ignore lint/suspicious/noExplicitAny: Mocking global object
        } as any;

        // Add dark class to simulate dark mode
        document.documentElement.classList.add("dark");

        render(<FooterSection />);

        // Simulate footer becoming visible
        const callback = capturedCallback as unknown as IntersectionObserverCallback;
        callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);

        // Verify background color was set for dark mode (browsers convert hex to rgb)
        expect(document.documentElement.style.getPropertyValue("background-color")).toBe("rgb(98, 78, 32)");
      });

      test("removes background color when footer is not visible", () => {
        let capturedCallback: IntersectionObserverCallback | null = null;

        global.IntersectionObserver = class {
          observe = vi.fn();
          unobserve = vi.fn();
          disconnect = vi.fn();
          constructor(callback: IntersectionObserverCallback) {
            capturedCallback = callback;
          }
          // biome-ignore lint/suspicious/noExplicitAny: Mocking global object
        } as any;

        render(<FooterSection />);

        // First make it visible
        const callback = capturedCallback as unknown as IntersectionObserverCallback;
        callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
        expect(document.documentElement.style.getPropertyValue("background-color")).toBe("rgb(236, 223, 193)");

        // Then make it not visible
        callback([{ isIntersecting: false } as IntersectionObserverEntry], {} as IntersectionObserver);
        expect(document.documentElement.style.getPropertyValue("background-color")).toBe("");
      });

      test("sets up MutationObserver to watch for theme changes", () => {
        const mockMutationObserve = vi.fn();
        const mockMutationDisconnect = vi.fn();

        global.MutationObserver = class {
          observe = mockMutationObserve;
          disconnect = mockMutationDisconnect;
          constructor(public callback: MutationCallback) {}
          takeRecords = vi.fn();
          // biome-ignore lint/suspicious/noExplicitAny: Mocking global object
        } as any;

        const { unmount } = render(<FooterSection />);

        // Verify it observes document.documentElement with correct options
        expect(mockMutationObserve).toHaveBeenCalledWith(document.documentElement, {
          attributes: true,
          attributeFilter: ["class"],
        });

        // Verify disconnect is called on cleanup
        unmount();
        expect(mockMutationDisconnect).toHaveBeenCalled();
      });

      test("updates background color when theme changes", () => {
        let intersectionCallback: IntersectionObserverCallback | null = null;
        let mutationCallback: MutationCallback | null = null;

        global.IntersectionObserver = class {
          observe = vi.fn();
          unobserve = vi.fn();
          disconnect = vi.fn();
          constructor(callback: IntersectionObserverCallback) {
            intersectionCallback = callback;
          }
          // biome-ignore lint/suspicious/noExplicitAny: Mocking global object
        } as any;

        global.MutationObserver = class {
          observe = vi.fn();
          disconnect = vi.fn();
          takeRecords = vi.fn();
          constructor(callback: MutationCallback) {
            mutationCallback = callback;
          }
          // biome-ignore lint/suspicious/noExplicitAny: Mocking global object
        } as any;

        render(<FooterSection />);

        // Make footer visible first
        const intersectionCb = intersectionCallback as unknown as IntersectionObserverCallback;
        const mutationCb = mutationCallback as unknown as MutationCallback;

        intersectionCb([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
        expect(document.documentElement.style.getPropertyValue("background-color")).toBe("rgb(236, 223, 193)");

        // Simulate theme change to dark
        document.documentElement.classList.add("dark");
        mutationCb([], {} as MutationObserver);
        expect(document.documentElement.style.getPropertyValue("background-color")).toBe("rgb(98, 78, 32)");

        // Simulate theme change back to light
        document.documentElement.classList.remove("dark");
        mutationCb([], {} as MutationObserver);
        expect(document.documentElement.style.getPropertyValue("background-color")).toBe("rgb(236, 223, 193)");
      });

      test("cleans up background color on unmount", () => {
        // Set a background color first
        document.documentElement.style.setProperty("background-color", "#624e20");

        render(<FooterSection />).unmount();

        // Verify background color is removed
        expect(document.documentElement.style.getPropertyValue("background-color")).toBe("");
      });
    });
  });

  describe("Full page integration", () => {
    test("renders all sections in correct order within deferred content", () => {
      render(<Home />);

      const deferredContent = screen.getByTestId("deferred-content");

      // Get all sections within deferred content
      const sections = within(deferredContent).getAllByRole("heading", { level: 2 });

      // Check that sections appear in correct order
      expect(sections[0]).toHaveTextContent(HOW_IT_WORKS_CONTENT.title);
      expect(sections[1]).toHaveTextContent(FEATURES_CONTENT.title);
      expect(sections[2]).toHaveTextContent(SUPPORT_CONTENT.title);
      expect(sections[3]).toHaveTextContent(FAQ_CONTENT.title);
    });

    test("all content data is used consistently", () => {
      render(<Home />);

      // Verify hero content
      expect(screen.getByText(HERO_CONTENT.title)).toBeInTheDocument();
      expect(screen.getByText(HERO_CONTENT.subtitle)).toBeInTheDocument();
      expect(screen.getByText(HERO_CONTENT.cta)).toBeInTheDocument();

      // Verify section content
      expect(screen.getByText(HOW_IT_WORKS_CONTENT.title)).toBeInTheDocument();
      expect(screen.getByText(FEATURES_CONTENT.title)).toBeInTheDocument();
      expect(screen.getByText(SUPPORT_CONTENT.title)).toBeInTheDocument();
      expect(screen.getByText(FAQ_CONTENT.title)).toBeInTheDocument();
      expect(screen.getByText(FOOTER_CONTENT.copyright)).toBeInTheDocument();
    });
  });
});
