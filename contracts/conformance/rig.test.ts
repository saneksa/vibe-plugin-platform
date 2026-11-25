/**
 * Browser conformance rig (spec §13). The same assertions run under Playwright
 * (`npx playwright test conformance/rig.test.ts`) and under Vitest (`npm test`),
 * so picking the runner here keeps both suites collecting this file.
 */

import type {
  HostAdapter,
  HostContext,
  HostMeta,
  RpcContext,
} from "../src/host-core/types.js";
import { getMeta, getPolicy } from "../src/protocol/index.js";
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

const CORE_CASES = [
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
];

const DIRECT_ADAPTER_CASES = [
  "adapter-storage-survives-upgrade",
  "adapter-active-version-switch",
  "unmount-destroys-frames",
];

const MANDATED_CASES = [
  ...BROWSER_CASES,
  ...CORE_CASES,
  ...DIRECT_ADAPTER_CASES,
  "rpc-no-caps-blocked",
];

/**
 * A second, deliberately different consumer adapter: theme "light", a private
 * store with a different key format, and its own version map. It exposes no
 * duck-typed `storage`/`activeVersions` probes, so the harness must exercise it
 * purely through the HostAdapter port.
 */
class AlternateAdapter implements HostAdapter {
  private readonly store = new Map<string, string>();
  private readonly versions = new Map<string, string>();

  getMeta(): HostMeta {
    return { ...getMeta(getPolicy()), hostVersion: "alt-3.0.0" };
  }

  getContext(): HostContext {
    return {
      theme: "light",
      locale: "fr-FR",
      user: { id: "alt", displayName: "Alt" },
      hostVersion: "alt-3.0.0",
    };
  }

  grantCapabilities(requested: string[]): string[] {
    return requested.filter((cap) => cap !== "admin");
  }

  async dispatchRpc(method: string, params: unknown, ctx: RpcContext): Promise<unknown> {
    const record = params as { key?: unknown; value?: unknown } | null;
    const key = `${ctx.pluginId}/${ctx.iid}/${String(record?.key ?? params)}`;
    switch (method) {
      case "theme.get":
        return { mode: "light" };
      case "storage.set":
        this.store.set(key, JSON.stringify(record?.value ?? null));
        return true;
      case "storage.get": {
        const raw = this.store.get(key);
        return raw === undefined ? null : JSON.parse(raw);
      }
      case "storage.remove":
        this.store.delete(key);
        return true;
      case "notify.show":
      case "host.log":
        return true;
      case "registry.list":
        return [];
      default:
        throw Object.assign(new Error(`unknown method: ${method}`), { code: "unknown_method" });
    }
  }

  onNavigate(): void {}

  getPluginOrigin(): string {
    return "http://alt.test:4001";
  }

  getPluginFrameBase(plugin: { id: string; version: string }): string {
    return `http://alt.test:4001/plugins/${plugin.id}/${plugin.version}/index.html`;
  }

  async getActiveVersions(): Promise<Record<string, string>> {
    return Object.fromEntries(this.versions);
  }

  async setActiveVersion(pluginId: string, version: string): Promise<void> {
    this.versions.set(pluginId, version);
  }
}

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
  for (const name of MANDATED_CASES) expect(res.passed).toContain(name);
});

test("harness stays portable with a different theme, storage and version backend", async () => {
  const res = await runConformance({
    adapterFactory: () => new AlternateAdapter(),
    ports: [0, 0],
  });
  expect(res.failed).toEqual([]);
  for (const name of MANDATED_CASES) expect(res.passed).toContain(name);
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
