import { beforeEach, describe, expect, it, vi } from "vitest";
import { decodeEnvelope, type CompatibilityPolicy, type Envelope } from "../protocol/index.js";
import { DomFrameHost, type FrameHost, type FrameHostMessage } from "./FrameHost.js";
import { createFrameManager, type FrameManager } from "./FrameManager.js";
import { CURRENT_APP_KEY, type KeyValueStore } from "./HostState.js";
import type { LayoutNode } from "./layout.js";
import type {
  FrameHandle,
  FrameSourceRef,
  HostAdapter,
  HostContext,
  HostMeta,
  InstanceRef,
  RpcContext,
} from "./types.js";

const POLICY: CompatibilityPolicy = {
  current: 2,
  supported: ["2", "1"],
  deprecated: { "1": { sunset: "host@3.0.0", adapter: "adapters/v1.ts" } },
  matrix: {},
};

const ALL_CAPS = [
  "context.read",
  "theme.read",
  "notify",
  "navigate",
  "storage.read",
  "storage.write",
  "log",
  "events.read",
  "registry.read",
];

const META: HostMeta = {
  supportedMajors: ["2", "1"],
  deprecated: { "1": { sunset: "host@3.0.0" } },
  sunset: "host@3.0.0",
  capsCatalogue: ALL_CAPS,
  hostVersion: "2.4.0",
};

const CONTEXT: HostContext = {
  theme: "dark",
  locale: "en-US",
  user: { id: "u1", displayName: "Ada" },
  hostVersion: "2.4.0",
};

const descriptor = (id: string, version: string) => ({
  id,
  version,
  kind: "widget" as const,
  entry: `/plugins/${id}/index.html`,
  capabilities: [] as string[],
  hostApi: "^2",
});

class MemoryStore implements KeyValueStore {
  private readonly data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
}

class FakeAdapter implements HostAdapter {
  activeVersions: Record<string, string> = { clock: "1.2.0", notes: "1.0.0" };
  readonly setCalls: Array<{ pluginId: string; version: string }> = [];
  readonly dispatched: Array<{ method: string; params: unknown; ctx: RpcContext }> = [];

  getMeta(): HostMeta {
    return META;
  }
  getContext(): HostContext {
    return CONTEXT;
  }
  grantCapabilities(requested: string[], _ref: InstanceRef): string[] {
    return requested.filter((cap) => ALL_CAPS.includes(cap));
  }
  async dispatchRpc(method: string, params: unknown, ctx: RpcContext): Promise<unknown> {
    this.dispatched.push({ method, params, ctx });
    return { method, params };
  }
  onNavigate(): void {}
  getPluginOrigin(plugin: { id: string; version: string }): string {
    return `http://${plugin.id}:4001`;
  }
  getPluginFrameBase(plugin: { id: string; version: string }): string {
    return `http://p:4001/plugins/${plugin.id}/${plugin.version}`;
  }
  async getActiveVersions(): Promise<Record<string, string>> {
    return { ...this.activeVersions };
  }
  async setActiveVersion(pluginId: string, version: string): Promise<void> {
    this.setCalls.push({ pluginId, version });
    this.activeVersions[pluginId] = version;
  }
}

class FakeSource implements FrameSourceRef {
  readonly sent: Array<{ data: string; origin: string }> = [];
  constructor(readonly id: string) {}
  postMessage(data: string, targetOrigin: string): void {
    this.sent.push({ data, origin: targetOrigin });
  }
  last(): Envelope | undefined {
    const entry = this.sent.at(-1);
    return entry === undefined ? undefined : decodeEnvelope(entry.data);
  }
}

class FakeFrameHost implements FrameHost {
  lastUrl = "";
  lastSandbox = "";
  lastExpectedOrigin = "";
  readonly created: Array<{
    container: Element;
    url: string;
    sandbox: string;
    expectedOrigin: string;
    handle: FrameHandle;
  }> = [];
  readonly destroyed: FrameHandle[] = [];
  private callback: ((e: FrameHostMessage) => void) | null = null;
  private readonly sources = new Map<string, FakeSource>();

  create(
    container: Element,
    url: string,
    sandbox: string,
    expectedOrigin: string,
  ): FrameHandle {
    this.lastUrl = url;
    this.lastSandbox = sandbox;
    this.lastExpectedOrigin = expectedOrigin;
    const iid = new URL(url).searchParams.get("iid")!;
    const source = new FakeSource(`win-${iid}`);
    this.sources.set(iid, source);
    const handle: FrameHandle = {
      iid,
      expectedOrigin,
      source,
      pluginId: "",
      version: "",
      caps: [],
      state: "handshake",
    };
    this.created.push({ container, url, sandbox, expectedOrigin, handle });
    return handle;
  }

  destroy(handle: FrameHandle): void {
    this.destroyed.push(handle);
    this.sources.delete(handle.iid);
  }

  onMessage(cb: (e: FrameHostMessage) => void): void {
    this.callback = cb;
  }

  deliver(iid: string, origin: string, data: unknown): void {
    this.callback?.({
      iid,
      origin,
      source: this.sources.get(iid)!,
      data,
    });
  }

  sourceOf(iid: string): FakeSource {
    return this.sources.get(iid)!;
  }

  handleOf(iid: string): FrameHandle {
    return this.created.filter((c) => c.handle.iid === iid).at(-1)!.handle;
  }
}

function findLeaf(root: LayoutNode | null, iid: string): Extract<LayoutNode, { type: "leaf" }> | null {
  if (!root) return null;
  if (root.type === "leaf") return root.iid === iid ? root : null;
  return findLeaf(root.a, iid) ?? findLeaf(root.b, iid);
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

let adapter: FakeAdapter;
let frameHost: FakeFrameHost;
let container: Element;

beforeEach(() => {
  localStorage.clear();
  adapter = new FakeAdapter();
  frameHost = new FakeFrameHost();
  container = document.createElement("div");
  document.body.appendChild(container);
  vi.restoreAllMocks();
});

describe("FrameManager instance lifecycle", () => {
  it("mount creates iframe with correct sandbox and only iid/route in URL", () => {
    const fm = createFrameManager({ adapter, frameHost, policy: POLICY });
    const rec = fm.createInstance(descriptor("clock", "2.0.0"), "widget");
    const h = fm.mount(container, rec.iid);

    expect(frameHost.lastUrl).toContain("?iid=" + rec.iid);
    expect(frameHost.lastUrl).not.toContain("api=");
    expect(frameHost.lastSandbox).toBe("allow-scripts allow-same-origin allow-forms");
    expect(h.iid).toBe(rec.iid);
    expect(h.expectedOrigin).toBe("http://clock:4001");
  });

  it("builds the URL from the core with only iid and route, no api", () => {
    const fm = createFrameManager({ adapter, frameHost: frameHost, policy: POLICY });
    const rec = fm.createInstance(descriptor("notes", "1.0.0"), "app", "/list");
    const h = fm.mount(container, rec.iid, "/settings");

    const query = new URL(frameHost.lastUrl).searchParams;
    expect([...query.keys()].sort()).toEqual(["iid", "route"]);
    expect(query.get("iid")).toBe(rec.iid);
    expect(query.get("route")).toBe("/settings");
    expect(frameHost.lastUrl).not.toContain("api=");
  });

  it("mount requires an already registered iid", () => {
    const fm = createFrameManager({ adapter, frameHost, policy: POLICY });
    expect(() => fm.mount(container, "missing")).toThrow(/missing/);
    expect(frameHost.created).toHaveLength(0);
  });

  it("unmount destroys the frame and tears down the router state", () => {
    const fm = createFrameManager({ adapter, frameHost, policy: POLICY });
    const rec = fm.createInstance(descriptor("clock", "2.0.0"), "widget");
    const handle = fm.mount(container, rec.iid);
    frameHost.deliver(rec.iid, handle.expectedOrigin, {
      type: "hello",
      iid: rec.iid,
      api: "2",
      sdk: "2.1.0",
      plugin: { id: "clock", version: "2.0.0" },
      wants: ["events.read"],
    });
    expect(handle.state).toBe("ready");

    fm.unmount(rec.iid);

    expect(frameHost.destroyed).toContain(handle);
    expect(handle.state).toBe("destroyed");
    frameHost.deliver(rec.iid, handle.expectedOrigin, {
      type: "rpc",
      iid: rec.iid,
      id: 1,
      api: "2",
      method: "theme.get",
    });
    expect(adapter.dispatched).toHaveLength(0);
  });

  it("activateApp reuses an existing app iid and persists the pointer", () => {
    const fm = createFrameManager({ adapter, frameHost, policy: POLICY });
    const app = fm.createInstance(descriptor("notes", "1.0.0"), "app", "/deep/link");
    const widget = fm.createInstance(descriptor("clock", "2.0.0"), "widget");
    const before = Object.keys(fm.state.getInstances());

    fm.activateApp(app.iid);

    expect(Object.keys(fm.state.getInstances())).toEqual(before);
    expect(fm.state.getInstances()[app.iid].route).toBe("/deep/link");
    expect(fm.state.getInstances()[widget.iid].kind).toBe("widget");
    expect(localStorage.getItem(CURRENT_APP_KEY)).toBe(app.iid);
    expect(() => fm.activateApp(widget.iid)).toThrow();
    expect(() => fm.activateApp("missing")).toThrow();
  });
});

describe("FrameManager router wiring", () => {
  it("delivers accepted messages to the router with the right handle", () => {
    const fm = createFrameManager({ adapter, frameHost, policy: POLICY });
    const rec = fm.createInstance(descriptor("clock", "2.0.0"), "widget");
    const handle = fm.mount(container, rec.iid);

    frameHost.deliver(rec.iid, "http://evil", {
      type: "hello",
      iid: rec.iid,
      api: "2",
      sdk: "2.1.0",
      plugin: { id: "clock", version: "2.0.0" },
      wants: ["theme.read"],
    });
    expect(handle.state).toBe("handshake");

    frameHost.deliver(rec.iid, handle.expectedOrigin, {
      type: "hello",
      iid: rec.iid,
      api: "2",
      sdk: "2.1.0",
      plugin: { id: "clock", version: "2.0.0" },
      wants: ["theme.read"],
    });
    expect(handle.state).toBe("ready");
    expect(frameHost.sourceOf(rec.iid).last()).toMatchObject({ type: "ready", api: "2" });
  });

  it("publish reaches ready subscribers through the router", async () => {
    const fm = createFrameManager({ adapter, frameHost, policy: POLICY });
    const rec = fm.createInstance(descriptor("clock", "2.0.0"), "widget");
    const handle = fm.mount(container, rec.iid);
    frameHost.deliver(rec.iid, handle.expectedOrigin, {
      type: "hello",
      iid: rec.iid,
      api: "2",
      sdk: "2.1.0",
      plugin: { id: "clock", version: "2.0.0" },
      wants: ["events.read"],
    });
    frameHost.deliver(rec.iid, handle.expectedOrigin, {
      type: "rpc",
      iid: rec.iid,
      id: 1,
      api: "2",
      method: "events.on",
      params: { topic: "tick" },
    });
    await settle();

    fm.publish("tick", 42);

    expect(frameHost.sourceOf(rec.iid).last()).toEqual({
      type: "event",
      iid: rec.iid,
      topic: "tick",
      value: 42,
    });
  });

  it("passes an injected adaptV1 through to the router", async () => {
    const adaptV1 = vi.fn(async (method: string) => ({ legacy: method }));
    const fm = createFrameManager({ adapter, frameHost, policy: POLICY, adaptV1 });
    const rec = fm.createInstance(descriptor("clock", "2.0.0"), "widget");
    const handle = fm.mount(container, rec.iid);
    frameHost.deliver(rec.iid, handle.expectedOrigin, {
      type: "hello",
      iid: rec.iid,
      api: "1",
      sdk: "1.4.0",
      plugin: { id: "clock", version: "2.0.0" },
      wants: ["theme.read"],
    });
    frameHost.deliver(rec.iid, handle.expectedOrigin, {
      type: "rpc",
      iid: rec.iid,
      id: 3,
      api: "2",
      method: "theme.get",
    });
    await settle();

    expect(adaptV1).toHaveBeenCalledWith("theme.get", undefined, expect.any(Object));
    expect(frameHost.sourceOf(rec.iid).last()).toMatchObject({
      ok: true,
      value: { legacy: "theme.get" },
    });
  });
});

describe("FrameManager upgrade and restore", () => {
  it("upgrade preserves iid and BSP position", async () => {
    const fm = createFrameManager({ adapter, frameHost, policy: POLICY });
    const rec = fm.createInstance(descriptor("clock", "1.2.0"), "widget");
    fm.mount(container, rec.iid);
    const before = findLeaf(fm.state.getLayout()!, rec.iid);

    adapter.activeVersions.clock = "2.0.0";
    await fm.upgrade("clock", "2.0.0");

    expect(adapter.setCalls).toEqual([{ pluginId: "clock", version: "2.0.0" }]);
    expect(findLeaf(fm.state.getLayout()!, rec.iid)?.iid).toBe(before?.iid);
    expect(findLeaf(fm.state.getLayout()!, rec.iid)?.version).toBe("2.0.0");
    expect(fm.state.getInstances()[rec.iid].version).toBe("2.0.0");
    expect(new URL(frameHost.lastUrl).pathname).toContain("/2.0.0");
    expect(frameHost.destroyed.map((h) => h.iid)).toContain(rec.iid);
  });

  it("restore reconciles cached versions and rebuilds only stale mounted frames", async () => {
    const fm = createFrameManager({ adapter, frameHost, policy: POLICY });
    const stale = fm.createInstance(descriptor("clock", "1.2.0"), "widget");
    const fresh = fm.createInstance(descriptor("notes", "1.0.0"), "widget");
    fm.mount(container, stale.iid);
    fm.mount(container, fresh.iid);
    const staleLeafBefore = findLeaf(fm.state.getLayout()!, stale.iid);

    adapter.activeVersions.clock = "2.0.0";
    await fm.restore();

    expect(findLeaf(fm.state.getLayout()!, stale.iid)?.iid).toBe(staleLeafBefore?.iid);
    expect(findLeaf(fm.state.getLayout()!, stale.iid)?.version).toBe("2.0.0");
    expect(frameHost.destroyed.map((h) => h.iid)).toEqual([stale.iid]);
    expect(new URL(frameHost.lastUrl).searchParams.get("iid")).toBe(stale.iid);
    expect(new URL(frameHost.lastUrl).pathname).toContain("/2.0.0");
  });
});

describe("DomFrameHost", () => {
  it("creates a sandboxed iframe and maps its source back to the iid", () => {
    const adapter = new FakeAdapter();
    const host = new DomFrameHost(adapter);
    const received: FrameHostMessage[] = [];
    host.onMessage((e) => received.push(e));

    const handle = host.create(
      container,
      "http://p:4001/plugins/clock/2.0.0?iid=i42&route=%2Flist",
      "allow-scripts allow-same-origin allow-forms",
      "http://clock:4001",
    );

    const iframe = container.querySelector("iframe")!;
    expect(iframe.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin allow-forms");
    expect(iframe.getAttribute("src")).toBe(
      "http://p:4001/plugins/clock/2.0.0?iid=i42&route=%2Flist",
    );
    expect(handle.iid).toBe("i42");
    expect(handle.expectedOrigin).toBe("http://clock:4001");

    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "hello", iid: "i42" },
        origin: "http://clock:4001",
        source: iframe.contentWindow,
      }),
    );

    expect(received).toHaveLength(1);
    expect(received[0].iid).toBe("i42");
    expect(received[0].source).toBe(handle.source);
    expect(received[0].origin).toBe("http://clock:4001");
  });

  it("supports a container attached to the document after create", () => {
    const host = new DomFrameHost(new FakeAdapter());
    const received: FrameHostMessage[] = [];
    host.onMessage((e) => received.push(e));

    const detached = document.createElement("div");
    host.create(
      detached,
      "http://p:4001/plugins/clock/2.0.0?iid=i9",
      "allow-scripts allow-same-origin allow-forms",
      "http://clock:4001",
    );
    document.body.appendChild(detached);
    window.dispatchEvent(
      new MessageEvent("message", {
        data: "late",
        origin: "http://clock:4001",
        source: detached.querySelector("iframe")!.contentWindow,
      }),
    );

    expect(received.map((e) => e.iid)).toEqual(["i9"]);
  });

  it("ignores messages from frames it does not own", () => {
    const host = new DomFrameHost(new FakeAdapter());
    const received: FrameHostMessage[] = [];
    host.onMessage((e) => received.push(e));

    host.create(
      container,
      "http://p:4001/plugins/clock/2.0.0?iid=i1",
      "allow-scripts allow-same-origin allow-forms",
      "http://clock:4001",
    );
    window.dispatchEvent(
      new MessageEvent("message", {
        data: "foreign",
        origin: "http://clock:4001",
        source: window,
      }),
    );

    expect(received).toEqual([]);
  });
});
