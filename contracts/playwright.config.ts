import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./conformance",
  // Only the browser rig belongs to Playwright; core.test.ts is a Vitest file.
  testMatch: "**/rig.test.ts",
  timeout: 30_000,
  fullyParallel: false,
  use: {
    baseURL: "http://localhost:4000",
    trace: "on-first-retry",
  },
});
