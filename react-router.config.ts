import type { Config } from "@react-router/dev/config";

export default {
  ssr: false,
  async prerender() {
    return [
      "/",
      // Add any other routes you want to prerender
    ];
  },
} satisfies Config;
