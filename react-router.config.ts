import type { Config } from "@react-router/dev/config";

export default {
  ssr: false,
  async prerender() {
    return [
      "/",
      "/sitemap.xml",
      "/dashboard",
      "/history",
      // Add any other routes you want to prerender
    ];
  },
} satisfies Config;
