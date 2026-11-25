/**
 * Portable browser conformance rig (spec §13). The consumer supplies only an
 * `adapterFactory`: this module starts its own two HTTP origins, serves the
 * prebuilt hostile fixture, and drives the browser checks. No demo code, no
 * demo servers and no external HTTP packages.
 */

import { chromium, type Page } from "@playwright/test";
import { createFrameManager } from "../src/host-core/FrameManager.js";
import { HostState } from "../src/host-core/HostState.js";
import type { HostAdapter, PluginDescriptor, RpcContext } from "../src/host-core/types.js";
import { runCoreConformance, type ConformanceResult } from "./core.js";
import { FakeFrameHost, MemoryStore } from "./fakes.js";
import { startTwoOrigins, type TwoOrigins } from "./staticServer.js";

export type { TwoOrigins } from "./staticServer.js";
export { startTwoOrigins } from "./staticServer.js";

export interface ConformanceOptions {
  adapterFactory: () => HostAdapter;
  ports?: [number, number];
}

type RigWindow = Window & {
  __rigReports: Array<Record<string, unknown>>;
  __rigNavigations: string[];
  __rigRoutes: string[];
  __rigRpcAttempts: string[];
  __rigInitialRoute: string;
  __rigMount: () => void;
  __rigUnmount: () => void;
  __hostMarker: string;
  __hostFetch: typeof fetch;
  __hostTick: number;
  __rigDispatch: (method: string, params: unknown, ctx: RpcContext) => Promise<unknown>;
  __rigGetActiveVersions: () => Promise<Record<string, string>>;
  __rigOnNavigate: (iid: string, path: string, replace: boolean) => Promise<void>;
};

type Case = { name: string; run: () => Promise<void> };
type Failure = { name: string; error: string };

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function errorOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function collect(cases: Case[], passed: string[], failed: Failure[]): Promise<void> {
  for (const entry of cases) {
    try {
      await entry.run();
      passed.push(entry.name);
    } catch (err) {
      failed.push({ name: entry.name, error: errorOf(err) });
    }
  }
}

/** Bridges the real consumer adapter into the browser page under test. */
async function installBridge(
  page: Page,
  adapter: HostAdapter,
): Promise<{ navigateCalls: number; dispatchCalls: string[] }> {
  const bridge = { navigateCalls: 0, dispatchCalls: [] as string[] };
  await page.exposeFunction(
    "__rigDispatch",
    (method: string, params: unknown, ctx: RpcContext) => {
      bridge.dispatchCalls.push(`${ctx.iid}:${method}`);
      return adapter.dispatchRpc(method, params, ctx);
    },
  );
  await page.exposeFunction("__rigGetActiveVersions", () => adapter.getActiveVersions());
  await page.exposeFunction("__rigOnNavigate", (iid: string, path: string, replace: boolean) => {
    bridge.navigateCalls++;
    adapter.onNavigate(iid, path, replace);
  });
  return bridge;
}

const UPGRADE_CTX: RpcContext = {
  iid: "i-upgrade",
  pluginId: "hostile-widget",
  version: "1.0.0",
  caps: ["storage.write"],
};

function browserCases(
  page: Page,
  bridge: { navigateCalls: number; dispatchCalls: string[] },
): Case[] {
  const reports = (): Promise<Array<Record<string, unknown>>> =>
    page.evaluate(() => (window as unknown as RigWindow).__rigReports);

  const latest = async (): Promise<Record<string, unknown>> => (await reports()).at(-1) ?? {};

  const browserState = (): Promise<{
    sentinel: string | null;
    secret: string | null;
    bodyBackground: string;
    sentinelColor: string;
    sentinelDisplay: string;
    hostFontFamilies: string[];
    hostMarker: string;
    fetchIntact: boolean;
    ownOverride: unknown;
  }> =>
    page.evaluate(() => {
      const win = window as unknown as RigWindow;
      const sentinel = document.getElementById("host-sentinel");
      const style = sentinel === null ? null : window.getComputedStyle(sentinel);
      return {
        sentinel: sentinel?.textContent ?? null,
        secret: window.localStorage.getItem("host-secret"),
        bodyBackground: window.getComputedStyle(document.body).backgroundColor,
        sentinelColor: style?.color ?? "",
        sentinelDisplay: style?.display ?? "",
        hostFontFamilies: Array.from(document.fonts, (face) =>
          String(face.family).replace(/["']/g, ""),
        ),
        hostMarker: win.__hostMarker,
        fetchIntact: win.fetch === win.__hostFetch,
        ownOverride: (window as unknown as Record<string, unknown>).__VIBE_OVERRIDE__,
      };
    });

  return [
    {
      name: "host-dom-blocked",
      run: async () => {
        const report = await latest();
        check(report.parentDocument === "blocked", `parent.document was ${String(report.parentDocument)}`);
        check(report.parentStorage === "blocked", `parent.localStorage was ${String(report.parentStorage)}`);
        const state = await browserState();
        check(state.sentinel === "HOST-SENTINEL", "host sentinel DOM was modified");
        check(state.secret === "host-only", "host localStorage was modified");
      },
    },
    {
      name: "font-face-scoped",
      run: async () => {
        const report = await latest();
        check(report.fontRegistered === true, "hostile plugin did not register the common font");
        const state = await browserState();
        check(
          !state.hostFontFamilies.includes("VibeCommon"),
          "plugin @font-face leaked into the host realm",
        );
        check(
          state.hostFontFamilies.includes("HostOnlyFont"),
          "host's own @font-face was replaced",
        );
      },
    },
    {
      name: "css-scoped",
      run: async () => {
        const report = await latest();
        check(report.globalCssApplied === true, "global CSS selector did not apply in plugin frame");
        const state = await browserState();
        check(state.bodyBackground === "rgb(240, 240, 240)", "plugin changed host body background");
        check(state.sentinelColor === "rgb(1, 2, 3)", "plugin changed host sentinel color");
        check(state.sentinelDisplay !== "none", "plugin hid the host sentinel");
      },
    },
    {
      name: "globals-isolated",
      run: async () => {
        const report = await latest();
        check(report.ownGlobalChanged === true, "plugin did not overwrite its own global");
        check(report.ownFetchChanged === true, "plugin did not overwrite its own fetch");
        const state = await browserState();
        check(state.hostMarker === "host-value", "host global was overwritten");
        check(state.fetchIntact === true, "host fetch was overwritten");
        check(state.ownOverride === undefined, "plugin global leaked into the host realm");
      },
    },
    {
      name: "crash-isolated",
      run: async () => {
        const report = await latest();
        check(report.crashed === true, "hostile plugin did not throw");
        const before = await page.evaluate(() => (window as unknown as RigWindow).__hostTick);
        await page.waitForTimeout(150);
        const after = await page.evaluate(() => (window as unknown as RigWindow).__hostTick);
        check(after > before, "host stopped working after the plugin crash");
        const state = await browserState();
        check(state.sentinel === "HOST-SENTINEL", "host DOM broke after the plugin crash");
      },
    },
    {
      // Attempt 5: an RPC is sent without any granted capability. The host
      // records it but must never dispatch it to the real adapter.
      name: "rpc-no-caps-blocked",
      run: async () => {
        const report = await latest();
        check(report.rpcSent === true, "hostile plugin did not attempt an uncapped RPC");
        const attempts = await page.evaluate(
          () => (window as unknown as RigWindow).__rigRpcAttempts,
        );
        check(attempts.includes("theme.get"), "host did not observe the uncapped RPC");
        check(
          !bridge.dispatchCalls.some((call) => call.startsWith("i-hostile:")),
          "uncapped RPC was dispatched to the real adapter",
        );
      },
    },
    {
      name: "sibling-frame-dom-blocked",
      run: async () => {
        const report = await latest();
        check(report.siblingDom === "blocked", `sibling DOM was ${String(report.siblingDom)}`);
        const forged = await page.evaluate(() =>
          (window as unknown as RigWindow).__rigReports.some((entry) => entry.forged === true),
        );
        check(!forged, "host accepted a forged iid/source report");
        const sibling = await page.evaluate(() => {
          const frame = document.getElementById("sibling-frame") as HTMLIFrameElement | null;
          return frame?.contentDocument?.getElementById("sibling-secret")?.textContent ?? null;
        });
        check(sibling === "SIBLING-ONLY", "sibling pane was modified");
      },
    },
    {
      name: "navigate-popstate",
      run: async () => {
        const navigations = await page.evaluate(
          () => (window as unknown as RigWindow).__rigNavigations,
        );
        check(navigations.includes("/settings/general"), "host never saw the navigate envelope");
        check(bridge.navigateCalls > 0, "real adapter.onNavigate was not called");
        await page.waitForFunction(
          () =>
            (window as unknown as RigWindow).__rigReports.some((entry) =>
              Array.isArray(entry.routes) && entry.routes.includes("/settings/general"),
            ),
          null,
          { timeout: 5_000 },
        );
        await page.goBack();
        await page.waitForFunction(
          () =>
            (window as unknown as RigWindow).__rigReports.some((entry) =>
              Array.isArray(entry.routes) && entry.routes.includes("/"),
            ),
          null,
          { timeout: 5_000 },
        );
        const routes = await page.evaluate(() => (window as unknown as RigWindow).__rigRoutes);
        check(routes.includes("/"), "popstate did not produce a route for the host canvas");
        await page.goForward();
        check(page.url().endsWith("/app/i-hostile/settings/general"), "route was not restored");
      },
    },
    {
      name: "reload-restores",
      run: async () => {
        await page.reload();
        await page.evaluate(() => (window as unknown as RigWindow).__rigMount());
        await page.waitForFunction(
          () => (window as unknown as RigWindow).__rigReports.length > 0,
          null,
          { timeout: 10_000 },
        );
        const restored = await page.evaluate(() => {
          const win = window as unknown as RigWindow;
          return {
            pathname: window.location.pathname,
            initialRoute: win.__rigInitialRoute,
            frameSrc: document.getElementById("hostile-frame")?.getAttribute("src") ?? "",
            sentinel: document.getElementById("host-sentinel")?.textContent ?? null,
          };
        });
        check(
          restored.pathname === "/app/i-hostile/settings/general",
          `reload lost the deep link: ${restored.pathname}`,
        );
        check(restored.initialRoute === "/settings/general", "reload lost the initial route");
        check(
          restored.frameSrc.includes(encodeURIComponent("/settings/general")),
          `frame was not remounted with the route: ${restored.frameSrc}`,
        );
        check(restored.sentinel === "HOST-SENTINEL", "host DOM did not survive reload");
        const report = await latest();
        check(report.route === "/settings/general", "plugin did not start on the restored route");
      },
    },
  ];
}

function adapterCases(
  page: Page,
  adapter: HostAdapter,
  origins: TwoOrigins,
): Case[] {
  return [
    {
      // T10's duck-typed `storage` probe is skipped for real adapters: read the
      // value through the adapter's public interface from inside the browser.
      name: "adapter-storage-survives-upgrade",
      run: async () => {
        await adapter.dispatchRpc("storage.set", { key: "rig-key", value: "rig-value" }, UPGRADE_CTX);
        await adapter.setActiveVersion("hostile-widget", "2.0.0");
        const value = await page.evaluate(
          (ctx) =>
            (window as unknown as RigWindow).__rigDispatch("storage.get", "rig-key", ctx),
          { ...UPGRADE_CTX, version: "2.0.0", caps: ["storage.read"] },
        );
        check(value === "rig-value", `storage did not survive upgrade: ${String(value)}`);
      },
    },
    {
      name: "adapter-active-version-switch",
      run: async () => {
        await adapter.setActiveVersion("hostile-widget", "2.0.0");
        const versions = await page.evaluate(() =>
          (window as unknown as RigWindow).__rigGetActiveVersions(),
        );
        check(
          versions["hostile-widget"] === "2.0.0",
          `activeVersion was not switched: ${JSON.stringify(versions)}`,
        );
      },
    },
    {
      // Real FrameManager + real DomFrameHost + real adapter; no duck-typed
      // `destroyed` probe. The browser page is also cleaned up and stays alive.
      name: "unmount-destroys-frames",
      run: async () => {
        // jsdom is intentionally loaded lazily so importing ./conformance from
        // production code never requires a DOM shim at module-load time.
        // @ts-expect-error jsdom ships no bundled type declarations
        const { JSDOM } = await import("jsdom");
        const dom = new JSDOM("<!doctype html><body><div id='mount'></div></body>", {
          url: origins.hostOrigin,
        });
        const globals = globalThis as unknown as { window: unknown; document: unknown };
        const savedWindow = globals.window;
        const savedDocument = globals.document;
        globals.window = dom.window;
        globals.document = dom.window.document;
        try {
          const manager = createFrameManager({
            adapter,
            state: new HostState(new MemoryStore()),
          });
          const descriptor: PluginDescriptor = {
            id: "hostile-widget",
            version: "2.0.0",
            kind: "widget",
            entry: "index.html",
            capabilities: [],
            hostApi: "2",
          };
          const record = manager.createInstance(descriptor, "widget");
          const container = dom.window.document.getElementById("mount");
          check(container !== null, "jsdom mount point is missing");
          manager.mount(container, record.iid);
          check(container.querySelectorAll("iframe").length === 1, "frame was not mounted");
          manager.unmount(record.iid);
          check(container.querySelectorAll("iframe").length === 0, "frame survived unmount");
        } finally {
          globals.window = savedWindow;
          globals.document = savedDocument;
          dom.window.close();
        }

        await page.evaluate(() => (window as unknown as RigWindow).__rigUnmount());
        const remaining = await page.evaluate(
          () => document.querySelectorAll("#frames iframe").length,
        );
        check(remaining === 0, "browser frames survived unmount");
        const theme = await page.evaluate(
          (ctx) => (window as unknown as RigWindow).__rigDispatch("theme.get", undefined, ctx),
          { ...UPGRADE_CTX, caps: ["theme.read"] },
        );
        check(
          typeof theme === "object" && theme !== null &&
            (theme as { mode?: string }).mode === "dark",
          "host stopped serving RPCs after unmount",
        );
      },
    },
  ];
}

export async function runConformance(opts: ConformanceOptions): Promise<ConformanceResult> {
  const passed: string[] = [];
  const failed: Failure[] = [];

  try {
    const core = runCoreConformance({
      adapterFactory: opts.adapterFactory,
      frameHostFactory: () => new FakeFrameHost(),
      state: new HostState(new MemoryStore()),
    });
    passed.push(...core.passed);
    failed.push(...core.failed);
  } catch (err) {
    failed.push({ name: "core-conformance", error: errorOf(err) });
  }

  let origins: TwoOrigins | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    origins = await startTwoOrigins(opts.ports);
    browser = await chromium.launch();
    const page = await browser.newPage();
    const adapter = opts.adapterFactory();
    const bridge = await installBridge(page, adapter);

    await page.goto(`${origins.hostOrigin}/`);
    await page.evaluate(() => (window as unknown as RigWindow).__rigMount());
    await page.waitForFunction(
      () => (window as unknown as RigWindow).__rigReports.some((entry) => entry.crashed === true),
      null,
      { timeout: 10_000 },
    );

    await collect(browserCases(page, bridge), passed, failed);
    await collect(adapterCases(page, adapter, origins), passed, failed);
  } catch (err) {
    failed.push({ name: "browser-setup", error: errorOf(err) });
  } finally {
    if (browser !== undefined) await browser.close().catch(() => undefined);
    if (origins !== undefined) await origins.close().catch(() => undefined);
  }

  return { passed, failed };
}
