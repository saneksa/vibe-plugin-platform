/**
 * DOM-free fakes for the portable conformance core (spec §13). No browser
 * globals, no real timers: frames, messages and schedules are all in memory so
 * `runCoreConformance` stays deterministic in Node and in the browser rig.
 */

import type { FrameHost, FrameHostMessage } from "../src/host-core/FrameHost.js";
import type { KeyValueStore } from "../src/host-core/HostState.js";
import type {
  FrameHandle,
  FrameSourceRef,
  HostAdapter,
  HostContext,
  HostMeta,
  InstanceRef,
  RpcContext,
} from "../src/host-core/types.js";
import { decodeEnvelope, type Envelope } from "../src/protocol/index.js";

/** In-memory `KeyValueStore` for `HostState` (no `localStorage` needed). */
export class MemoryStore implements KeyValueStore {
  private readonly data = new Map<string, string>();

  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
}

/** Duck-typed frame source: captures every envelope the router posts. */
export class FakeFrameSource implements FrameSourceRef {
  readonly sent: Envelope[] = [];

  constructor(readonly id: string) {}

  postMessage(data: string, _targetOrigin: string): void {
    this.sent.push(decodeEnvelope(data));
  }
}

/** Reads the envelopes captured by a handle backed by a `FakeFrameSource`. */
export function sentOf(handle: FrameHandle): Envelope[] {
  const source = handle.source as unknown as { sent?: unknown };
  if (!Array.isArray(source.sent)) throw new TypeError("handle source is not a FakeFrameSource");
  return source.sent as Envelope[];
}

export type FakeTimer = { fn: () => void; ms: number; cancelled: boolean };

/** Controllable clock: the harness fires the 5000ms RPC deadline itself. */
export class FakeScheduler {
  readonly timers: FakeTimer[] = [];

  readonly schedule = (fn: () => void, ms: number): (() => void) => {
    const timer: FakeTimer = { fn, ms, cancelled: false };
    this.timers.push(timer);
    return () => {
      timer.cancelled = true;
    };
  };

  get active(): FakeTimer[] {
    return this.timers.filter((timer) => !timer.cancelled);
  }

  /** Runs every non-cancelled timer registered for exactly `ms`; returns the count. */
  fire(ms: number): number {
    let fired = 0;
    for (const timer of this.timers) {
      if (timer.ms !== ms || timer.cancelled) continue;
      timer.cancelled = true;
      timer.fn();
      fired++;
    }
    return fired;
  }
}

/** In-memory `FrameHost`: no `document`, no `window`, no iframes. */
export class FakeFrameHost implements FrameHost {
  readonly created: FrameHandle[] = [];
  readonly destroyed: FrameHandle[] = [];
  readonly messages: FrameHostMessage[] = [];
  private callback: ((e: FrameHostMessage) => void) | null = null;

  create(_container: Element, url: string, _sandbox: string, expectedOrigin: string): FrameHandle {
    const iid = new URL(url, "http://localhost").searchParams.get("iid") ?? "";
    const handle: FrameHandle = {
      iid,
      expectedOrigin,
      source: new FakeFrameSource(`win-${iid}`),
      pluginId: "",
      version: "",
      caps: [],
      state: "handshake",
    };
    this.created.push(handle);
    return handle;
  }

  destroy(handle: FrameHandle): void {
    if (!this.destroyed.includes(handle)) this.destroyed.push(handle);
  }

  onMessage(cb: (e: FrameHostMessage) => void): void {
    this.callback = cb;
  }

  /** Delivers an already-extracted message through the registered callback. */
  emit(message: FrameHostMessage): void {
    this.messages.push(message);
    this.callback?.(message);
  }
}

/**
 * Delegating decorator that records the calls the router makes synchronously
 * (grants, `context.get`, `onNavigate`). Async `dispatchRpc` results are
 * delegated untouched; the call itself is recorded at invocation time.
 */
export class RecordingAdapter implements HostAdapter {
  readonly grants: Array<{ requested: string[]; ref: InstanceRef }> = [];
  readonly dispatched: Array<{ method: string; params: unknown; ctx: RpcContext }> = [];
  readonly navigations: Array<{ iid: string; path: string; replace: boolean }> = [];
  readonly contextReads = { count: 0 };

  constructor(readonly inner: HostAdapter) {}

  getMeta(): HostMeta {
    return this.inner.getMeta();
  }

  getContext(): HostContext {
    this.contextReads.count++;
    return this.inner.getContext();
  }

  grantCapabilities(requested: string[], ref: InstanceRef): string[] {
    const granted = this.inner.grantCapabilities(requested, ref);
    this.grants.push({ requested: [...requested], ref: { ...ref } });
    return granted;
  }

  dispatchRpc(method: string, params: unknown, ctx: RpcContext): Promise<unknown> {
    this.dispatched.push({ method, params, ctx });
    return this.inner.dispatchRpc(method, params, ctx);
  }

  onNavigate(iid: string, path: string, replace: boolean): void {
    this.navigations.push({ iid, path, replace });
    this.inner.onNavigate(iid, path, replace);
  }

  getPluginOrigin(plugin: { id: string; version: string }): string {
    return this.inner.getPluginOrigin(plugin);
  }

  getPluginFrameBase(plugin: { id: string; version: string }): string {
    return this.inner.getPluginFrameBase(plugin);
  }

  getActiveVersions(): Promise<Record<string, string>> {
    return this.inner.getActiveVersions();
  }

  setActiveVersion(pluginId: string, version: string): Promise<void> {
    return this.inner.setActiveVersion(pluginId, version);
  }
}
