import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HostState,
  INSTANCES_KEY,
  LAYOUT_KEY,
  type KeyValueStore,
} from "./HostState.js";
import { createInstanceRecord } from "./instances.js";
import type { LayoutNode } from "./layout.js";

type Leaf = Extract<LayoutNode, { type: "leaf" }>;

class MemoryStore implements KeyValueStore {
  private readonly data = new Map<string, string>();

  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
}

function findLeaf(root: LayoutNode | null, iid: string): Leaf | null {
  if (!root) return null;
  if (root.type === "leaf") return root.iid === iid ? root : null;
  return findLeaf(root.a, iid) ?? findLeaf(root.b, iid);
}

function leaves(root: LayoutNode | null): Leaf[] {
  if (!root) return [];
  return root.type === "leaf" ? [root] : [...leaves(root.a), ...leaves(root.b)];
}

let store: MemoryStore;

beforeEach(() => {
  store = new MemoryStore();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createInstanceRecord", () => {
  it("allocates a unique iid and keeps the exact record shape", () => {
    const widget = createInstanceRecord("clock", "1.2.0", "widget");
    const app = createInstanceRecord("notes", "1.0.0", "app", "/list");

    expect(widget.iid).toBeTruthy();
    expect(widget.iid).not.toBe(app.iid);
    expect(widget).toEqual({
      iid: widget.iid,
      pluginId: "clock",
      version: "1.2.0",
      kind: "widget",
    });
    expect(app).toEqual({
      iid: app.iid,
      pluginId: "notes",
      version: "1.0.0",
      kind: "app",
      route: "/list",
    });
  });
});

describe("HostState registry and layout ownership", () => {
  it("createInstance allocates iid and persists registry", () => {
    const st = new HostState(store);
    const r = st.addWidget("clock", "1.2.0");

    expect(r.iid).toBeTruthy();
    expect(new HostState(store).getInstances()[r.iid]).toEqual(r);
    expect(store.getItem(INSTANCES_KEY)).toContain(r.iid);
    expect(findLeaf(st.getLayout(), r.iid)?.version).toBe("1.2.0");
    expect(restoreLayoutFromStore().some((leaf) => leaf.iid === r.iid)).toBe(true);
  });

  function restoreLayoutFromStore(): Leaf[] {
    return leaves(new HostState(store).getLayout());
  }

  it("allocates distinct iids and inserts every widget into the layout", () => {
    const st = new HostState(store);
    const a = st.addWidget("clock", "1.2.0");
    const b = st.addWidget("notes", "1.0.0");

    expect(a.iid).not.toBe(b.iid);
    expect(leaves(st.getLayout()).map((leaf) => leaf.iid)).toEqual([a.iid, b.iid]);
    expect(Object.keys(st.getInstances())).toEqual([a.iid, b.iid]);
  });

  it("apps are not BSP leaves", () => {
    const st = new HostState(store);
    st.addWidget("clock", "1.2.0");
    const layoutBefore = st.getLayout();
    const app = st.openApp("notes", "1.0.0", "/list");

    expect(findLeaf(st.getLayout(), app.iid)).toBeNull();
    expect(st.getInstances()[app.iid].kind).toBe("app");
    expect(st.getInstances()[app.iid].route).toBe("/list");
    expect(st.getLayout()).toBe(layoutBefore);
    expect(new HostState(store).getInstances()[app.iid]).toEqual(app);
  });

  it("removeWidget drops the record and its layout leaf, keeping other widgets", () => {
    const st = new HostState(store);
    const a = st.addWidget("clock", "1.2.0");
    const b = st.addWidget("notes", "1.0.0");

    st.removeWidget(a.iid);

    expect(findLeaf(st.getLayout(), a.iid)).toBeNull();
    expect(st.getInstances()[a.iid]).toBeUndefined();
    expect(findLeaf(st.getLayout(), b.iid)?.pluginId).toBe("notes");
    const reloaded = new HostState(store);
    expect(findLeaf(reloaded.getLayout(), a.iid)).toBeNull();
    expect(reloaded.getInstances()[a.iid]).toBeUndefined();
    expect(reloaded.getInstances()[b.iid]).toEqual(st.getInstances()[b.iid]);
  });

  it("resize delegates to the BSP tree and persists the new ratio", () => {
    const st = new HostState(store);
    st.addWidget("clock", "1.2.0");
    st.addWidget("notes", "1.0.0");

    st.resize("", 0.7);

    expect(st.getLayout()).toMatchObject({ ratio: 0.7 });
    expect(new HostState(store).getLayout()).toMatchObject({ ratio: 0.7 });
  });

  it("closeApp clears the current app record without touching the widget layout", () => {
    const st = new HostState(store);
    const widget = st.addWidget("clock", "1.2.0");
    const app = st.openApp("notes", "1.0.0", "/list");

    st.closeApp();

    expect(st.getInstances()[app.iid]).toBeUndefined();
    expect(st.getInstances()[widget.iid].kind).toBe("widget");
    expect(findLeaf(st.getLayout(), widget.iid)).not.toBeNull();
    expect(findLeaf(st.getLayout(), app.iid)).toBeNull();
    expect(new HostState(store).getInstances()[app.iid]).toBeUndefined();
    expect(() => st.closeApp()).not.toThrow();
  });

  it("setVersion updates widget leaves and instance records", () => {
    const st = new HostState(store);
    const widget = st.addWidget("clock", "1.2.0");
    const app = st.openApp("notes", "1.0.0", "/list");

    st.setVersion("notes", "2.0.0");

    expect(st.getInstances()[app.iid].version).toBe("2.0.0");
    expect(st.getInstances()[widget.iid].version).toBe("1.2.0");
    expect(findLeaf(st.getLayout(), widget.iid)?.version).toBe("1.2.0");
    const reloaded = new HostState(store);
    expect(reloaded.getInstances()[app.iid].version).toBe("2.0.0");
  });

  it("reconcile detects stale cached version after backend change", () => {
    const st = new HostState(store);
    const w = st.addWidget("clock", "1.2.0");

    expect(st.reconcile({ clock: "2.0.0" })).toEqual([w.iid]);
    expect(findLeaf(st.getLayout(), w.iid)?.version).toBe("2.0.0");
    expect(st.getInstances()[w.iid].version).toBe("2.0.0");
    expect(st.reconcile({ clock: "2.0.0" })).toEqual([]);
    expect(findLeaf(new HostState(store).getLayout(), w.iid)?.version).toBe("2.0.0");
  });

  it("reconcile rebuilds app instances that have no layout leaf", () => {
    const st = new HostState(store);
    const widget = st.addWidget("clock", "1.2.0");
    const app = st.openApp("notes", "1.0.0", "/list");
    const layoutBefore = st.getLayout();

    expect(st.reconcile({ clock: "1.2.0", notes: "1.1.0" })).toEqual([app.iid]);
    expect(st.getInstances()[app.iid].version).toBe("1.1.0");
    expect(st.getInstances()[app.iid].route).toBe("/list");
    expect(st.getLayout()).toBe(layoutBefore);
    expect(st.reconcile({ clock: "1.2.0", notes: "1.1.0" })).toEqual([]);
    expect(findLeaf(st.getLayout(), widget.iid)?.version).toBe("1.2.0");
  });

  it("reconcile ignores plugins without an active version", () => {
    const st = new HostState(store);
    const widget = st.addWidget("clock", "1.2.0");

    expect(st.reconcile({})).toEqual([]);
    expect(st.reconcile({ unknown: "9.0.0" })).toEqual([]);
    expect(findLeaf(st.getLayout(), widget.iid)?.version).toBe("1.2.0");
  });

  it("restore reloads both stores after an external change", () => {
    const st = new HostState(store);
    const a = st.addWidget("clock", "1.2.0");
    const other = new HostState(store);
    const b = other.addWidget("notes", "1.0.0");

    st.restore();

    expect(leaves(st.getLayout()).map((leaf) => leaf.iid)).toEqual([a.iid, b.iid]);
    expect(Object.keys(st.getInstances())).toEqual([a.iid, b.iid]);
  });

  it("ignores malformed persisted data and starts from an empty state", () => {
    store.setItem(INSTANCES_KEY, "{broken");
    store.setItem(LAYOUT_KEY, "null");

    const st = new HostState(store);
    expect(st.getLayout()).toBeNull();
    expect(st.getInstances()).toEqual({});

    const widget = st.addWidget("clock", "1.2.0");
    expect(findLeaf(new HostState(store).getLayout(), widget.iid)).not.toBeNull();
  });

  it("never touches localStorage directly", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("direct localStorage access");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("direct localStorage access");
    });

    const st = new HostState(store);
    expect(() => {
      st.addWidget("clock", "1.2.0");
      st.openApp("notes", "1.0.0", "/list");
      st.reconcile({ clock: "2.0.0" });
      st.restore();
    }).not.toThrow();
  });
});

describe("storage keys", () => {
  it("uses the versioned v1 keys for both stores", () => {
    expect(INSTANCES_KEY).toBe("host.instances.v1");
    expect(LAYOUT_KEY).toBe("host.layout.v1");
    const st = new HostState(store);
    st.addWidget("clock", "1.2.0");
    st.openApp("notes", "1.0.0", "/list");
    expect(JSON.parse(store.getItem(INSTANCES_KEY)!)).toBeTypeOf("object");
    expect(JSON.parse(store.getItem(LAYOUT_KEY)!)).toBeTypeOf("object");
  });
});
