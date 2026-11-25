import { describe, expect, it } from "vitest";
import { decodeEnvelope, type CompatibilityPolicy, type Envelope } from "../protocol/index.js";
import { MessageRouter } from "./MessageRouter.js";
import type {
  FrameHandle,
  FrameSourceRef,
  HostAdapter,
  HostContext,
  HostMeta,
  InstanceRef,
  RpcContext,
} from "./types.js";

/** Hand-written fixtures: expectations never reuse the code under test. */
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

type Result = Extract<Envelope, { type: "rpc.result" }>;

class FakeSource implements FrameSourceRef {
  readonly sent: Envelope[] = [];

  constructor(readonly id: string) {}

  postMessage(data: string, _targetOrigin: string): void {
    this.sent.push(decodeEnvelope(data));
  }
}

class FakeAdapter implements HostAdapter {
  readonly grants: Array<{ requested: string[]; ref: InstanceRef }> = [];
  readonly dispatched: Array<{ method: string; params: unknown; ctx: RpcContext }> = [];
  readonly navigations: Array<{ iid: string; path: string; replace: boolean }> = [];
  grantedCaps: string[] = [...ALL_CAPS];
  handler: (method: string, params: unknown, ctx: RpcContext) => Promise<unknown> = async () => ({
    handled: true,
  });

  getMeta(): HostMeta {
    return META;
  }

  getContext(): HostContext {
    return CONTEXT;
  }

  grantCapabilities(requested: string[], ref: InstanceRef): string[] {
    this.grants.push({ requested: [...requested], ref: { ...ref } });
    return requested.filter((cap) => this.grantedCaps.includes(cap));
  }

  dispatchRpc(method: string, params: unknown, ctx: RpcContext): Promise<unknown> {
    this.dispatched.push({ method, params, ctx });
    return this.handler(method, params, ctx);
  }

  onNavigate(iid: string, path: string, replace: boolean): void {
    this.navigations.push({ iid, path, replace });
  }

  getPluginOrigin(_plugin: { id: string; version: string }): string {
    return "http://p:4001";
  }

  getPluginFrameBase(_plugin: { id: string; version: string }): string {
    return "http://p:4001/plugins/clock";
  }

  async getActiveVersions(): Promise<Record<string, string>> {
    return { clock: "1.2.0" };
  }

  async setActiveVersion(_pluginId: string, _version: string): Promise<void> {}
}

type Timer = { fn: () => void; ms: number; cancelled: boolean };

function makeRouter(opts: {
  adapter?: FakeAdapter;
  adaptV1?: (method: string, params: unknown, ctx: RpcContext) => Promise<unknown>;
  onFrameError?: (handle: FrameHandle, message: string) => void;
} = {}) {
  const adapter = opts.adapter ?? new FakeAdapter();
  const timers: Timer[] = [];
  const schedule = (fn: () => void, ms: number): (() => void) => {
    const timer = { fn, ms, cancelled: false };
    timers.push(timer);
    return () => {
      timer.cancelled = true;
    };
  };
  const fire = (ms: number): void => {
    for (const timer of timers) {
      if (timer.ms === ms && !timer.cancelled) {
        timer.cancelled = true;
        timer.fn();
      }
    }
  };
  const router = new MessageRouter({
    adapter,
    policy: POLICY,
    schedule,
    ...(opts.adaptV1 ? { adaptV1: opts.adaptV1 } : {}),
    ...(opts.onFrameError ? { onFrameError: opts.onFrameError } : {}),
  });
  return { router, adapter, timers, fire };
}

function handle(overrides: Partial<FrameHandle> = {}): FrameHandle {
  return {
    iid: "i1",
    expectedOrigin: "http://p:4001",
    source: new FakeSource("win-i1"),
    pluginId: "clock",
    version: "1.2.0",
    caps: [],
    state: "handshake",
    ...overrides,
  };
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

function results(source: FakeSource): Result[] {
  return source.sent.filter((e): e is Result => e.type === "rpc.result");
}

function lastResult(source: FakeSource): Result | undefined {
  return results(source).at(-1);
}

function sourceOf(handle: FrameHandle): FakeSource {
  return handle.source as FakeSource;
}

async function settle(): Promise<void> {
  // One macrotask turn drains the nested promises of dispatch and rpc.result.
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe("MessageRouter message validation", () => {
  it("drops a message with the right origin but a foreign source", () => {
    const { router, adapter } = makeRouter();
    const h = handle();
    router.accept({
      origin: h.expectedOrigin,
      source: { id: "other" },
      data: hello("i1", "2"),
      handle: h,
    });
    expect(adapter.grants).toHaveLength(0);
    expect(h.state).toBe("handshake");
    expect(sourceOf(h).sent).toEqual([]);
  });

  it("drops a message with the right source but an envelope iid different from the handle", () => {
    const { router, adapter } = makeRouter();
    const h = handle();
    router.accept({
      origin: h.expectedOrigin,
      source: h.source,
      data: hello("i8", "2"),
      handle: h,
    });
    expect(adapter.grants).toHaveLength(0);
    expect(sourceOf(h).sent).toEqual([]);
  });

  it("drops a message with the right source and iid but a foreign origin", () => {
    const { router, adapter } = makeRouter();
    const h = handle();
    router.accept({
      origin: "http://evil:4001",
      source: h.source,
      data: hello("i1", "2"),
      handle: h,
    });
    expect(adapter.grants).toHaveLength(0);
    expect(sourceOf(h).sent).toEqual([]);
  });

  it("drops malformed data without throwing", () => {
    const { router } = makeRouter();
    const h = handle();
    expect(() =>
      router.accept({
        origin: h.expectedOrigin,
        source: h.source,
        data: { type: "nonsense", iid: "i1" },
        handle: h,
      }),
    ).not.toThrow();
    expect(sourceOf(h).sent).toEqual([]);
  });

  it("drops hello with wants:null instead of throwing in the host listener", () => {
    const { router, adapter } = makeRouter();
    const h = handle();
    expect(() =>
      router.accept({
        origin: h.expectedOrigin,
        source: h.source,
        data: { type: "hello", iid: "i1", api: "2", sdk: "2.1.0", plugin: { id: "clock", version: "1.2.0" }, wants: null },
        handle: h,
      }),
    ).not.toThrow();
    expect(adapter.grants).toHaveLength(0);
    expect(sourceOf(h).sent).toEqual([]);
  });

  it("drops a navigate envelope with a non-string path", () => {
    const { router, adapter } = makeRouter();
    const h = handle();
    router.accept({ origin: h.expectedOrigin, source: h.source, data: hello("i1", "2"), handle: h });
    expect(() =>
      router.accept({
        origin: h.expectedOrigin,
        source: h.source,
        data: { type: "navigate", iid: "i1", path: 42 },
        handle: h,
      }),
    ).not.toThrow();
    expect(adapter.navigations).toEqual([]);
  });

  it("replies with an error envelope when an adapter method throws", () => {
    const adapter = new FakeAdapter();
    adapter.grantCapabilities = () => {
      throw new TypeError("adapter exploded");
    };
    const { router } = makeRouter({ adapter });
    const h = handle();
    expect(() =>
      router.accept({ origin: h.expectedOrigin, source: h.source, data: hello("i1", "2"), handle: h }),
    ).not.toThrow();
    expect(sourceOf(h).sent).toEqual([
      {
        type: "error",
        iid: "i1",
        message: "host rejected hello: adapter exploded",
      },
    ]);
    expect(h.state).toBe("handshake");
  });
});

describe("MessageRouter handshake", () => {
  it("fails a mounted frame that never sends hello after the handshake deadline", () => {
    const errors: Array<{ iid: string; message: string }> = [];
    const { router, adapter, timers, fire } = makeRouter({
      onFrameError: (handle, message) => errors.push({ iid: handle.iid, message }),
    });
    const h = handle();

    router.mount(h);
    expect(timers.map((t) => t.ms)).toEqual([10000]);
    fire(10000);

    expect(h.state).toBe("failed");
    expect(sourceOf(h).sent.at(-1)).toMatchObject({
      type: "error",
      iid: "i1",
      message: expect.stringContaining("handshake timed out"),
    });
    expect(errors).toEqual([
      { iid: "i1", message: expect.stringContaining("handshake timed out") },
    ]);
    expect(adapter.grants).toHaveLength(0);

    // A late hello must not revive the pane.
    router.accept({ origin: h.expectedOrigin, source: h.source, data: hello("i1", "2"), handle: h });
    expect(h.state).toBe("failed");
    expect(sourceOf(h).sent).toHaveLength(1);
  });

  it("cancels the handshake deadline once hello is accepted", () => {
    const { router, timers, fire } = makeRouter();
    const h = handle();
    router.mount(h);
    router.accept({ origin: h.expectedOrigin, source: h.source, data: hello("i1", "2"), handle: h });
    expect(timers.map((t) => t.cancelled)).toEqual([true]);
    expect(h.state).toBe("ready");
    fire(10000);
    expect(sourceOf(h).sent.filter((e) => e.type === "error")).toEqual([]);
  });

  it("grants requested caps and sends ready from the injected policy and adapter meta", () => {
    const { router, adapter } = makeRouter();
    const h = handle();

    router.accept({
      origin: h.expectedOrigin,
      source: h.source,
      data: hello("i1", "2", ["theme.read", "bogus.cap"]),
      handle: h,
    });

    expect(adapter.grants).toEqual([
      {
        requested: ["theme.read", "bogus.cap"],
        ref: { iid: "i1", pluginId: "clock", version: "1.2.0" },
      },
    ]);
    expect(h.state).toBe("ready");
    expect(h.caps).toEqual(["theme.read"]);
    expect(sourceOf(h).sent).toEqual([
      {
        type: "ready",
        iid: "i1",
        api: "2",
        caps: ["theme.read"],
        deprecated: ["1"],
        sunset: "host@3.0.0",
        hostVersion: "2.4.0",
      },
    ]);
  });

  it("sends an error envelope and no ready when the declared major is not supported", () => {
    const { router, adapter } = makeRouter();
    const h = handle();

    router.accept({
      origin: h.expectedOrigin,
      source: h.source,
      data: hello("i1", "9"),
      handle: h,
    });

    expect(adapter.grants).toHaveLength(0);
    expect(h.state).toBe("handshake");
    expect(sourceOf(h).sent).toEqual([
      { type: "error", iid: "i1", message: "unsupported api major: 9" },
    ]);
  });

  it("ignores an rpc that arrives before hello", () => {
    const { router, adapter } = makeRouter();
    const h = handle();

    router.accept({
      origin: h.expectedOrigin,
      source: h.source,
      data: rpc("i1", 1, "2", "theme.get"),
      handle: h,
    });

    expect(adapter.dispatched).toHaveLength(0);
    expect(sourceOf(h).sent).toEqual([]);
  });
});

describe("MessageRouter RPC routing", () => {
  it("dispatches an allowed method with a context resolved from the handle", async () => {
    const { router, adapter } = makeRouter();
    const h = handle();
    router.accept({
      origin: h.expectedOrigin,
      source: h.source,
      data: hello("i1", "2", ["theme.read"]),
      handle: h,
    });

    router.accept({
      origin: h.expectedOrigin,
      source: h.source,
      data: rpc("i1", 7, "2", "theme.get", { unit: "c" }),
      handle: h,
    });
    await settle();

    expect(adapter.dispatched).toEqual([
      {
        method: "theme.get",
        params: { unit: "c" },
        ctx: {
          iid: "i1",
          pluginId: "clock",
          version: "1.2.0",
          caps: ["theme.read"],
        },
      },
    ]);
    expect(lastResult(sourceOf(h))).toEqual({
      type: "rpc.result",
      iid: "i1",
      id: 7,
      ok: true,
      value: { handled: true },
    });
  });

  it("selects the v1 path from hello.api even when rpc.api says 2", async () => {
    const v1Calls: string[] = [];
    const { router, adapter } = makeRouter({
      adaptV1: async (method) => {
        v1Calls.push(method);
        return "legacy-value";
      },
    });
    const h = handle();
    router.accept({
      origin: h.expectedOrigin,
      source: h.source,
      data: hello("i1", "1", ["theme.read"]),
      handle: h,
    });

    router.accept({
      origin: h.expectedOrigin,
      source: h.source,
      data: rpc("i1", 7, "2", "theme.get"),
      handle: h,
    });
    await settle();

    expect(v1Calls).toEqual(["theme.get"]);
    expect(adapter.dispatched).toHaveLength(0);
    expect(lastResult(sourceOf(h))?.ok).toBe(true);
    expect(lastResult(sourceOf(h))).toMatchObject({ value: "legacy-value" });
  });

  it("rejects an rpc without the granted cap with cap_denied and no dispatch", () => {
    const { router, adapter } = makeRouter();
    const h = handle();
    router.accept({
      origin: h.expectedOrigin,
      source: h.source,
      data: hello("i1", "2", []),
      handle: h,
    });

    router.accept({
      origin: h.expectedOrigin,
      source: h.source,
      data: rpc("i1", 8, "2", "theme.get"),
      handle: h,
    });

    expect(adapter.dispatched).toHaveLength(0);
    expect(lastResult(sourceOf(h))).toMatchObject({
      ok: false,
      error: { code: "cap_denied" },
    });
  });

  it("answers context.get itself from getContext without dispatching", async () => {
    const { router, adapter } = makeRouter();
    const h = handle();
    router.accept({
      origin: h.expectedOrigin,
      source: h.source,
      data: hello("i1", "2", ["context.read"]),
      handle: h,
    });

    router.accept({
      origin: h.expectedOrigin,
      source: h.source,
      data: rpc("i1", 9, "2", "context.get"),
      handle: h,
    });
    await settle();

    expect(adapter.dispatched).toHaveLength(0);
    expect(lastResult(sourceOf(h))).toEqual({
      type: "rpc.result",
      iid: "i1",
      id: 9,
      ok: true,
      value: CONTEXT,
    });
  });

  it("returns unknown_method for a method that is not in hostAPI", () => {
    const { router, adapter } = makeRouter();
    const h = handle();
    router.accept({
      origin: h.expectedOrigin,
      source: h.source,
      data: hello("i1", "2", ["theme.read"]),
      handle: h,
    });

    router.accept({
      origin: h.expectedOrigin,
      source: h.source,
      data: rpc("i1", 10, "2", "bogus.get"),
      handle: h,
    });

    expect(adapter.dispatched).toHaveLength(0);
    expect(lastResult(sourceOf(h))).toMatchObject({
      ok: false,
      error: { code: "unknown_method" },
    });
  });

  it("rejects an inherited object key as an unknown method", () => {
    const { router, adapter } = makeRouter();
    const h = handle();
    router.accept({
      origin: h.expectedOrigin,
      source: h.source,
      data: hello("i1", "2", ["theme.read"]),
      handle: h,
    });

    router.accept({
      origin: h.expectedOrigin,
      source: h.source,
      data: rpc("i1", 31, "2", "toString"),
      handle: h,
    });

    expect(adapter.dispatched).toHaveLength(0);
    expect(lastResult(sourceOf(h))).toMatchObject({
      ok: false,
      error: { code: "unknown_method" },
    });
  });

  it("turns navigate into onNavigate instead of an RPC", async () => {
    const { router, adapter } = makeRouter();
    const h = handle();
    router.accept({
      origin: h.expectedOrigin,
      source: h.source,
      data: hello("i1", "2", ["navigate"]),
      handle: h,
    });

    router.accept({
      origin: h.expectedOrigin,
      source: h.source,
      data: rpc("i1", 11, "2", "navigate", { path: "/settings", replace: true }),
      handle: h,
    });
    await settle();

    expect(adapter.navigations).toEqual([
      { iid: "i1", path: "/settings", replace: true },
    ]);
    expect(adapter.dispatched).toHaveLength(0);
    expect(lastResult(sourceOf(h))).toMatchObject({ ok: true });
  });

  it("times out an unanswered rpc after 5000ms with a readable timeout code", () => {
    const adapter = new FakeAdapter();
    adapter.handler = () => new Promise<unknown>(() => {});
    const { router, fire, timers } = makeRouter({ adapter });
    const h = handle();
    router.accept({
      origin: h.expectedOrigin,
      source: h.source,
      data: hello("i1", "2", ["theme.read"]),
      handle: h,
    });

    router.accept({
      origin: h.expectedOrigin,
      source: h.source,
      data: rpc("i1", 12, "2", "theme.get"),
      handle: h,
    });

    expect(timers.map((t) => t.ms)).toEqual([5000]);
    expect(lastResult(sourceOf(h))).toBeUndefined();
    fire(5000);
    expect(lastResult(sourceOf(h))).toMatchObject({
      ok: false,
      error: { code: "timeout" },
    });
  });

  it("cancels the pending timeout once dispatchRpc resolves", async () => {
    const { router, adapter, timers, fire } = makeRouter();
    const h = handle();
    router.accept({
      origin: h.expectedOrigin,
      source: h.source,
      data: hello("i1", "2", ["theme.read"]),
      handle: h,
    });

    router.accept({
      origin: h.expectedOrigin,
      source: h.source,
      data: rpc("i1", 13, "2", "theme.get"),
      handle: h,
    });
    await settle();
    fire(5000);

    expect(results(sourceOf(h))).toHaveLength(1);
    expect(timers[0].cancelled).toBe(true);
    expect(adapter.dispatched).toHaveLength(1);
  });
});

describe("MessageRouter subscriptions", () => {
  it("publishes an event only to a ready subscriber that holds events.read", async () => {
    const { router } = makeRouter();
    const subscribed = handle({ iid: "i1", source: new FakeSource("win-i1") });
    const bystander = handle({ iid: "i2", source: new FakeSource("win-i2") });

    for (const h of [subscribed, bystander]) {
      router.accept({
        origin: h.expectedOrigin,
        source: h.source,
        data: hello(h.iid, "2", ["events.read"]),
        handle: h,
      });
    }
    router.accept({
      origin: subscribed.expectedOrigin,
      source: subscribed.source,
      data: rpc("i1", 20, "2", "events.on", { topic: "theme.changed" }),
      handle: subscribed,
    });
    await settle();

    router.publish("theme.changed", { mode: "light" });

    expect(sourceOf(subscribed).sent.at(-1)).toEqual({
      type: "event",
      iid: "i1",
      topic: "theme.changed",
      value: { mode: "light" },
    });
    expect(sourceOf(bystander).sent.filter((e) => e.type === "event")).toEqual([]);
  });

  it("stops publishing after events.off", async () => {
    const { router } = makeRouter();
    const h = handle();
    router.accept({
      origin: h.expectedOrigin,
      source: h.source,
      data: hello("i1", "2", ["events.read"]),
      handle: h,
    });
    router.accept({
      origin: h.expectedOrigin,
      source: h.source,
      data: rpc("i1", 21, "2", "events.on", { topic: "tick" }),
      handle: h,
    });
    await settle();
    router.publish("tick", 1);
    router.accept({
      origin: h.expectedOrigin,
      source: h.source,
      data: rpc("i1", 22, "2", "events.off", { topic: "tick" }),
      handle: h,
    });
    await settle();
    router.publish("tick", 2);

    expect(sourceOf(h).sent.filter((e) => e.type === "event")).toEqual([
      { type: "event", iid: "i1", topic: "tick", value: 1 },
    ]);
  });

  it("does not publish to a handle without events.read", async () => {
    const { router } = makeRouter();
    const h = handle();
    router.accept({
      origin: h.expectedOrigin,
      source: h.source,
      data: hello("i1", "2", []),
      handle: h,
    });
    router.accept({
      origin: h.expectedOrigin,
      source: h.source,
      data: rpc("i1", 23, "2", "events.on", { topic: "tick" }),
      handle: h,
    });
    await settle();

    router.publish("tick", 1);

    expect(sourceOf(h).sent.filter((e) => e.type === "event")).toEqual([]);
  });
});

describe("MessageRouter lifecycle", () => {
  it("destroy marks the handle destroyed and drops its state", () => {
    const { router, adapter } = makeRouter();
    const h = handle();
    router.accept({
      origin: h.expectedOrigin,
      source: h.source,
      data: hello("i1", "2", ["theme.read"]),
      handle: h,
    });

    router.destroy("i1");
    router.accept({
      origin: h.expectedOrigin,
      source: h.source,
      data: rpc("i1", 30, "2", "theme.get"),
      handle: h,
    });
    router.publish("anything", 1);

    expect(h.state).toBe("destroyed");
    expect(h.caps).toEqual([]);
    expect(adapter.dispatched).toHaveLength(0);
    expect(lastResult(sourceOf(h))).toBeUndefined();
  });
});
