import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  // Only Playwright specs live here; Vitest suites stay under host/ and server/.
  testMatch: "tests/**/*.{test,spec}.ts",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: "http://localhost:4000",
  },
  // One command brings up both origins (and fresh archives) for the e2e run.
  // The conformance rig starts its own two origins on ephemeral ports.
  webServer: {
    // Own the server: `command` clears the registry before start. No `tsx watch`
    // here — a watcher spawns a child that can outlive Playwright's shutdown.
    command: "npm run examples:pack && rm -rf storage && ./node_modules/.bin/tsx server/index.ts",
    url: "http://localhost:4000/api/plugins",
    // Tests must own the server: `command` clears the registry before start.
    // Reusing a manually started `npm run dev` would skip that cleanup and
    // leave stale versions behind, making the §16 scenario non-deterministic.
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
