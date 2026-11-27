import type {
  HostContext,
  InstanceRef,
  PluginDescriptorDTO,
  RpcContext,
} from "@vibe/plugin-contracts/host-core";
import { getMeta, getPolicy } from "@vibe/plugin-contracts/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DemoHostAdapter,
  type DemoAdapterConfig,
  type KeyValueStore,
  type RegistryTransport,
} from "./DemoHostAdapter.js";

const PLUGIN_ORIGIN = "http://localhost:4001";
const HOST_VERSION = "9.9.9-test";

interface TestStore extends KeyValueStore {
  data: Map<string, string>;
  removeItem(k: string): void;
}

function memoryStore(): TestStore {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => {
      data.set(k, v);
    },
    removeItem: (k) => {
      data.delete(k);
    },
  };
}

function memoryRegistry(
  active: Record<string, string> = { clock: "1.2.0" },
  versions: PluginDescriptorDTO[] = [],
): RegistryTransport {
  const state = new Map(Object.entries(active));
  return {
    getActiveVersions: async () => Object.fromEntries(state),
    setActiveVersion: async (id, v) => {
      state.set(id, v);
    },
    list: async () => versions,
  };
}

function makeConfig(overrides: Partial<DemoAdapterConfig> = {}) {
  const store = memoryStore();
  const registry = memoryRegistry();
  const cfg: DemoAdapterConfig = {
    pluginOrigin: PLUGIN_ORIGIN,
    frameBase: (d) => `${PLUGIN_ORIGIN}/plugins/${d.id}/${d.version}`,
    registry,
    store,
    hostVersion: HOST_VERSION,
    ...overrides,
  };
  return { cfg, store, registry };
}

function ctx(overrides: Partial<RpcContext> = {}): RpcContext {
  return { iid: "i1", pluginId: "clock", version: "1.2.0", caps: [], ...overrides };
}

const ref: InstanceRef = { iid: "i1", pluginId: "clock", version: "1.2.0" };

describe("DemoHostAdapter", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("storage is keyed by pluginId+iid and survives version change", async () => {
    const { cfg, store } = makeConfig();
    const a = new DemoHostAdapter(cfg);

    await a.dispatchRpc("storage.set", { key: "k", value: "v" }, ctx({ version: "1.2.0", caps: ["storage.write"] }));
    const got = await a.dispatchRpc(
      "storage.get",
      { key: "k" },
      ctx({ version: "2.0.0", caps: ["storage.read"] }),
    );

    expect(got).toBe("v");
    expect(store.getItem("clock|i1|k")).toBe(JSON.stringify("v"));
  });

  it("getMeta is sync and comes from the exported policy", () => {
    const { cfg } = makeConfig();
    const a = new DemoHostAdapter(cfg);

    expect(a.getMeta().supportedMajors).toEqual(["2", "1"]);
    expect(a.getMeta().capsCatalogue).toEqual(getMeta(getPolicy()).capsCatalogue);
    expect(a.getMeta().hostVersion).toBe(HOST_VERSION);
  });

  it("getMeta returns a fresh object and does not mutate the bundled policy", () => {
    const { cfg } = makeConfig();
    const a = new DemoHostAdapter(cfg);
    const before = getPolicy().supported.slice();

    const meta = a.getMeta();
    meta.supportedMajors.push("9");

    expect(getPolicy().supported).toEqual(before);
    expect(a.getMeta().supportedMajors).toEqual(["2", "1"]);
  });

  it("getPluginOrigin and getPluginFrameBase are per-descriptor from the config", () => {
    const { cfg } = makeConfig();
    const a = new DemoHostAdapter(cfg);
    const plugin = { id: "clock", version: "1.2.0" };

    expect(a.getPluginOrigin(plugin)).toBe("http://localhost:4001");
    expect(a.getPluginFrameBase(plugin)).toBe("http://localhost:4001/plugins/clock/1.2.0");
  });

  it("devPlugins override origin and frame base per id", () => {
    const { cfg } = makeConfig({
      devPlugins: [{ id: "clock", origin: "http://localhost:5173" }],
    });
    const a = new DemoHostAdapter(cfg);

    expect(a.getPluginOrigin({ id: "clock", version: "1.2.0" })).toBe("http://localhost:5173");
    expect(a.getPluginFrameBase({ id: "clock", version: "1.2.0" })).toBe(
      "http://localhost:5173/index.html",
    );
    // Neighbours are untouched.
    expect(a.getPluginOrigin({ id: "notes", version: "1.0.0" })).toBe(PLUGIN_ORIGIN);
    expect(a.getPluginFrameBase({ id: "notes", version: "1.0.0" })).toBe(
      "http://localhost:4001/plugins/notes/1.0.0",
    );
  });

  it("grantCapabilities intersects the request with the catalogue", () => {
    const { cfg } = makeConfig();
    const a = new DemoHostAdapter(cfg);

    expect(a.grantCapabilities(["theme.read", "bogus", "notify", "bogus2"], ref)).toEqual([
      "theme.read",
      "notify",
    ]);
  });

  it("getContext returns concrete host values", () => {
    const { cfg } = makeConfig();
    const a = new DemoHostAdapter(cfg);
    const c: HostContext = a.getContext();

    expect(c).toEqual({
      theme: "dark",
      locale: "en-US",
      user: { id: "u1", displayName: "Ada" },
      hostVersion: HOST_VERSION,
    });
  });

  it("dispatchRpc serves theme.get, notify.show and host.log", async () => {
    const { cfg } = makeConfig();
    const a = new DemoHostAdapter(cfg);

    expect(await a.dispatchRpc("theme.get", undefined, ctx())).toEqual({ mode: "dark" });
    await expect(a.dispatchRpc("notify.show", { level: "info", message: "hi" }, ctx())).resolves.toBe(true);
    await expect(a.dispatchRpc("host.log", { level: "warn", args: ["a"] }, ctx())).resolves.toBe(true);
  });

  it("getTheme feeds context.get and theme.get; without it the theme stays dark", async () => {
    let theme = "light";
    const { cfg } = makeConfig({ getTheme: () => theme });
    const a = new DemoHostAdapter(cfg);

    expect(a.getContext().theme).toBe("light");
    expect(await a.dispatchRpc("theme.get", undefined, ctx())).toEqual({ mode: "light" });

    theme = "dark";
    expect(await a.dispatchRpc("theme.get", undefined, ctx())).toEqual({ mode: "dark" });
  });

  it("notify.show is forwarded to onNotify with its RPC context", async () => {
    const onNotify = vi.fn();
    const { cfg } = makeConfig({ onNotify });
    const a = new DemoHostAdapter(cfg);
    const context = ctx({ caps: ["notify"] });

    await a.dispatchRpc("notify.show", { level: "warn", message: "disk almost full" }, context);

    expect(onNotify).toHaveBeenCalledWith({ level: "warn", message: "disk almost full" }, context);
  });

  it("notify.show without onNotify still resolves and defaults missing fields", async () => {
    const onNotify = vi.fn();
    const { cfg } = makeConfig({ onNotify });
    const a = new DemoHostAdapter(cfg);

    await expect(a.dispatchRpc("notify.show", undefined, ctx())).resolves.toBe(true);
    expect(onNotify).toHaveBeenCalledWith({ level: "info", message: "" }, ctx());
  });

  it("storage.set/get/remove round-trip JSON values with string or object params", async () => {
    const { cfg } = makeConfig();
    const a = new DemoHostAdapter(cfg);

    await a.dispatchRpc("storage.set", { key: "k", value: { a: 1 } }, ctx());
    expect(await a.dispatchRpc("storage.get", "k", ctx())).toEqual({ a: 1 });

    await a.dispatchRpc("storage.remove", "k", ctx());
    expect(await a.dispatchRpc("storage.get", "k", ctx())).toBeNull();
  });

  it("dispatchRpc registry.list delegates to the registry transport", async () => {
    const versions: PluginDescriptorDTO[] = [
      {
        id: "clock",
        version: "1.2.0",
        kind: "widget",
        title: "Clock",
        icon: "clock.svg",
        capabilities: ["theme.read"],
        hostApi: "^2",
        unsupported: false,
      },
    ];
    const { cfg } = makeConfig({ registry: memoryRegistry({ clock: "1.2.0" }, versions) });
    const list = vi.spyOn(cfg.registry, "list");
    const a = new DemoHostAdapter(cfg);

    expect(await a.dispatchRpc("registry.list", undefined, ctx())).toEqual(versions);
    expect(list).toHaveBeenCalledOnce();
  });

  it("unknown RPC methods reject with code unknown_method", async () => {
    const { cfg } = makeConfig();
    const a = new DemoHostAdapter(cfg);

    await expect(a.dispatchRpc("does.not.exist", undefined, ctx())).rejects.toMatchObject({
      code: "unknown_method",
    });
  });

  it("active versions are delegated to the registry transport", async () => {
    const { cfg, registry } = makeConfig();
    const set = vi.spyOn(registry, "setActiveVersion");
    const a = new DemoHostAdapter(cfg);

    expect(await a.getActiveVersions()).toEqual({ clock: "1.2.0" });
    await a.setActiveVersion("clock", "2.0.0");
    expect(set).toHaveBeenCalledWith("clock", "2.0.0");
    expect(await a.getActiveVersions()).toEqual({ clock: "2.0.0" });
  });

  it("onNavigate pushes /app/<iid>/<path> via history by default", () => {
    const { cfg } = makeConfig();
    const a = new DemoHostAdapter(cfg);

    a.onNavigate("i1", "settings", false);
    expect(window.location.pathname).toBe("/app/i1/settings");
  });

  it("onNavigate honors replace: pushState for false, replaceState for true", () => {
    const { cfg } = makeConfig();
    const a = new DemoHostAdapter(cfg);
    const push = vi.spyOn(window.history, "pushState");
    const replace = vi.spyOn(window.history, "replaceState");

    a.onNavigate("i7", "/settings", false);
    expect(push).toHaveBeenCalledWith(null, "", "/app/i7/settings");
    expect(replace).not.toHaveBeenCalled();

    a.onNavigate("i7", "/settings", true);
    expect(replace).toHaveBeenCalledWith(null, "", "/app/i7/settings");
    expect(push).toHaveBeenCalledTimes(1);
  });

  it("onNavigate uses the injected callback when provided", () => {
    const onNavigate = vi.fn();
    const { cfg } = makeConfig({ onNavigate });
    const a = new DemoHostAdapter(cfg);

    a.onNavigate("i7", "/settings", true);
    expect(onNavigate).toHaveBeenCalledWith("i7", "/settings", true);
    expect(window.location.pathname).toBe("/");
  });
});
