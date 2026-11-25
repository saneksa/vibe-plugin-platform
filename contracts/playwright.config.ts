import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./conformance",
  timeout: 30_000,
  fullyParallel: false,
  use: {
    baseURL: "http://localhost:4000",
    trace: "on-first-retry",
  },
});
