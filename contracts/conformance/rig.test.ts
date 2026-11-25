/**
 * Browser conformance rig (spec §13). The same assertions run under Playwright
 * (`npx playwright test conformance/rig.test.ts`) and under Vitest (`npm test`),
 * so picking the runner here keeps both suites collecting this file.
 */

import { FixtureAdapter } from "./fixtures/adapter.js";
import { runConformance, startTwoOrigins } from "./rig.js";

const { test, expect } = process.env.VITEST
  ? await import("vitest")
  : await import("@playwright/test");

const BROWSER_CASES = [
  "host-dom-blocked",
  "font-face-scoped",
  "css-scoped",
  "globals-isolated",
  "crash-isolated",
  "sibling-frame-dom-blocked",
  "navigate-popstate",
  "reload-restores",
];

const DIRECT_ADAPTER_CASES = [
  "adapter-storage-survives-upgrade",
  "adapter-active-version-switch",
  "unmount-destroys-frames",
];

test("hostile plugin cannot touch host DOM, fonts or sibling frame", async () => {
  const res = await runConformance({ adapterFactory: () => new FixtureAdapter() });
  expect(res.failed).toEqual([]);
  expect(res.passed).toContain("sibling-frame-dom-blocked");
  expect(res.passed).toContain("font-face-scoped");
});

test("core, browser and direct-adapter cases all pass with explicit ports", async () => {
  const res = await runConformance({
    adapterFactory: () => new FixtureAdapter(),
    ports: [0, 0],
  });
  expect(res.failed).toEqual([]);
  for (const name of [...BROWSER_CASES, ...DIRECT_ADAPTER_CASES]) {
    expect(res.passed).toContain(name);
  }
  expect(res.passed).toContain("envelope-roundtrip");
  expect(res.passed).toContain("navigate-envelope");
  expect(res.passed).toContain("rpc-no-caps-blocked");
});

test("startTwoOrigins serves a host page and plugin fixtures from two distinct HTTP origins", async () => {
  const rig = await startTwoOrigins();
  try {
    const host = new URL(rig.hostOrigin);
    const plugin = new URL(rig.pluginOrigin);
    expect(host.protocol).toBe("http:");
    expect(plugin.protocol).toBe("http:");
    expect(host.host).not.toBe(plugin.host);
    expect((await fetch(`${rig.hostOrigin}/`)).status).toBe(200);
    expect(
      (await fetch(`${rig.pluginOrigin}/plugins/hostile-widget/index.html`)).status,
    ).toBe(200);
  } finally {
    await rig.close();
  }
});
