/**
 * Task 18: the demo's single, real `DemoHostAdapter` is the adapter under test.
 * The portable rig owns the two HTTP origins and Chromium; this file injects
 * only environment-specific values, all backed by in-memory doubles. No demo
 * server and no browser storage are involved.
 *
 * This is a Playwright test; `demo/vitest.config.ts` excludes `tests/**` so the
 * Vitest suite never tries to collect it.
 */
import { expect, test } from "@playwright/test";
import type { PluginDescriptorDTO } from "@vibe/plugin-contracts/host-core";
import type { runConformance as RunConformance } from "@vibe/plugin-contracts/conformance";
import {
  DemoHostAdapter,
  type KeyValueStore,
  type RegistryTransport,
} from "../host/DemoHostAdapter.js";

/**
 * `contracts/` is a separate package with its own `@playwright/test` install.
 * Playwright refuses to register a second physical copy in one process, so the
 * harness is loaded lazily while the registration marker is temporarily clear.
 */
async function portableHarness(): Promise<typeof RunConformance> {
  const pw = process as NodeJS.Process & { __pw_initiator__?: string };
  const marker = pw.__pw_initiator__;
  delete pw.__pw_initiator__;
  try {
    return (await import("@vibe/plugin-contracts/conformance")).runConformance;
  } finally {
    pw.__pw_initiator__ = marker;
  }
}

const PLUGIN_ORIGIN = "http://localhost:4001";
const HOST_VERSION = "2.4.0";

function memoryStore(): KeyValueStore {
  const items = new Map<string, string>();
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, value);
    },
  };
}

function memoryRegistry(): RegistryTransport {
  const active = new Map<string, string>();
  const plugins = new Map<string, PluginDescriptorDTO>();
  return {
    async getActiveVersions() {
      return Object.fromEntries(active);
    },
    async setActiveVersion(id, version) {
      active.set(id, version);
    },
    async list() {
      return [...plugins.values()];
    },
  };
}

// Mirrors the mandated case names of contracts/conformance/rig.test.ts. The
// list is local because the rig does not export it.
const MANDATED_CASES = [
  "host-dom-blocked",
  "font-face-scoped",
  "css-scoped",
  "globals-isolated",
  "crash-isolated",
  "sibling-frame-dom-blocked",
  "navigate-popstate",
  "reload-restores",
  "rpc-no-caps-blocked",
  "envelope-roundtrip",
  "major-gate-409",
  "v1-adapter-in-deprecation-window",
  "append-only-minor",
  "upgrade-preserves-iid-layout-storage",
  "rollback",
  "cache-reconcile",
  "triple-check",
  "timeout-5s",
  "unknown-method",
  "cap-denied",
  "layout-roundtrip",
  "navigate-envelope",
  "default-v1-path",
  "adapter-storage-survives-upgrade",
  "adapter-active-version-switch",
  "unmount-destroys-frames",
];

test("demo's real HostAdapter passes the portable conformance harness", async () => {
  const runConformance = await portableHarness();
  const res = await runConformance({
    adapterFactory: () =>
      new DemoHostAdapter({
        pluginOrigin: PLUGIN_ORIGIN,
        frameBase: (d) => `${PLUGIN_ORIGIN}/plugins/${d.id}/${d.version}/index.html`,
        registry: memoryRegistry(),
        store: memoryStore(),
        hostVersion: HOST_VERSION,
        // The rig drives navigation through its own host page and assertions;
        // the adapter's default callback would touch `window` from Node.
        onNavigate: () => undefined,
      }),
  });

  expect(res.failed).toEqual([]);
  for (const name of MANDATED_CASES) expect(res.passed).toContain(name);
});
