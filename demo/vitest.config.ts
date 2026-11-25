import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    server: {
      deps: {
        // The contracts package is a file: link to TypeScript sources.
        inline: [/@vibe\/plugin-contracts/],
      },
    },
  },
});
