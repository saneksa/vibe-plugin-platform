/**
 * Public host API (spec §8.7). Owns instance allocation through `HostState`,
 * builds frame URLs (only `iid` and `route`), and wires frames to the DOM-free
 * `MessageRouter`. It never talks HTTP: versions go through `HostAdapter`.
 */

import { getPolicy, type CompatibilityPolicy } from "../protocol/index.js";
import { DomFrameHost, type FrameHost } from "./FrameHost.js";
import { HostState, type KeyValueStore } from "./HostState.js";
import type { InstanceRecord } from "./instances.js";
import { MessageRouter } from "./MessageRouter.js";
import type { FrameHandle, HostAdapter, PluginDescriptor, RpcContext } from "./types.js";

export const FRAME_SANDBOX = "allow-scripts allow-same-origin allow-forms";

export interface FrameManagerOptions {
  adapter: HostAdapter;
  frameHost?: FrameHost;
  state?: HostState;
  policy?: CompatibilityPolicy;
  /** Legacy-major dispatcher injected into the router (T8/T17 seam). */
  adaptV1?: (method: string, params: unknown, ctx: RpcContext) => Promise<unknown>;
  /** Pane-level error hook (e.g. render an error card instead of a blank pane). */
  onFrameError?: (iid: string, message: string) => void;
}

export interface FrameManager {
  readonly state: HostState;
  createInstance(
    descriptor: PluginDescriptor,
    kind: "widget" | "app",
    route?: string,
  ): InstanceRecord;
  mount(container: Element, iid: string, route?: string): FrameHandle;
  unmount(iid: string): void;
  publish(topic: string, value: unknown): void;
  upgrade(pluginId: string, version: string): Promise<void>;
  restore(): Promise<void>;
  /** Point the persisted current-app pointer at an existing app record. */
  activateApp(iid: string): void;
}

type Mount = { container: Element; route?: string };

function defaultStore(): KeyValueStore {
  try {
    if (typeof globalThis.localStorage !== "undefined") {
      const probe = "__vibe_store_probe__";
      globalThis.localStorage.setItem(probe, "");
      globalThis.localStorage.removeItem(probe);
      return {
        getItem: (key) => globalThis.localStorage.getItem(key),
        setItem: (key, value) => globalThis.localStorage.setItem(key, value),
      };
    }
  } catch {
    // Storage can be disabled; fall back to a process-local store.
  }
  const data = new Map<string, string>();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
  };
}

class FrameManagerImpl implements FrameManager {
  readonly state: HostState;
  private readonly adapter: HostAdapter;
  private readonly frameHost: FrameHost;
  private readonly router: MessageRouter;
  private readonly handles = new Map<string, FrameHandle>();
  private readonly mounts = new Map<string, Mount>();

  constructor(opts: FrameManagerOptions) {
    this.adapter = opts.adapter;
    this.state = opts.state ?? new HostState(defaultStore());
    this.frameHost = opts.frameHost ?? new DomFrameHost(opts.adapter);
    this.router = new MessageRouter({
      adapter: opts.adapter,
      policy: opts.policy ?? getPolicy(),
      schedule: (fn, ms) => {
        const timer = setTimeout(fn, ms);
        return () => clearTimeout(timer);
      },
      ...(opts.adaptV1 === undefined ? {} : { adaptV1: opts.adaptV1 }),
      ...(opts.onFrameError === undefined
        ? {}
        : { onFrameError: (handle, message) => opts.onFrameError!(handle.iid, message) }),
    });

    this.frameHost.onMessage(({ origin, source, data, iid }) => {
      const handle = this.handles.get(iid);
      if (handle === undefined) return;
      this.router.accept({ origin, source, data, handle });
    });
  }

  createInstance(
    descriptor: PluginDescriptor,
    kind: "widget" | "app",
    route?: string,
  ): InstanceRecord {
    return kind === "widget"
      ? this.state.addWidget(descriptor.id, descriptor.version)
      : this.state.openApp(descriptor.id, descriptor.version, route);
  }

  mount(container: Element, iid: string, route?: string): FrameHandle {
    const record = this.state.getInstances()[iid];
    if (record === undefined) throw new Error(`unknown instance: ${iid}`);

    const effectiveRoute = route ?? record.route;
    const plugin = { id: record.pluginId, version: record.version };
    const query = new URLSearchParams();
    query.set("iid", iid);
    if (effectiveRoute !== undefined) query.set("route", effectiveRoute);
    const url = `${this.adapter.getPluginFrameBase(plugin)}?${query.toString()}`;
    const expectedOrigin = this.adapter.getPluginOrigin(plugin);

    this.teardown(iid);
    const handle = this.frameHost.create(container, url, FRAME_SANDBOX, expectedOrigin);
    // FrameHost only extracts the iid from the URL; the manager owns metadata.
    handle.iid = iid;
    handle.pluginId = record.pluginId;
    handle.version = record.version;
    handle.expectedOrigin = expectedOrigin;
    handle.caps = [];
    handle.state = "handshake";

    this.handles.set(iid, handle);
    this.mounts.set(iid, { container, route: effectiveRoute });
    this.router.mount(handle);
    return handle;
  }

  unmount(iid: string): void {
    this.teardown(iid);
  }

  publish(topic: string, value: unknown): void {
    this.router.publish(topic, value);
  }

  async upgrade(pluginId: string, version: string): Promise<void> {
    await this.adapter.setActiveVersion(pluginId, version);
    this.state.setVersion(pluginId, version);
    this.rebuildFrames((record) => record.pluginId === pluginId);
  }

  async restore(): Promise<void> {
    this.state.restore();
    const activeVersions = await this.adapter.getActiveVersions();
    const stale = new Set(this.state.reconcile(activeVersions));
    this.rebuildFrames((record) => stale.has(record.iid));
  }

  activateApp(iid: string): void {
    this.state.activateApp(iid);
  }

  private teardown(iid: string): void {
    this.router.destroy(iid);
    const handle = this.handles.get(iid);
    if (handle !== undefined) {
      this.frameHost.destroy(handle);
      this.handles.delete(iid);
    }
    this.mounts.delete(iid);
  }

  /** Re-mounts live frames in place, keeping their iid, container and route. */
  private rebuildFrames(matches: (record: InstanceRecord) => boolean): void {
    for (const [iid, mount] of [...this.mounts]) {
      const record = this.state.getInstances()[iid];
      if (record === undefined || !matches(record)) continue;
      this.mount(mount.container, iid, mount.route);
    }
  }
}

export function createFrameManager(opts: FrameManagerOptions): FrameManager {
  return new FrameManagerImpl(opts);
}
