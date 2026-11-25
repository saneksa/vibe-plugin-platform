/**
 * The single owner of both persistent stores: `host.instances.v1` and the BSP
 * tree in `host.layout.v1`, plus the current-app pointer in
 * `host.currentApp.v1`. All storage is reached through an injected port, so
 * this state machine is DOM-free and can be driven by fakes in conformance.
 */

import {
  createInstanceRecord,
  type InstanceRecord,
  type InstanceRegistry,
} from "./instances.js";
import {
  insert,
  remove,
  resize as resizeTree,
  restore as restoreTree,
  serialize,
  setVersion as setTreeVersion,
  type LayoutNode,
} from "./layout.js";

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const INSTANCES_KEY = "host.instances.v1";
export const LAYOUT_KEY = "host.layout.v1";
export const CURRENT_APP_KEY = "host.currentApp.v1";

type Leaf = Extract<LayoutNode, { type: "leaf" }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Tolerates missing/corrupt storage: invalid entries are dropped, never thrown. */
function parseRegistry(raw: string | null | undefined): InstanceRegistry {
  const registry: InstanceRegistry = Object.create(null) as InstanceRegistry;
  if (typeof raw !== "string" || raw.trim() === "") return registry;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return registry;
  }
  if (!isRecord(parsed)) return registry;

  for (const [iid, value] of Object.entries(parsed)) {
    if (!isRecord(value)) continue;
    if (value.iid !== iid || typeof value.pluginId !== "string") continue;
    if (typeof value.version !== "string") continue;
    if (value.kind !== "widget" && value.kind !== "app") continue;
    if (value.route !== undefined && typeof value.route !== "string") continue;

    const record: InstanceRecord = {
      iid,
      pluginId: value.pluginId,
      version: value.version,
      kind: value.kind,
    };
    if (typeof value.route === "string") record.route = value.route;
    registry[iid] = record;
  }
  return registry;
}

function visitLeaves(root: LayoutNode | null, visit: (leaf: Leaf) => void): void {
  if (!root) return;
  if (root.type === "leaf") {
    visit(root);
    return;
  }
  visitLeaves(root.a, visit);
  visitLeaves(root.b, visit);
}

export class HostState {
  private readonly store: KeyValueStore;
  private layout: LayoutNode | null = null;
  private instances: InstanceRegistry = Object.create(null) as InstanceRegistry;
  private currentAppIid: string | null = null;

  constructor(store: KeyValueStore) {
    this.store = store;
    this.restore();
  }

  /** Reloads both stores and the active-app pointer, so closeApp survives a reload. */
  restore(): void {
    this.instances = parseRegistry(this.store.getItem(INSTANCES_KEY));
    this.layout = restoreTree(this.store.getItem(LAYOUT_KEY));
    const savedIid = this.store.getItem(CURRENT_APP_KEY);
    this.currentAppIid =
      savedIid !== null && this.instances[savedIid]?.kind === "app" ? savedIid : null;
  }

  addWidget(pluginId: string, version: string): InstanceRecord {
    const record = createInstanceRecord(pluginId, version, "widget");
    this.instances[record.iid] = record;
    this.layout = insert(this.layout, pluginId, version, record.iid);
    this.persist();
    return { ...record };
  }

  removeWidget(iid: string): void {
    const record = this.instances[iid];
    if (!record || record.kind !== "widget") return;
    if (this.layout !== null) this.layout = remove(this.layout, iid);
    delete this.instances[iid];
    this.persist();
  }

  resize(path: string, ratio: number): void {
    if (this.layout === null) return;
    this.layout = resizeTree(this.layout, path, ratio);
    this.persist();
  }

  /** Full-screen apps are registry entries only; they never become BSP leaves. */
  openApp(pluginId: string, version: string, route?: string): InstanceRecord {
    const record = createInstanceRecord(pluginId, version, "app", route);
    this.instances[record.iid] = record;
    this.currentAppIid = record.iid;
    this.persist();
    return { ...record };
  }

  closeApp(): void {
    if (this.currentAppIid === null) return;
    delete this.instances[this.currentAppIid];
    this.currentAppIid = null;
    this.persist();
  }

  /**
   * Rehydrates a deep-linked app without allocating a new iid, so a later
   * `closeApp()`/`reconcile()` targets the record the URL pointed at (T17).
   */
  activateApp(iid: string): void {
    const record = this.instances[iid];
    if (record === undefined || record.kind !== "app") {
      throw new Error(`not an app instance: ${iid}`);
    }
    this.currentAppIid = iid;
    this.persist();
  }

  /** Updates the version cache of widget leaves and of every matching record. */
  setVersion(pluginId: string, version: string): void {
    if (this.layout !== null) {
      this.layout = setTreeVersion(this.layout, pluginId, version);
    }
    for (const record of Object.values(this.instances)) {
      if (record.pluginId === pluginId && record.version !== version) {
        this.instances[record.iid] = { ...record, version };
      }
    }
    this.persist();
  }

  getLayout(): LayoutNode | null {
    return this.layout;
  }

  /** Snapshot: callers cannot mutate the owned registry by holding this object. */
  getInstances(): InstanceRegistry {
    const snapshot: InstanceRegistry = {};
    for (const [iid, record] of Object.entries(this.instances)) {
      snapshot[iid] = { ...record };
    }
    return snapshot;
  }

  /**
   * Compares backend `activeVersion` with the layout cache and app records.
   * Returns the iids whose frames must be rebuilt, and persists the new cache.
   */
  reconcile(activeVersions: Record<string, string>): string[] {
    const rebuild: string[] = [];
    const stalePlugins = new Set<string>();

    const noteStale = (pluginId: string, iid: string, cached: string): void => {
      const active = activeVersions[pluginId];
      if (active === undefined || active === cached) return;
      rebuild.push(iid);
      stalePlugins.add(pluginId);
    };

    visitLeaves(this.layout, (leaf) => noteStale(leaf.pluginId, leaf.iid, leaf.version));
    const activeApp = this.currentAppIid === null ? undefined : this.instances[this.currentAppIid];
    if (activeApp?.kind === "app") {
      noteStale(activeApp.pluginId, activeApp.iid, activeApp.version);
    }

    for (const pluginId of stalePlugins) {
      this.setVersion(pluginId, activeVersions[pluginId]);
    }
    return rebuild;
  }

  private persist(): void {
    this.store.setItem(INSTANCES_KEY, JSON.stringify(this.instances));
    this.store.setItem(LAYOUT_KEY, this.layout === null ? "" : serialize(this.layout));
    this.store.setItem(CURRENT_APP_KEY, this.currentAppIid ?? "");
  }
}
