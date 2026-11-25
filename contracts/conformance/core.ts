/**
 * DOM-free, parameterized conformance core (spec §13). Every host/plugin pair
 * must pass these cases. The harness knows nothing about the demo: it drives a
 * `MessageRouter` over fakes, a `HostState` over an injected store, and a
 * consumer-supplied `HostAdapter`. No browser, no demo and no real timers.
 */

import { adaptV1Envelope } from "../src/host-core/adapters/v1.js";
import type { FrameHost } from "../src/host-core/FrameHost.js";
import { HostState, LAYOUT_KEY } from "../src/host-core/HostState.js";
import type { LayoutNode } from "../src/host-core/layout.js";
import { restore, serialize } from "../src/host-core/layout.js";
import { MessageRouter } from "../src/host-core/MessageRouter.js";
import type { FrameHandle, HostAdapter, RpcContext } from "../src/host-core/types.js";
import {
  CAPS_CATALOGUE,
  decodeEnvelope,
  encodeEnvelope,
  getPolicy,
  type Envelope,
} from "../src/protocol/index.js";
import { FakeScheduler, MemoryStore, RecordingAdapter, sentOf } from "./fakes.js";

export interface ConformanceResult {
  passed: string[];
  failed: { name: string; error: string }[];
}

export interface CoreConformanceOptions {
  adapterFactory: () => HostAdapter;
  frameHostFactory: () => FrameHost;
  state: HostState;
}

type ReadyEnvelope = Extract<Envelope, { type: "ready" }>;
type ResultEnvelope = Extract<Envelope, { type: "rpc.result" }>;

function fail(message: string): never {
  throw new Error(message);
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) fail(message);
}

function equal(actual: unknown, expected: unknown, label: string): void {
  if (!Object.is(actual, expected)) {
    fail(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function deepEqual(actual: unknown, expected: unknown, label: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) fail(`${label}: expected ${b}, got ${a}`);
}

function throws(fn: () => void, label: string): void {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  if (!threw) fail(`${label}: expected a throw`);
}

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

/** Builds a handle the way `FrameManager.mount` would, but without a DOM. */
function frameOf(
  adapter: HostAdapter,
  frameHost: FrameHost,
  iid: string,
  pluginId: string,
  version: string,
): FrameHandle {
  const plugin = { id: pluginId, version };
  const url = `${adapter.getPluginFrameBase(plugin)}?iid=${encodeURIComponent(iid)}`;
  const origin = adapter.getPluginOrigin(plugin);
  const handle = frameHost.create(
    {} as Element,
    url,
    "allow-scripts allow-same-origin allow-forms",
    origin,
  );
  handle.iid = iid;
  handle.pluginId = pluginId;
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

function lastSent(handle: FrameHandle): Envelope | undefined {
  return sentOf(handle).at(-1);
}

function requireReady(handle: FrameHandle): ReadyEnvelope {
  const envelope = lastSent(handle);
  check(envelope?.type === "ready", "expected a ready envelope");
  return envelope;
}

function lastResult(handle: FrameHandle): ResultEnvelope {
  const envelope = sentOf(handle).filter((e) => e.type === "rpc.result").at(-1);
  check(envelope?.type === "rpc.result", "expected an rpc.result envelope");
  return envelope;
}

function leafIids(node: LayoutNode | null): string[] {
  if (node === null) return [];
  if (node.type === "leaf") return [node.iid];
  return [...leafIids(node.a), ...leafIids(node.b)];
}

/** Optional in-memory probes exposed by the fixture adapter, absent on real ones. */
function storageOf(adapter: HostAdapter): Map<string, string> | null {
  const candidate = (adapter as unknown as { storage?: unknown }).storage;
  return candidate instanceof Map ? (candidate as Map<string, string>) : null;
}

function versionsOf(adapter: HostAdapter): Map<string, string> | null {
  const candidate = (adapter as unknown as { activeVersions?: unknown }).activeVersions;
  return candidate instanceof Map ? (candidate as Map<string, string>) : null;
}

function destroyedOf(frameHost: FrameHost): FrameHandle[] {
  const candidate = (frameHost as unknown as { destroyed?: unknown }).destroyed;
  return Array.isArray(candidate) ? (candidate as FrameHandle[]) : [];
}

export function runCoreConformance(opts: CoreConformanceOptions): ConformanceResult {
  const passed: string[] = [];
  const failed: { name: string; error: string }[] = [];

  function setup(iid: string, pluginId: string, version: string) {
    const adapter = new RecordingAdapter(opts.adapterFactory());
    const frameHost = opts.frameHostFactory();
    const scheduler = new FakeScheduler();
    const router = new MessageRouter({
      adapter,
      policy: getPolicy(),
      schedule: scheduler.schedule,
    });
    return { adapter, frameHost, scheduler, router, handle: frameOf(adapter, frameHost, iid, pluginId, version) };
  }

  const cases: Array<{ name: string; run: () => void }> = [
    {
      name: "envelope-roundtrip",
      run: () => {
        const samples: Envelope[] = [
          { type: "hello", iid: "i1", api: "2", sdk: "2.1.0", plugin: { id: "clock", version: "2.0.0" }, wants: ["theme.read"] },
          { type: "ready", iid: "i1", api: "2", caps: ["theme.read"], deprecated: ["1"], sunset: "host@3.0.0", hostVersion: "2.4.0" },
          { type: "rpc", iid: "i1", id: 1, api: "2", method: "theme.get", params: { unit: "c" } },
          { type: "rpc.result", iid: "i1", id: 1, ok: true, value: { mode: "dark" } },
          { type: "rpc.result", iid: "i1", id: 2, ok: false, error: { code: "cap_denied", message: "missing capability" } },
          { type: "event", iid: "i1", topic: "tick", value: 1 },
          { type: "navigate", iid: "i1", path: "/settings", replace: true },
          { type: "route", iid: "i1", path: "/list" },
          { type: "lifecycle", iid: "i1", state: "suspend" },
          { type: "error", iid: "i1", message: "bad envelope" },
        ];
        for (const envelope of samples) {
          deepEqual(decodeEnvelope(encodeEnvelope(envelope)), envelope, `roundtrip ${envelope.type}`);
        }
        throws(() => decodeEnvelope({ type: "not-a-type", iid: "i1" }), "unknown envelope type");
        throws(() => decodeEnvelope({ type: "rpc" }), "missing iid");
      },
    },
    {
      name: "major-gate-409",
      run: () => {
        const { adapter, router, handle } = setup("gate-i1", "clock", "2.0.0");
        deliver(router, handle, hello("gate-i1", "9", ["theme.read"]));
        equal(handle.state, "handshake", "unsupported major must not reach ready");
        equal(adapter.grants.length, 0, "unsupported major must not grant caps");
        deepEqual(sentOf(handle), [
          { type: "error", iid: "gate-i1", message: "unsupported api major: 9" },
        ], "major gate reply");
      },
    },
    {
      name: "v1-adapter-in-deprecation-window",
      run: () => {
        const adapter = new RecordingAdapter(opts.adapterFactory());
        const scheduler = new FakeScheduler();
        const router = new MessageRouter({
          adapter,
          policy: getPolicy(),
          schedule: scheduler.schedule,
          adaptV1: async () => "legacy-value",
        });
        const handle = frameOf(adapter, opts.frameHostFactory(), "v1-i1", "clock", "1.2.0");

        deliver(router, handle, hello("v1-i1", "1", ["theme.read"]));
        const ready = requireReady(handle);
        equal(ready.api, "1", "ready echoes the declared v1 major");
        check(ready.deprecated.includes("1"), "deprecated major 1 must be announced");
        check(typeof ready.sunset === "string", "deprecation window must announce a sunset");

        // Synthetic v1 envelope: current field names, api:"1", no legacy plugin.
        const synthetic: Envelope = {
          type: "rpc", iid: "v1-i1", id: 7, api: "1", method: "theme.get", params: { unit: "c" },
        };
        const normalized = adaptV1Envelope(synthetic);
        deepEqual(normalized, synthetic, "v1 envelope keeps current shape and major");
        deliver(router, handle, normalized);
        equal(scheduler.active.length, 1, "normalized v1 rpc reaches the dispatch path");
      },
    },
    {
      name: "append-only-minor",
      run: () => {
        const { adapter, router, frameHost, handle } = setup("minor-i1", "clock", "1.0.0");
        const second = frameOf(adapter, frameHost, "minor-i2", "clock", "1.0.0");
        const oldCaps = ["context.read"];
        const newCaps = ["context.read", "theme.read", "notify"];

        deliver(router, handle, hello("minor-i1", "2", oldCaps));
        deliver(router, second, hello("minor-i2", "2", newCaps));

        deepEqual(requireReady(handle).caps, oldCaps, "older plugin keeps its caps");
        deepEqual(requireReady(second).caps, newCaps, "a newer minor grants more caps");
        check(CAPS_CATALOGUE.length >= newCaps.length, "caps catalogue contains the new caps");
        equal(handle.caps.join(","), oldCaps.join(","), "old plugin still lives");
      },
    },
    {
      name: "upgrade-preserves-iid-layout-storage",
      run: () => {
        const adapter = new RecordingAdapter(opts.adapterFactory());
        const frameHost = opts.frameHostFactory();
        const scheduler = new FakeScheduler();
        const router = new MessageRouter({ adapter, policy: getPolicy(), schedule: scheduler.schedule });
        const record = opts.state.addWidget("clock", "1.2.0");
        const iid = record.iid;
        const storage = storageOf(adapter.inner);
        const versions = versionsOf(adapter.inner);
        const ctx: RpcContext = { iid, pluginId: "clock", version: "1.2.0", caps: ["storage.write"] };

        if (storage !== null) {
          void adapter.dispatchRpc("storage.set", { key: "k", value: "v" }, ctx);
          equal(storage.get(`clock|${iid}|k`), JSON.stringify("v"), "storage written before upgrade");
        }
        const iidsBefore = leafIids(opts.state.getLayout());

        const oldHandle = frameOf(adapter, frameHost, iid, "clock", "1.2.0");
        deliver(router, oldHandle, hello(iid, "2", ["theme.read"]));
        equal(oldHandle.state, "ready", "old frame handshake completed");

        void adapter.setActiveVersion("clock", "2.0.0");
        opts.state.setVersion("clock", "2.0.0");
        frameHost.destroy(oldHandle);
        router.destroy(iid);
        check(destroyedOf(frameHost).includes(oldHandle), "old frame destroyed before the new one");
        equal(oldHandle.state, "destroyed", "old router state destroyed");

        const newHandle = frameOf(adapter, frameHost, iid, "clock", "2.0.0");
        deliver(router, newHandle, hello(iid, "2", ["theme.read"]));
        equal(newHandle.state, "ready", "new frame handshake completed");
        equal(requireReady(newHandle).api, "2", "new handshake echoes the current major");
        equal(opts.state.getInstances()[iid].version, "2.0.0", "version cache updated");
        deepEqual(leafIids(opts.state.getLayout()), iidsBefore, "layout keeps its iids");
        if (storage !== null) {
          equal(storage.get(`clock|${iid}|k`), JSON.stringify("v"), "storage survives upgrade");
        }
        if (versions !== null) equal(versions.get("clock"), "2.0.0", "activeVersion switched");
      },
    },
    {
      name: "rollback",
      run: () => {
        const adapter = new RecordingAdapter(opts.adapterFactory());
        const record = opts.state.addWidget("rollback-plugin", "1.2.0");
        const iid = record.iid;
        const storage = storageOf(adapter.inner);
        const versions = versionsOf(adapter.inner);
        const ctx: RpcContext = {
          iid, pluginId: "rollback-plugin", version: "1.2.0", caps: ["storage.write"],
        };
        if (storage !== null) {
          void adapter.dispatchRpc("storage.set", { key: "k", value: "v" }, ctx);
        }

        void adapter.setActiveVersion("rollback-plugin", "2.0.0");
        opts.state.setVersion("rollback-plugin", "2.0.0");
        equal(opts.state.getInstances()[iid].version, "2.0.0", "upgraded cache");

        void adapter.setActiveVersion("rollback-plugin", "1.2.0");
        opts.state.setVersion("rollback-plugin", "1.2.0");
        equal(opts.state.getInstances()[iid].version, "1.2.0", "rolled back cache");
        deepEqual(opts.state.reconcile({ "rollback-plugin": "1.2.0" }), [], "no rebuild after rollback");
        check(leafIids(opts.state.getLayout()).includes(iid), "iid survives rollback");
        if (storage !== null) {
          equal(storage.get(`rollback-plugin|${iid}|k`), JSON.stringify("v"), "storage survives rollback");
        }
        if (versions !== null) equal(versions.get("rollback-plugin"), "1.2.0", "activeVersion rolled back");
      },
    },
    {
      name: "cache-reconcile",
      run: () => {
        const adapter = new RecordingAdapter(opts.adapterFactory());
        const record = opts.state.addWidget("reconcile-plugin", "1.0.0");
        const iid = record.iid;

        void adapter.setActiveVersion("reconcile-plugin", "2.0.0");
        const rebuild = opts.state.reconcile({ "reconcile-plugin": "2.0.0" });
        check(rebuild.includes(iid), "stale frame scheduled for rebuild");
        equal(opts.state.getInstances()[iid].version, "2.0.0", "derived cache updated");
        deepEqual(opts.state.reconcile({ "reconcile-plugin": "2.0.0" }), [], "second reconcile is a no-op");
      },
    },
    {
      name: "triple-check",
      run: () => {
        const { adapter, router, handle, scheduler } = setup("triple-i1", "clock", "2.0.0");

        const good = hello("triple-i1", "2", ["theme.read"]);

        deliver(router, handle, good, { origin: "http://evil.test" });
        deliver(router, handle, good, { source: { id: "foreign" } });
        deliver(router, handle, hello("triple-i9", "2", ["theme.read"]));
        equal(handle.state, "handshake", "all three forged hellos are dropped");
        equal(adapter.grants.length, 0, "forged messages grant nothing");
        equal(sentOf(handle).length, 0, "forged messages get no reply");

        deliver(router, handle, good);
        equal(handle.state, "ready", "genuine hello accepted");
        requireReady(handle);

        const call = rpc("triple-i1", 1, "2", "theme.get");
        deliver(router, handle, call, { origin: "http://evil.test" });
        deliver(router, handle, call, { source: { id: "foreign" } });
        deliver(router, handle, rpc("triple-i9", 2, "2", "theme.get"));
        equal(scheduler.active.length, 0, "forged rpcs never dispatch");
        deliver(router, handle, call);
        equal(scheduler.active.length, 1, "genuine rpc dispatches");
      },
    },
    {
      name: "timeout-5s",
      run: () => {
        const { router, handle, scheduler } = setup("timeout-i1", "clock", "2.0.0");
        deliver(router, handle, hello("timeout-i1", "2", ["theme.read"]));
        deliver(router, handle, rpc("timeout-i1", 1, "2", "theme.get"));

        equal(scheduler.active.length, 1, "one deadline registered");
        equal(scheduler.active[0].ms, 5000, "deadline is 5000ms");
        equal(sentOf(handle).filter((e) => e.type === "rpc.result").length, 0, "no early result");
        equal(scheduler.fire(5000), 1, "deadline fires synchronously");
        const result = lastResult(handle);
        check(!result.ok && result.error.code === "timeout", "timed out rpc reports timeout");
      },
    },
    {
      name: "unknown-method",
      run: () => {
        const { router, handle, scheduler } = setup("method-i1", "clock", "2.0.0");
        deliver(router, handle, hello("method-i1", "2", ["theme.read"]));
        deliver(router, handle, rpc("method-i1", 1, "2", "bogus.get"));
        let result = lastResult(handle);
        check(!result.ok && result.error.code === "unknown_method", "unknown method rejected");
        deliver(router, handle, rpc("method-i1", 2, "2", "toString"));
        result = lastResult(handle);
        check(!result.ok && result.error.code === "unknown_method", "inherited key rejected");
        equal(scheduler.active.length, 0, "no timer for rejected methods");
      },
    },
    {
      name: "cap-denied",
      run: () => {
        const { router, handle, scheduler } = setup("cap-i1", "clock", "2.0.0");
        deliver(router, handle, hello("cap-i1", "2", []));
        deliver(router, handle, rpc("cap-i1", 1, "2", "theme.get"));
        const result = lastResult(handle);
        check(!result.ok && result.error.code === "cap_denied", "missing cap rejected");
        equal(scheduler.active.length, 0, "no timer for denied caps");
      },
    },
    {
      name: "layout-roundtrip",
      run: () => {
        if (opts.state.getLayout() === null) opts.state.addWidget("layout-probe", "2.0.0");
        const tree = opts.state.getLayout();
        check(tree !== null, "layout tree exists");
        const serialized = serialize(tree);
        deepEqual(restore(serialized), tree, "serialize/restore roundtrip");
        const store = new MemoryStore();
        store.setItem(LAYOUT_KEY, serialized);
        deepEqual(new HostState(store).getLayout(), tree, "HostState reloads the same tree");
        equal(restore("not json"), null, "corrupt layout is tolerated");
      },
    },
    {
      name: "navigate-envelope",
      run: () => {
        const { adapter, router, handle } = setup("nav-i1", "clock", "2.0.0");
        deliver(router, handle, hello("nav-i1", "2", ["navigate"]));
        const nav: Envelope = { type: "navigate", iid: "nav-i1", path: "/settings/general", replace: true };

        deliver(router, handle, nav, { origin: "http://evil.test" });
        deliver(router, handle, nav, { source: { id: "foreign" } });
        deepEqual(adapter.navigations, [], "forged navigate envelopes are dropped");

        deliver(router, handle, nav);
        deepEqual(adapter.navigations, [
          { iid: "nav-i1", path: "/settings/general", replace: true },
        ], "navigate envelope drives onNavigate");
        deliver(router, handle, { type: "navigate", iid: "nav-i1", path: "/home" });
        equal(adapter.navigations[1].replace, false, "replace defaults to false");
        equal(sentOf(handle).filter((e) => e.type === "rpc.result").length, 0, "navigate is not an rpc");
      },
    },
    {
      name: "default-v1-path",
      run: () => {
        const adapter = new RecordingAdapter(opts.adapterFactory());
        const scheduler = new FakeScheduler();
        // No injected adaptV1: only the adapter's default dispatcher can handle this.
        const router = new MessageRouter({ adapter, policy: getPolicy(), schedule: scheduler.schedule });
        const handle = frameOf(adapter, opts.frameHostFactory(), "v1-default", "clock", "1.2.0");

        deliver(router, handle, hello("v1-default", "1", ["theme.read"]));
        equal(requireReady(handle).api, "1", "route is selected from the hello major");
        deliver(router, handle, rpc("v1-default", 55, "2", "theme.get"));
        equal(scheduler.active.length, 1, "default dispatch path taken");
        equal(scheduler.active[0].ms, 5000, "default dispatch carries a deadline");
      },
    },
  ];

  for (const entry of cases) {
    try {
      entry.run();
      passed.push(entry.name);
    } catch (err) {
      failed.push({ name: entry.name, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return { passed, failed };
}
