import { describe, expect, test } from "vitest";
import { SITE_DESCRIPTION, SITE_NAME, SITE_OG_IMAGE, SITE_PUNCHLINE, SITE_TWITTER_HANDLE, SITE_URL } from "~/data/site";
import { generateMeta } from "./meta";

describe("meta utils", () => {
  describe("generateMeta", () => {
    test("returns default meta tags when no options provided", () => {
      const result = generateMeta();

      expect(result).toContainEqual({ title: `${SITE_NAME} | ${SITE_PUNCHLINE}` });
      expect(result).toContainEqual({ name: "description", content: SITE_DESCRIPTION });
      expect(result).toContainEqual({ property: "og:title", content: `${SITE_NAME} | ${SITE_PUNCHLINE}` });
      expect(result).toContainEqual({ property: "og:description", content: SITE_DESCRIPTION });
      expect(result).toContainEqual({ property: "og:image", content: SITE_OG_IMAGE });
      expect(result).toContainEqual({ property: "og:url", content: SITE_URL });
    });

    test("includes custom title when provided", () => {
      const customTitle = "Custom Page Title";
      const result = generateMeta({ title: customTitle });

      expect(result).toContainEqual({ title: `${customTitle} | ${SITE_NAME}` });
      expect(result).toContainEqual({ property: "og:title", content: `${customTitle} | ${SITE_NAME}` });
      expect(result).toContainEqual({ name: "twitter:title", content: `${customTitle} | ${SITE_NAME}` });
    });

    test("does not append site name if title already contains it at start", () => {
      const customTitle = `${SITE_NAME} | Custom Page`;
      const result = generateMeta({ title: customTitle });

      expect(result).toContainEqual({ title: customTitle });
      expect(result).toContainEqual({ property: "og:title", content: customTitle });
    });

    test("does not append site name if title already contains it at end", () => {
      const customTitle = `Custom Page | ${SITE_NAME}`;
      const result = generateMeta({ title: customTitle });

      expect(result).toContainEqual({ title: customTitle });
      expect(result).toContainEqual({ property: "og:title", content: customTitle });
    });

    test("includes custom description when provided", () => {
      const customDescription = "This is a custom description for the page";
      const result = generateMeta({ description: customDescription });

      expect(result).toContainEqual({ name: "description", content: customDescription });
      expect(result).toContainEqual({ property: "og:description", content: customDescription });
      expect(result).toContainEqual({ name: "twitter:description", content: customDescription });
    });

    test("converts relative image URL to absolute", () => {
      const relativeImage = "/images/custom-og.png";
      const result = generateMeta({ image: relativeImage });

      expect(result).toContainEqual({ property: "og:image", content: `${SITE_URL}${relativeImage}` });
      expect(result).toContainEqual({ name: "twitter:image", content: `${SITE_URL}${relativeImage}` });
    });

    test("keeps absolute image URL unchanged", () => {
      const absoluteImage = "https://example.com/image.png";
      const result = generateMeta({ image: absoluteImage });

      expect(result).toContainEqual({ property: "og:image", content: absoluteImage });
      expect(result).toContainEqual({ name: "twitter:image", content: absoluteImage });
    });

    test("converts relative URL to absolute", () => {
      const relativeUrl = "/about";
      const result = generateMeta({ url: relativeUrl });

      expect(result).toContainEqual({ property: "og:url", content: `${SITE_URL}${relativeUrl}` });
      expect(result).toContainEqual({ tagName: "link", rel: "canonical", href: `${SITE_URL}${relativeUrl}` });
    });

    test("keeps absolute URL unchanged", () => {
      const absoluteUrl = "https://example.com/page";
      const result = generateMeta({ url: absoluteUrl });

      expect(result).toContainEqual({ property: "og:url", content: absoluteUrl });
      expect(result).toContainEqual({ tagName: "link", rel: "canonical", href: absoluteUrl });
    });

    test("sets type to article when specified", () => {
      const result = generateMeta({ type: "article" });

      expect(result).toContainEqual({ property: "og:type", content: "article" });
    });

    test("defaults to website type", () => {
      const result = generateMeta();

      expect(result).toContainEqual({ property: "og:type", content: "website" });
    });

    test("includes robots noindex tag when noIndex is true", () => {
      const result = generateMeta({ noIndex: true });

      expect(result).toContainEqual({ name: "robots", content: "noindex, nofollow" });
    });

    test("does not include robots tag when noIndex is false", () => {
      const result = generateMeta({ noIndex: false });

      const robotsTag = result.find((tag) => "name" in tag && tag.name === "robots");
      expect(robotsTag).toBeUndefined();
    });

    test("includes all favicon tags", () => {
      const result = generateMeta();

      expect(result).toContainEqual({
        tagName: "link",
        rel: "icon",
        type: "image/png",
        href: "/favicon-96x96.png",
        sizes: "96x96",
      });
      expect(result).toContainEqual({ tagName: "link", rel: "icon", type: "image/svg+xml", href: "/favicon.svg" });
      expect(result).toContainEqual({ tagName: "link", rel: "shortcut icon", href: "/favicon.ico" });
      expect(result).toContainEqual({
        tagName: "link",
        rel: "apple-touch-icon",
        sizes: "180x180",
        href: "/apple-touch-icon.png",
      });
    });

    test("includes manifest link", () => {
      const result = generateMeta();

      expect(result).toContainEqual({ tagName: "link", rel: "manifest", href: "/site.webmanifest" });
    });

    test("includes site name in meta tags", () => {
      const result = generateMeta();

      expect(result).toContainEqual({ name: "apple-mobile-web-app-title", content: SITE_NAME });
      expect(result).toContainEqual({ property: "og:site_name", content: SITE_NAME });
    });

    test("includes Twitter card metadata", () => {
      const result = generateMeta();

      expect(result).toContainEqual({ name: "twitter:card", content: "summary_large_image" });
      expect(result).toContainEqual({ name: "twitter:site", content: SITE_TWITTER_HANDLE });
      expect(result).toContainEqual({ name: "twitter:creator", content: SITE_TWITTER_HANDLE });
    });

    test("includes Open Graph image dimensions", () => {
      const result = generateMeta();

      expect(result).toContainEqual({ property: "og:image:width", content: "1200" });
      expect(result).toContainEqual({ property: "og:image:height", content: "630" });
    });

    test("includes image alt text", () => {
      const result = generateMeta();

      expect(result).toContainEqual({ property: "og:image:alt", content: `${SITE_NAME} - ${SITE_DESCRIPTION}` });
      expect(result).toContainEqual({ name: "twitter:image:alt", content: `${SITE_NAME} - ${SITE_DESCRIPTION}` });
    });

    test("includes theme color", () => {
      const result = generateMeta();

      expect(result).toContainEqual({ name: "theme-color", content: "#ff69b4" });
    });

    test("includes mobile web app meta tags", () => {
      const result = generateMeta();

      expect(result).toContainEqual({ name: "apple-mobile-web-app-capable", content: "yes" });
      expect(result).toContainEqual({ name: "apple-mobile-web-app-status-bar-style", content: "black-translucent" });
    });

    test("returns array with title as first element", () => {
      const result = generateMeta();

      expect(result[0]).toEqual({ title: `${SITE_NAME} | ${SITE_PUNCHLINE}` });
    });

    test("handles all options together", () => {
      const options = {
        title: "Dashboard",
        description: "View your consolidated tokens",
        image: "/dashboard-og.png",
        url: "/dashboard",
        type: "website" as const,
        noIndex: true,
      };

      const result = generateMeta(options);

      expect(result).toContainEqual({ title: `Dashboard | ${SITE_NAME}` });
      expect(result).toContainEqual({ name: "description", content: "View your consolidated tokens" });
      expect(result).toContainEqual({ property: "og:image", content: `${SITE_URL}/dashboard-og.png` });
      expect(result).toContainEqual({ property: "og:url", content: `${SITE_URL}/dashboard` });
      expect(result).toContainEqual({ property: "og:type", content: "website" });
      expect(result).toContainEqual({ name: "robots", content: "noindex, nofollow" });
    });
  });
});
