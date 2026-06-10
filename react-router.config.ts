import type { Config } from "@react-router/dev/config";

export default {
  ssr: false,
  future: {
    v8_middleware: true,
    v8_splitRouteModules: true,
    v8_viteEnvironmentApi: true,
    v8_passThroughRequests: true,
    v8_trailingSlashAwareDataRequests: true,
  },
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
