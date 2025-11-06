/// <reference types="vitest" />
import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [
    tailwindcss(),
    !process.env.VITEST && reactRouter(),
    tsconfigPaths()
  ],
  server: {
    port: 3000,
    // Allow access when Playwright runs in Docker hitting host via host.docker.internal
    allowedHosts: ["host.docker.internal"],
  },
  test: {
    projects: [
      {
        plugins: [tsconfigPaths()],
        test: {
          name: "unit",
          environment: "jsdom",
          globals: true,
          setupFiles: ["./test/setup.ts"],
          include: ["app/**/*.test.ts", "app/**/*.test.tsx"],
        },
      },
      {
        plugins: [tsconfigPaths()],
        test: {
          name: "integration",
          environment: "jsdom",
          globals: true,
          globalSetup: "./test/integration-global-setup.ts",
          setupFiles: ["./test/setup.ts"],
          include: ["test/integration/**/*.test.ts"],
          pool: "forks",
          testTimeout: 0,
        },
      },
    ],
    coverage: {
      reporter: ["json", "html"],
      include: ["app/lib/**/*"],
      exclude: ["node_modules", "test", "build"],
    },
  },
  ...denoWorkaround(),
});

function denoWorkaround() {
  const isDeno = typeof globalThis !== "undefined" && "Deno" in globalThis;
  if (!isDeno) {
    return undefined;
  }
  // See: https://github.com/remix-run/react-router/issues/12568#issuecomment-2625776697
  return {
    resolve: {
      alias: {
        'react-dom/server': 'react-dom/server.node',
      },
    }
  };
}
