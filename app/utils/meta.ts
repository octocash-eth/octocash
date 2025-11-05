import { SITE_DESCRIPTION, SITE_NAME, SITE_OG_IMAGE, SITE_PUNCHLINE, SITE_TWITTER_HANDLE, SITE_URL } from "~/data/site";

export interface MetaOptions {
  title?: string;
  description?: string;
  image?: string;
  url?: string;
  type?: "website" | "article";
  noIndex?: boolean;
}

/**
 * Generate comprehensive meta tags for social media cards (Open Graph & Twitter)
 */
export function generateMeta(options: MetaOptions = {}) {
  const {
    title = `${SITE_NAME} | ${SITE_PUNCHLINE}`,
    description = SITE_DESCRIPTION,
    image = SITE_OG_IMAGE,
    url = SITE_URL,
    type = "website",
    noIndex = false,
  } = options;

  const fullTitle =
    title.startsWith(`${SITE_NAME} |`) || title.endsWith(`| ${SITE_NAME}`) ? title : `${title} | ${SITE_NAME}`;
  const fullImageUrl = image.startsWith("http") ? image : `${SITE_URL}${image}`;
  const fullUrl = url.startsWith("http") ? url : `${SITE_URL}${url}`;

  const meta: Array<{
    name?: string;
    property?: string;
    content?: string;
    tagName?: string;
    rel?: string;
    href?: string;
    type?: string;
    sizes?: string;
  }> = [
    // Favicons and App Icons
    { tagName: "link", rel: "icon", type: "image/png", href: "/favicon-96x96.png", sizes: "96x96" },
    { tagName: "link", rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
    { tagName: "link", rel: "shortcut icon", href: "/favicon.ico" },
    { tagName: "link", rel: "apple-touch-icon", sizes: "180x180", href: "/apple-touch-icon.png" },
    { name: "apple-mobile-web-app-title", content: SITE_NAME },
    { tagName: "link", rel: "manifest", href: "/site.webmanifest" },

    // Canonical URL
    { tagName: "link", rel: "canonical", href: fullUrl },

    // Basic meta
    { name: "description", content: description },

    // Open Graph
    { property: "og:type", content: type },
    { property: "og:site_name", content: SITE_NAME },
    { property: "og:title", content: fullTitle },
    { property: "og:description", content: description },
    { property: "og:image", content: fullImageUrl },
    { property: "og:image:width", content: "1200" },
    { property: "og:image:height", content: "630" },
    { property: "og:image:alt", content: `${SITE_NAME} - ${description}` },
    { property: "og:url", content: fullUrl },

    // Twitter Card
    { name: "twitter:card", content: "summary_large_image" },
    { name: "twitter:site", content: SITE_TWITTER_HANDLE },
    { name: "twitter:creator", content: SITE_TWITTER_HANDLE },
    { name: "twitter:title", content: fullTitle },
    { name: "twitter:description", content: description },
    { name: "twitter:image", content: fullImageUrl },
    { name: "twitter:image:alt", content: `${SITE_NAME} - ${description}` },

    // Additional meta
    { name: "theme-color", content: "#ff69b4" }, // Pink color matching your mascot
    { name: "apple-mobile-web-app-capable", content: "yes" },
    { name: "apple-mobile-web-app-status-bar-style", content: "black-translucent" },
  ];

  // Add robots meta if noIndex is true
  if (noIndex) {
    meta.push({ name: "robots", content: "noindex, nofollow" });
  }

  return [{ title: fullTitle }, ...meta];
}
