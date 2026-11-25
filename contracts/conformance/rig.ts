/**
 * Portable browser conformance rig (spec §13). The consumer supplies only an
 * `adapterFactory`: this module starts its own two HTTP origins, serves the
 * prebuilt hostile fixture, and drives the browser checks. No demo code, no
 * demo servers and no external HTTP packages.
 */

// Type-only import: erased at runtime, so importing ./conformance never
// requires the Playwright devDependency (only runConformance does).
import type { Browser, Page } from "@playwright/test";
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
  /** Called with the rig's real origins before any adapter is constructed. */
  onOrigins?: (origins: TwoOrigins) => void;
  /** Optional pre-started origins; when omitted the rig starts and owns them. */
  origins?: TwoOrigins;
  /**
   * Optional Playwright injection. A consumer whose test runner already
   * registered a physical copy of @playwright/test can pass its own `chromium`
   * instead of the rig loading a second copy.
   */
  playwright?: { chromium: typeof import("@playwright/test").chromium };
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

/**
 * Opaque, conformance-only identity. Consumer adapters treat it as a key; it
 * is never a plugin they must have registered or know how to resolve.
 */
const CONFORMANCE_PLUGIN = { id: "conformance-plugin", version: "1.0.0" } as const;
const UPGRADE_VERSION = "2.0.0";
const STORAGE_KEY = "rig-key";
const STORAGE_VALUE = "rig-value";

const UPGRADE_CTX: RpcContext = {
  iid: "i-upgrade",
  pluginId: CONFORMANCE_PLUGIN.id,
  version: CONFORMANCE_PLUGIN.version,
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
        // The value is written and read back by this case itself: no consumer
        // data or fixture-specific key format is assumed.
        await adapter.dispatchRpc(
          "storage.set", { key: STORAGE_KEY, value: STORAGE_VALUE }, UPGRADE_CTX,
        );
        await adapter.setActiveVersion(CONFORMANCE_PLUGIN.id, UPGRADE_VERSION);
        const value = await page.evaluate(
          ({ ctx, key }) =>
            (window as unknown as RigWindow).__rigDispatch("storage.get", key, ctx),
          {
            ctx: { ...UPGRADE_CTX, version: UPGRADE_VERSION, caps: ["storage.read"] },
            key: STORAGE_KEY,
          },
        );
        check(value === STORAGE_VALUE, `storage did not survive upgrade: ${String(value)}`);
      },
    },
    {
      name: "adapter-active-version-switch",
      run: async () => {
        await adapter.setActiveVersion(CONFORMANCE_PLUGIN.id, UPGRADE_VERSION);
        const versions = await page.evaluate(() =>
          (window as unknown as RigWindow).__rigGetActiveVersions(),
        );
        check(
          versions[CONFORMANCE_PLUGIN.id] === UPGRADE_VERSION,
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
            id: CONFORMANCE_PLUGIN.id,
            version: UPGRADE_VERSION,
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
        // Adapter-agnostic liveness probe: the theme value is intentionally
        // unconstrained by HostContext, so only require a defined result.
        const value = await page.evaluate(
          (ctx) => (window as unknown as RigWindow).__rigDispatch("theme.get", undefined, ctx),
          { ...UPGRADE_CTX, caps: ["theme.read"] },
        );
        check(
          value !== undefined && value !== null,
          "host stopped serving RPCs after unmount",
        );
      },
    },
  ];
}

export async function runConformance(opts: ConformanceOptions): Promise<ConformanceResult> {
  const passed: string[] = [];
  const failed: Failure[] = [];

  let origins: TwoOrigins | undefined;
  let browser: Browser | undefined;
  const ownsOrigins = opts.origins === undefined;
  try {
    // Origins are started (or supplied) before any adapterFactory call, so a
    // consumer can derive its plugin origin/frame base from the real rig.
    origins = opts.origins ?? (await startTwoOrigins(opts.ports));
    opts.onOrigins?.(origins);

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

    try {
      // Loaded lazily: core-only consumers never need @playwright/test.
      const playwright = opts.playwright ?? (await import("@playwright/test"));
      browser = await playwright.chromium.launch();
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
    }
  } catch (err) {
    failed.push({ name: "rig-setup", error: errorOf(err) });
  } finally {
    if (browser !== undefined) await browser.close().catch(() => undefined);
    if (ownsOrigins && origins !== undefined) await origins.close().catch(() => undefined);
  }

  return { passed, failed };
}
