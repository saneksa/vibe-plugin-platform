/**
 * DOM-free security core (spec §8.8). `origin`, `source` and `data` arrive
 * already extracted; the only expectation on a source is a duck-typed
 * `postMessage` (a real iframe.contentWindow satisfies it). No DOM types,
 * storage or plugin state are imported here.
 */

import {
  decodeEnvelope,
  encodeEnvelope,
  getMeta,
  selectAdapter,
  type CompatibilityPolicy,
  type Envelope,
} from "../protocol/index.js";
import type { FrameHandle, FrameSourceRef, HostAdapter, RpcContext } from "./types.js";

const RPC_TIMEOUT_MS = 5000;

/** Every hostAPI method and the cap the core requires before calling it. */
const METHOD_CAPS: Record<string, string> = {
  "context.get": "context.read",
  "theme.get": "theme.read",
  "notify.show": "notify",
  navigate: "navigate",
  "storage.get": "storage.read",
  "storage.set": "storage.write",
  "storage.remove": "storage.write",
  "host.log": "log",
  "events.on": "events.read",
  "events.off": "events.read",
  "registry.list": "registry.read",
};

/** These are answered by the core itself — never by the consumer's adapter. */
const CORE_METHODS = new Set(["context.get", "events.on", "events.off", "navigate"]);

type RpcEnvelope = Extract<Envelope, { type: "rpc" }>;
type HelloEnvelope = Extract<Envelope, { type: "hello" }>;
type MessageTarget = FrameSourceRef & { postMessage(message: string, targetOrigin: string): void };

type RoutingState = {
  handle: FrameHandle;
  major: string;
  subscriptions: Set<string>;
  pending: Map<number, { cancel: () => void }>;
};

function errorInfo(err: unknown): { code: string; message: string } {
  if (typeof err === "object" && err !== null) {
    const code = (err as { code?: unknown }).code;
    const message = (err as { message?: unknown }).message;
    return {
      code: typeof code === "string" && code !== "" ? code : "rpc_failed",
      message: typeof message === "string" ? message : String(err),
    };
  }
  return { code: "rpc_failed", message: String(err) };
}

function topicOf(params: unknown): string | null {
  if (typeof params === "string") return params === "" ? null : params;
  if (typeof params === "object" && params !== null) {
    const topic = (params as { topic?: unknown }).topic;
    if (typeof topic === "string" && topic !== "") return topic;
  }
  return null;
}

function navArgsOf(params: unknown): { path: string; replace: boolean } | null {
  const value = typeof params === "string" ? { path: params, replace: false } : params;
  if (typeof value === "object" && value !== null) {
    const path = (value as { path?: unknown }).path;
    if (typeof path === "string" && path !== "") {
      return { path, replace: (value as { replace?: unknown }).replace === true };
    }
  }
  return null;
}

export class MessageRouter {
  private readonly states = new Map<string, RoutingState>();

  constructor(
    private readonly deps: {
      adapter: HostAdapter;
      policy: CompatibilityPolicy;
      schedule: (fn: () => void, ms: number) => () => void;
      /**
       * Legacy-major seam. The declared hello major selects this step, never
       * `rpc.api`. Defaults to the same dispatcher; a harness may inject the
       * richer v1 envelope adaptation (T8's adapters/v1.ts) here.
       */
      adaptV1?: (method: string, params: unknown, ctx: RpcContext) => Promise<unknown>;
    },
  ) {}

  accept(msg: { origin: string; source: FrameSourceRef; data: unknown; handle: FrameHandle }): void {
    const { handle } = msg;
    if (handle.state === "destroyed") return;
    if (msg.origin !== handle.expectedOrigin || msg.source !== handle.source) return;

    let envelope: Envelope;
    try {
      envelope = decodeEnvelope(msg.data);
    } catch {
      return;
    }
    if (envelope.iid !== handle.iid) return;

    // `navigate` is a wire envelope (§8.2/§12), not an RPC method. The triple
    // checks above already bound it to this frame; the router owns no URL state.
    if (envelope.type === "navigate") {
      this.deps.adapter.onNavigate(handle.iid, envelope.path, envelope.replace ?? false);
      return;
    }

    if (envelope.type === "hello") {
      this.onHello(envelope, handle);
      return;
    }
    const state = this.states.get(handle.iid);
    if (envelope.type === "rpc" && state !== undefined) this.onRpc(envelope, state);
  }

  publish(topic: string, value: unknown): void {
    for (const state of this.states.values()) {
      const { handle } = state;
      if (handle.state !== "ready") continue;
      if (!handle.caps.includes("events.read") || !state.subscriptions.has(topic)) continue;
      this.send(handle, { type: "event", iid: handle.iid, topic, value });
    }
  }

  destroy(iid: string): void {
    const state = this.states.get(iid);
    if (state === undefined) return;
    for (const pending of state.pending.values()) pending.cancel();
    state.pending.clear();
    state.subscriptions.clear();
    state.handle.caps = [];
    state.handle.state = "destroyed";
    this.states.delete(iid);
  }

  private onHello(hello: HelloEnvelope, handle: FrameHandle): void {
    if (handle.state !== "handshake") return;

    let route: ReturnType<typeof selectAdapter>;
    try {
      route = selectAdapter(hello.api, this.deps.policy);
    } catch (err) {
      this.send(handle, { type: "error", iid: handle.iid, message: errorInfo(err).message });
      return;
    }
    if (route === "reject") {
      this.send(handle, {
        type: "error",
        iid: handle.iid,
        message: `unsupported api major: ${hello.api}`,
      });
      return;
    }

    const ref = { iid: handle.iid, pluginId: handle.pluginId, version: handle.version };
    const caps = this.deps.adapter.grantCapabilities(hello.wants, ref);
    handle.caps = [...caps];
    handle.state = "ready";
    this.states.set(handle.iid, {
      handle,
      major: hello.api,
      subscriptions: new Set<string>(),
      pending: new Map(),
    });

    const meta = getMeta(this.deps.policy);
    this.send(handle, {
      type: "ready",
      iid: handle.iid,
      api: hello.api,
      caps: [...caps],
      deprecated: Object.keys(meta.deprecated),
      ...(meta.sunset === undefined ? {} : { sunset: meta.sunset }),
      hostVersion: this.deps.adapter.getMeta().hostVersion,
    });
  }

  private onRpc(env: RpcEnvelope, state: RoutingState): void {
    const { handle } = state;
    const method = env.method;
    if (!Object.hasOwn(METHOD_CAPS, method)) {
      this.reject(state, env, "unknown_method", `unknown method: ${method}`);
      return;
    }
    if (!handle.caps.includes(METHOD_CAPS[method])) {
      this.reject(state, env, "cap_denied", `missing capability: ${METHOD_CAPS[method]}`);
      return;
    }

    let work: Promise<unknown>;
    try {
      switch (method) {
        case "context.get":
          work = Promise.resolve(this.deps.adapter.getContext());
          break;
        case "events.on": {
          const topic = topicOf(env.params);
          if (topic === null) {
            this.reject(state, env, "invalid_params", "events.on requires a topic");
            return;
          }
          state.subscriptions.add(topic);
          work = Promise.resolve(true);
          break;
        }
        case "events.off": {
          const topic = topicOf(env.params);
          if (topic === null) {
            this.reject(state, env, "invalid_params", "events.off requires a topic");
            return;
          }
          state.subscriptions.delete(topic);
          work = Promise.resolve(true);
          break;
        }
        case "navigate": {
          const args = navArgsOf(env.params);
          if (args === null) {
            this.reject(state, env, "invalid_params", "navigate requires a path");
            return;
          }
          this.deps.adapter.onNavigate(handle.iid, args.path, args.replace);
          work = Promise.resolve(true);
          break;
        }
        default: {
          let route: ReturnType<typeof selectAdapter>;
          try {
            route = selectAdapter(state.major, this.deps.policy);
          } catch (err) {
            this.reject(state, env, "invalid_api", errorInfo(err).message);
            return;
          }
          if (route === "reject") {
            this.reject(state, env, "unsupported_api", `unsupported api major: ${state.major}`);
            return;
          }
          const ctx: RpcContext = {
            iid: handle.iid,
            pluginId: handle.pluginId,
            version: handle.version,
            caps: [...handle.caps],
          };
          const dispatch =
            route === "v1" && this.deps.adaptV1 !== undefined
              ? this.deps.adaptV1
              : (m: string, p: unknown, c: RpcContext) => this.deps.adapter.dispatchRpc(m, p, c);
          work = Promise.resolve().then(() => dispatch(method, env.params, ctx));
        }
      }
    } catch (err) {
      const info = errorInfo(err);
      this.reject(state, env, info.code, info.message);
      return;
    }

    let cancel = (): void => {};
    if (!CORE_METHODS.has(method)) {
      cancel = this.deps.schedule(() => {
        if (!state.pending.delete(env.id)) return;
        this.reject(state, env, "timeout", `rpc ${env.id} timed out after ${RPC_TIMEOUT_MS}ms`);
      }, RPC_TIMEOUT_MS);
    }
    state.pending.set(env.id, { cancel });

    void work.then(
      (value) => {
        if (!state.pending.delete(env.id)) return;
        cancel();
        this.send(handle, {
          type: "rpc.result",
          iid: handle.iid,
          id: env.id,
          ok: true,
          value,
        });
      },
      (err) => {
        if (!state.pending.has(env.id)) return;
        const info = errorInfo(err);
        this.reject(state, env, info.code, info.message);
      },
    );
  }

  private reject(
    state: RoutingState,
    env: { id: number },
    code: string,
    message: string,
  ): void {
    const pending = state.pending.get(env.id);
    if (pending !== undefined) {
      pending.cancel();
      state.pending.delete(env.id);
    }
    this.send(state.handle, {
      type: "rpc.result",
      iid: state.handle.iid,
      id: env.id,
      ok: false,
      error: { code, message },
    });
  }

  private send(handle: FrameHandle, envelope: Envelope): void {
    const target = handle.source as MessageTarget;
    if (typeof target.postMessage !== "function") {
      throw new TypeError("frame source must expose postMessage");
    }
    target.postMessage(encodeEnvelope(envelope), handle.expectedOrigin);
  }
}
