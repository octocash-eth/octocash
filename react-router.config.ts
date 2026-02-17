import type { Config } from "@react-router/dev/config";

export default {
  ssr: false,
  async prerender() {
    return [
      "/",
      "/sitemap.xml",
      "/terms",
      "/privacy",
      "/dashboard",
      "/history",
      // Add any other routes you want to prerender
    ];
  },
} satisfies Config;
