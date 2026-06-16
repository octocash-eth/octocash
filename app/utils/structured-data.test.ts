import type { Thing, WithContext } from "schema-dts";
import { describe, expect, test } from "vitest";
import { FAQ_ITEMS } from "~/data/homepage";
import {
  ORGANIZATION_NAME,
  SITE_DESCRIPTION,
  SITE_FOUNDED,
  SITE_LOGO,
  SITE_NAME,
  SITE_PUNCHLINE,
  SITE_URL,
  SOCIAL_LINKS,
} from "~/data/site";
import { chains } from "~/data/supported-chains";
import {
  generateFAQPageSchema,
  generateHomepageStructuredData,
  generateOrganizationSchema,
  generateWebApplicationSchema,
  generateWebSiteSchema,
  structuredDataToMetaTags,
} from "./structured-data";

// Type helpers for testing
// biome-ignore lint/suspicious/noExplicitAny: Type helpers for testing dynamic schema objects
type SchemaType = Record<string, any>;

describe("structured-data utils", () => {
  describe("generateOrganizationSchema", () => {
    test("returns valid Organization schema", () => {
      const result = generateOrganizationSchema() as SchemaType;

      expect(result["@context"]).toBe("https://schema.org");
      expect(result["@type"]).toBe("Organization");
    });

    test("includes organization name and legal name", () => {
      const result = generateOrganizationSchema();

      expect(result).toMatchObject({
        name: ORGANIZATION_NAME,
        legalName: ORGANIZATION_NAME,
      });
    });

    test("includes organization URL and logo", () => {
      const result = generateOrganizationSchema();

      expect(result).toMatchObject({
        url: SITE_URL,
        logo: SITE_LOGO,
      });
    });

    test("includes founding date", () => {
      const result = generateOrganizationSchema();

      expect(result).toMatchObject({
        foundingDate: SITE_FOUNDED,
      });
    });

    test("includes social media links", () => {
      const result = generateOrganizationSchema();

      expect(result).toMatchObject({
        sameAs: Object.values(SOCIAL_LINKS),
      });
    });

    test("includes organization description", () => {
      const result = generateOrganizationSchema();

      expect(result).toMatchObject({
        description: SITE_DESCRIPTION,
      });
    });
  });

  describe("generateWebSiteSchema", () => {
    test("returns valid WebSite schema", () => {
      const result = generateWebSiteSchema() as SchemaType;

      expect(result["@context"]).toBe("https://schema.org");
      expect(result["@type"]).toBe("WebSite");
    });

    test("includes website name and URL", () => {
      const result = generateWebSiteSchema();

      expect(result).toMatchObject({
        name: SITE_NAME,
        url: SITE_URL,
      });
    });

    test("includes website description", () => {
      const result = generateWebSiteSchema();

      expect(result).toMatchObject({
        description: SITE_PUNCHLINE,
      });
    });

    test("includes publisher information", () => {
      const result = generateWebSiteSchema();

      expect(result).toMatchObject({
        publisher: {
          "@type": "Organization",
          name: ORGANIZATION_NAME,
        },
      });
    });
  });

  describe("generateWebApplicationSchema", () => {
    test("returns valid WebApplication schema", () => {
      const result = generateWebApplicationSchema() as SchemaType;

      expect(result["@context"]).toBe("https://schema.org");
      expect(result["@type"]).toBe("WebApplication");
    });

    test("includes application name, URL and description", () => {
      const result = generateWebApplicationSchema();

      expect(result).toMatchObject({
        name: SITE_NAME,
        url: SITE_URL,
        description: SITE_DESCRIPTION,
      });
    });

    test("sets application category to FinanceApplication", () => {
      const result = generateWebApplicationSchema();

      expect(result).toMatchObject({
        applicationCategory: "FinanceApplication",
      });
    });

    test("specifies operating system as Any", () => {
      const result = generateWebApplicationSchema();

      expect(result).toMatchObject({
        operatingSystem: "Any",
      });
    });

    test("includes browser requirements", () => {
      const result = generateWebApplicationSchema();

      expect(result).toMatchObject({
        browserRequirements: "Requires JavaScript. Requires Web3 wallet (e.g., MetaMask, WalletConnect).",
      });
    });

    test("includes feature list with chain information", () => {
      const result = generateWebApplicationSchema() as SchemaType;
      const chainNames = Object.values(chains).map((chain) => chain.name);

      expect(result.featureList).toBeDefined();
      expect(Array.isArray(result.featureList)).toBe(true);
      expect(result.featureList).toContain(`Multi-chain token consolidation across ${chainNames.length} blockchains`);
      expect(result.featureList).toContain("Cross-chain token transfers");
      expect(result.featureList).toContain("Automated token swapping");
      expect(result.featureList).toContain("Real-time portfolio tracking");
      expect(result.featureList).toContain(`Support for ${chainNames.join(", ")}`);
    });

    test("feature list has correct number of items", () => {
      const result = generateWebApplicationSchema() as SchemaType;

      expect(result.featureList).toHaveLength(5);
    });
  });

  describe("generateFAQPageSchema", () => {
    test("returns valid FAQPage schema", () => {
      const result = generateFAQPageSchema() as SchemaType;

      expect(result["@context"]).toBe("https://schema.org");
      expect(result["@type"]).toBe("FAQPage");
    });

    test("includes mainEntity with FAQ items", () => {
      const result = generateFAQPageSchema() as SchemaType;

      expect(result.mainEntity).toBeDefined();
      expect(Array.isArray(result.mainEntity)).toBe(true);
      expect(result.mainEntity).toHaveLength(FAQ_ITEMS.length);
    });

    test("each FAQ item has correct Question structure", () => {
      const result = generateFAQPageSchema() as SchemaType;

      result.mainEntity.forEach((entity: SchemaType, index: number) => {
        expect(entity["@type"]).toBe("Question");
        expect(entity.name).toBe(FAQ_ITEMS[index].question);
      });
    });

    test("each FAQ item has correct Answer structure", () => {
      const result = generateFAQPageSchema() as SchemaType;

      result.mainEntity.forEach((entity: SchemaType, index: number) => {
        expect(entity.acceptedAnswer).toBeDefined();
        expect(entity.acceptedAnswer["@type"]).toBe("Answer");
        expect(entity.acceptedAnswer.text).toBe(FAQ_ITEMS[index].answer);
      });
    });

    test("maps all FAQ_ITEMS from homepage data", () => {
      const result = generateFAQPageSchema() as SchemaType;

      FAQ_ITEMS.forEach((item, index) => {
        expect(result.mainEntity[index]).toMatchObject({
          "@type": "Question",
          name: item.question,
          acceptedAnswer: {
            "@type": "Answer",
            text: item.answer,
          },
        });
      });
    });
  });

  describe("generateHomepageStructuredData", () => {
    test("returns array of structured data objects", () => {
      const result = generateHomepageStructuredData();

      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(4);
    });

    test("includes Organization schema", () => {
      const result = generateHomepageStructuredData() as SchemaType[];

      const orgSchema = result.find((schema) => schema["@type"] === "Organization");
      expect(orgSchema).toBeDefined();
      expect(orgSchema).toMatchObject({
        "@context": "https://schema.org",
        "@type": "Organization",
        name: ORGANIZATION_NAME,
      });
    });

    test("includes WebSite schema", () => {
      const result = generateHomepageStructuredData() as SchemaType[];

      const webSiteSchema = result.find((schema) => schema["@type"] === "WebSite");
      expect(webSiteSchema).toBeDefined();
      expect(webSiteSchema).toMatchObject({
        "@context": "https://schema.org",
        "@type": "WebSite",
        name: SITE_NAME,
      });
    });

    test("includes WebApplication schema", () => {
      const result = generateHomepageStructuredData() as SchemaType[];

      const webAppSchema = result.find((schema) => schema["@type"] === "WebApplication");
      expect(webAppSchema).toBeDefined();
      expect(webAppSchema).toMatchObject({
        "@context": "https://schema.org",
        "@type": "WebApplication",
        name: SITE_NAME,
      });
    });

    test("includes FAQPage schema", () => {
      const result = generateHomepageStructuredData() as SchemaType[];

      const faqSchema = result.find((schema) => schema["@type"] === "FAQPage");
      expect(faqSchema).toBeDefined();
      expect(faqSchema).toMatchObject({
        "@context": "https://schema.org",
        "@type": "FAQPage",
      });
    });

    test("returns schemas in correct order", () => {
      const result = generateHomepageStructuredData() as SchemaType[];

      expect(result[0]["@type"]).toBe("Organization");
      expect(result[1]["@type"]).toBe("WebSite");
      expect(result[2]["@type"]).toBe("WebApplication");
      expect(result[3]["@type"]).toBe("FAQPage");
    });
  });

  describe("structuredDataToMetaTags", () => {
    test("converts single structured data object to meta tag format", () => {
      const structuredData = {
        "@context": "https://schema.org" as const,
        "@type": "Organization" as const,
        name: "Test Org",
      };

      const result = structuredDataToMetaTags(structuredData as WithContext<Thing>);

      expect(result).toEqual([
        {
          "script:ld+json": structuredData,
        },
      ]);
    });

    test("converts array of structured data objects to meta tag format", () => {
      const structuredData = [
        {
          "@context": "https://schema.org" as const,
          "@type": "Organization" as const,
          name: "Test Org",
        },
        {
          "@context": "https://schema.org" as const,
          "@type": "WebSite" as const,
          name: "Test Site",
        },
      ];

      const result = structuredDataToMetaTags(structuredData as WithContext<Thing>[]);

      expect(result).toEqual([
        {
          "script:ld+json": structuredData[0],
        },
        {
          "script:ld+json": structuredData[1],
        },
      ]);
    });

    test("returns array even with single object input", () => {
      const structuredData = {
        "@context": "https://schema.org" as const,
        "@type": "Organization" as const,
        name: "Test Org",
      };

      const result = structuredDataToMetaTags(structuredData as WithContext<Thing>);

      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(1);
    });

    test("preserves all data in conversion", () => {
      const complexData = {
        "@context": "https://schema.org" as const,
        "@type": "Organization" as const,
        name: "Test Org",
        url: "https://test.com",
        logo: "https://test.com/logo.png",
        sameAs: ["https://twitter.com/test"],
        foundingDate: "2025",
      };

      const result = structuredDataToMetaTags(complexData as unknown as WithContext<Thing>);

      expect(result[0]["script:ld+json"]).toEqual(complexData);
    });

    test("handles empty array", () => {
      const result = structuredDataToMetaTags([]);

      expect(result).toEqual([]);
    });

    test("works with homepage structured data", () => {
      const homepageData = generateHomepageStructuredData();
      const result = structuredDataToMetaTags(homepageData);

      expect(result).toHaveLength(4);
      expect((result[0]["script:ld+json"] as SchemaType)["@type"]).toBe("Organization");
      expect((result[1]["script:ld+json"] as SchemaType)["@type"]).toBe("WebSite");
      expect((result[2]["script:ld+json"] as SchemaType)["@type"]).toBe("WebApplication");
      expect((result[3]["script:ld+json"] as SchemaType)["@type"]).toBe("FAQPage");
    });
  });

  describe("Integration tests", () => {
    test("all schemas have valid context", () => {
      const schemas = generateHomepageStructuredData() as SchemaType[];

      schemas.forEach((schema) => {
        expect(schema["@context"]).toBe("https://schema.org");
      });
    });

    test("organization name is consistent across schemas", () => {
      const orgSchema = generateOrganizationSchema() as SchemaType;
      const webSiteSchema = generateWebSiteSchema() as SchemaType;

      expect(orgSchema.name).toBe(ORGANIZATION_NAME);
      expect(webSiteSchema.publisher.name).toBe(ORGANIZATION_NAME);
    });

    test("site information is consistent across schemas", () => {
      const orgSchema = generateOrganizationSchema() as SchemaType;
      const webSiteSchema = generateWebSiteSchema() as SchemaType;
      const webAppSchema = generateWebApplicationSchema() as SchemaType;

      expect(orgSchema.url).toBe(SITE_URL);
      expect(webSiteSchema.url).toBe(SITE_URL);
      expect(webAppSchema.url).toBe(SITE_URL);

      expect(webSiteSchema.name).toBe(SITE_NAME);
      expect(webAppSchema.name).toBe(SITE_NAME);
    });

    test("FAQ schema includes all expected questions", () => {
      const faqSchema = generateFAQPageSchema() as SchemaType;
      const expectedQuestions = [
        "Which chains does Octo support?",
        "Does Octo decide which tokens to consolidate?",
        "Are there fees when consolidating?",
        "Is it safe?",
        "Can I choose where my tokens end up?",
        "Can I consolidate privately?",
        "Who operates OctoCash?",
      ];

      const actualQuestions = faqSchema.mainEntity.map((entity: SchemaType) => entity.name);
      expect(actualQuestions).toEqual(expectedQuestions);
    });
  });
});
