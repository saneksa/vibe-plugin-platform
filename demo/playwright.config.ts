import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  // Only Playwright specs live here; Vitest suites stay under host/ and server/.
  testMatch: "tests/**/*.{test,spec}.ts",
  timeout: 30_000,
  use: {
    baseURL: "http://localhost:4000",
  },
});
