import { describe, expect, it } from "vitest";
import { adaptV1Envelope } from "../src/host-core/adapters/v1.js";
import { HostState } from "../src/host-core/HostState.js";
import { MessageRouter } from "../src/host-core/MessageRouter.js";
import type { FrameHandle, RpcContext } from "../src/host-core/types.js";
import { getPolicy, type Envelope } from "../src/protocol/index.js";
import { runCoreConformance } from "./core.js";
import { FakeFrameHost, FakeScheduler, MemoryStore, sentOf } from "./fakes.js";
import { FixtureAdapter } from "./fixtures/adapter.js";

const ORIGIN = "http://plugin.test:4001";
const SANDBOX = "allow-scripts allow-same-origin allow-forms";

const ALL_CASES = [
  "envelope-roundtrip",
  "handshake-timeout",
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

function hello(iid: string, api: string, wants: string[] = []): Envelope {
  return {
    type: "hello",
    iid,
    api,
    sdk: "2.1.0",
    plugin: { id: "clock", version: "1.2.0" },
    wants,
  };
}

function rpc(iid: string, id: number, api: string, method: string, params?: unknown): Envelope {
  return params === undefined
    ? { type: "rpc", iid, id, api, method }
    : { type: "rpc", iid, id, api, method, params };
}

function mount(adapter: FixtureAdapter, iid: string, version: string, origin = ORIGIN): FrameHandle {
  const plugin = { id: "clock", version };
  const url = `${adapter.getPluginFrameBase(plugin)}?iid=${encodeURIComponent(iid)}`;
  const frameHost = new FakeFrameHost();
  const handle = frameHost.create({} as Element, url, SANDBOX, origin);
  handle.iid = iid;
  handle.pluginId = plugin.id;
  handle.version = version;
  handle.expectedOrigin = origin;
  handle.caps = [];
  handle.state = "handshake";
  return handle;
}

function deliver(
  router: MessageRouter,
  handle: FrameHandle,
  data: Envelope,
  overrides: { origin?: string; source?: FrameHandle["source"] } = {},
): void {
  router.accept({
    origin: overrides.origin ?? handle.expectedOrigin,
    source: overrides.source ?? handle.source,
    data,
    handle,
  });
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("runCoreConformance", () => {
  it("all core cases pass against fakes", () => {
    const result = runCoreConformance({
      adapterFactory: () => new FixtureAdapter(),
      frameHostFactory: () => new FakeFrameHost(),
      state: new HostState(new MemoryStore()),
    });

    expect(result.failed).toEqual([]);
    expect(result.passed).toEqual(expect.arrayContaining(ALL_CASES));
    expect(result.passed).toContain("v1-adapter-in-deprecation-window");
  });

  it("storage survives upgrade (same pluginId+iid)", () => {
    const adapter = new FixtureAdapter();
    adapter.storage.set("clock|i1|k", "v");
    void adapter.setActiveVersion("clock", "2.0.0");
    expect(adapter.storage.get("clock|i1|k")).toBe("v");
  });

  it("FixtureAdapter reports host meta and keeps active versions in memory", async () => {
    const adapter = new FixtureAdapter();
    const meta = adapter.getMeta();

    expect(meta.hostVersion).toBe("2.4.0");
    expect(meta.supportedMajors).toEqual(getPolicy().supported);
    expect(await adapter.getActiveVersions()).toEqual({});

    await adapter.setActiveVersion("clock", "2.0.0");
    expect(await adapter.getActiveVersions()).toEqual({ clock: "2.0.0" });
  });

  it("a navigate envelope calls onNavigate without producing an rpc.result", () => {
    const adapter = new FixtureAdapter();
    const handle = mount(adapter, "nav-i1", "2.0.0");
    const router = new MessageRouter({
      adapter,
      policy: getPolicy(),
      schedule: new FakeScheduler().schedule,
    });

    deliver(router, handle, hello("nav-i1", "2", ["navigate"]));
    deliver(router, handle, {
      type: "navigate",
      iid: "nav-i1",
      path: "/settings/general",
      replace: true,
    });
    deliver(router, handle, { type: "navigate", iid: "nav-i1", path: "/home" });

    expect(adapter.navigations).toEqual([
      { iid: "nav-i1", path: "/settings/general", replace: true },
      { iid: "nav-i1", path: "/home", replace: false },
    ]);
    expect(sentOf(handle).filter((e) => e.type === "rpc.result")).toEqual([]);
  });

  it("a navigate envelope requires a ready handle with the navigate capability", () => {
    const adapter = new FixtureAdapter();
    const schedule = new FakeScheduler().schedule;
    const router = new MessageRouter({ adapter, policy: getPolicy(), schedule });

    // Still in handshake: no navigation before hello.
    const early = mount(adapter, "nav-early", "2.0.0");
    deliver(router, early, { type: "navigate", iid: "nav-early", path: "/too-early" });
    expect(adapter.navigations).toEqual([]);

    // Ready, but the app capability was not granted.
    const denied = mount(adapter, "nav-denied", "2.0.0");
    deliver(router, denied, hello("nav-denied", "2", []));
    deliver(router, denied, { type: "navigate", iid: "nav-denied", path: "/denied" });
    expect(adapter.navigations).toEqual([]);

    // Ready with the cap: exactly one call with (iid, path, replace ?? false).
    const allowed = mount(adapter, "nav-allowed", "2.0.0");
    deliver(router, allowed, hello("nav-allowed", "2", ["navigate"]));
    deliver(router, allowed, {
      type: "navigate",
      iid: "nav-allowed",
      path: "/settings/general",
      replace: true,
    });
    expect(adapter.navigations).toEqual([
      { iid: "nav-allowed", path: "/settings/general", replace: true },
    ]);

    deliver(router, allowed, { type: "navigate", iid: "nav-allowed", path: "/home" });
    expect(adapter.navigations).toHaveLength(2);
    expect(adapter.navigations[1]).toEqual({ iid: "nav-allowed", path: "/home", replace: false });
  });

  it("default v1 path dispatches through adapter.dispatchRpc with hello-derived context", async () => {
    const adapter = new FixtureAdapter();
    const handle = mount(adapter, "v1-i1", "1.2.0");
    // Deliberately no injected adaptV1: the default dispatcher must be used.
    const router = new MessageRouter({
      adapter,
      policy: getPolicy(),
      schedule: new FakeScheduler().schedule,
    });

    deliver(router, handle, hello("v1-i1", "1", ["theme.read"]));
    const ready = sentOf(handle).at(-1);
    expect(ready?.type).toBe("ready");
    if (ready?.type === "ready") expect(ready.api).toBe("1");

    deliver(router, handle, rpc("v1-i1", 1, "1", "theme.get"));
    await settle();

    expect(adapter.dispatched).toHaveLength(1);
    expect(adapter.dispatched[0].method).toBe("theme.get");
    expect(adapter.dispatched[0].ctx).toEqual({
      iid: "v1-i1",
      pluginId: "clock",
      version: "1.2.0",
      caps: ["theme.read"],
    });
  });

  it("v1 envelope normalized by adaptV1Envelope reaches the injected dispatcher", async () => {
    const adapter = new FixtureAdapter();
    const contexts: RpcContext[] = [];
    const router = new MessageRouter({
      adapter,
      policy: getPolicy(),
      schedule: new FakeScheduler().schedule,
      adaptV1: async (_method, _params, ctx) => {
        contexts.push(ctx);
        return "legacy-value";
      },
    });
    const handle = mount(adapter, "v1-i2", "1.2.0");

    deliver(router, handle, hello("v1-i2", "1", ["theme.read"]));
    const synthetic: Envelope = {
      type: "rpc",
      iid: "v1-i2",
      id: 7,
      api: "1",
      method: "theme.get",
      params: { unit: "c" },
    };
    const normalized = adaptV1Envelope(synthetic);
    expect(normalized).toEqual(synthetic);

    deliver(router, handle, normalized);
    await settle();

    expect(contexts).toHaveLength(1);
    expect(contexts[0].iid).toBe("v1-i2");
    expect(adapter.dispatched).toHaveLength(0);
  });

  it("FixtureAdapter scopes storage by pluginId+iid, not by version", async () => {
    const adapter = new FixtureAdapter();
    const ctx: RpcContext = {
      iid: "i1",
      pluginId: "clock",
      version: "1.2.0",
      caps: ["storage.read", "storage.write"],
    };

    await adapter.dispatchRpc("storage.set", { key: "k", value: "v" }, ctx);
    expect(adapter.storage.get("clock|i1|k")).toBe(JSON.stringify("v"));

    await adapter.setActiveVersion("clock", "2.0.0");
    expect(await adapter.dispatchRpc("storage.get", "k", { ...ctx, version: "2.0.0" })).toBe("v");

    await adapter.dispatchRpc("storage.remove", "k", ctx);
    expect(adapter.storage.has("clock|i1|k")).toBe(false);
  });

  it("FakeFrameHost and FakeScheduler are deterministic", () => {
    const frameHost = new FakeFrameHost();
    const handle = frameHost.create(
      {} as Element,
      `${ORIGIN}/plugins/clock?iid=i1`,
      SANDBOX,
      ORIGIN,
    );
    expect(handle.iid).toBe("i1");
    expect(frameHost.created).toEqual([handle]);
    frameHost.destroy(handle);
    expect(frameHost.destroyed).toEqual([handle]);

    const scheduler = new FakeScheduler();
    let fired = 0;
    const cancel = scheduler.schedule(() => void fired++, 5000);
    expect(scheduler.timers).toHaveLength(1);
    scheduler.fire(1000);
    expect(fired).toBe(0);
    scheduler.fire(5000);
    expect(fired).toBe(1);
    cancel();
    scheduler.fire(5000);
    expect(fired).toBe(1);
  });
});
