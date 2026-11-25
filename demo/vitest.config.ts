import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    // tests/ belongs to Playwright (notably the portable conformance harness).
    exclude: [...configDefaults.exclude, "tests/**"],
    server: {
      deps: {
        // The contracts package is a file: link to TypeScript sources.
        inline: [/@vibe\/plugin-contracts/],
      },
    },
  },
});
