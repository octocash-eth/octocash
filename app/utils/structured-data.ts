import type { Thing, WithContext } from "schema-dts";
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

const chainNames = Object.values(chains).map((chain) => chain.name);

/**
 * Generate Organization structured data
 */
export function generateOrganizationSchema(): WithContext<Thing> {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: ORGANIZATION_NAME,
    legalName: ORGANIZATION_NAME,
    url: SITE_URL,
    logo: SITE_LOGO,
    foundingDate: SITE_FOUNDED,
    sameAs: Object.values(SOCIAL_LINKS),
    description: SITE_DESCRIPTION,
  };
}

/**
 * Generate WebSite structured data with search action
 */
export function generateWebSiteSchema(): WithContext<Thing> {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: SITE_NAME,
    url: SITE_URL,
    description: SITE_PUNCHLINE,
    publisher: {
      "@type": "Organization",
      name: ORGANIZATION_NAME,
    },
  };
}

/**
 * Generate WebApplication structured data
 */
export function generateWebApplicationSchema(): WithContext<Thing> {
  return {
    "@context": "https://schema.org",
    "@type": "WebApplication",
    name: SITE_NAME,
    url: SITE_URL,
    description: SITE_DESCRIPTION,
    applicationCategory: "FinanceApplication",
    operatingSystem: "Any",
    browserRequirements: "Requires JavaScript. Requires Web3 wallet (e.g., MetaMask, WalletConnect).",
    offers: {
      "@type": "Offer",
      price: "0",
      priceCurrency: "USD",
    },
    featureList: [
      `Multi-chain token consolidation across ${chainNames.length} blockchains`,
      "Cross-chain token transfers",
      "Automated token swapping",
      "Real-time portfolio tracking",
      `Support for ${chainNames.join(", ")}`,
    ],
  };
}

/**
 * Generate FAQPage structured data from homepage FAQ items
 */
export function generateFAQPageSchema(): WithContext<Thing> {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: FAQ_ITEMS.map((item) => ({
      "@type": "Question",
      name: item.question,
      acceptedAnswer: {
        "@type": "Answer",
        text: item.answer,
      },
    })),
  };
}

/**
 * Generate all structured data for the homepage
 */
export function generateHomepageStructuredData(): WithContext<Thing>[] {
  return [
    generateOrganizationSchema(),
    generateWebSiteSchema(),
    generateWebApplicationSchema(),
    generateFAQPageSchema(),
  ];
}

/**
 * Convert structured data to script tag format for meta function
 */
export function structuredDataToMetaTags(structuredData: WithContext<Thing> | WithContext<Thing>[]) {
  const dataArray = Array.isArray(structuredData) ? structuredData : [structuredData];

  return dataArray.map((data) => ({
    "script:ld+json": data,
  }));
}
