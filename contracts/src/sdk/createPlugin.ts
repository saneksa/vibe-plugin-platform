/**
 * Plugin-side runtime: handshake, capability-gated hostAPI, pending RPC table
 * with timeouts, and inbound route/lifecycle/event handling (spec §8.4).
 */

import { decodeEnvelope, encodeEnvelope, type Envelope } from "../protocol/index.js";
import { readBoot } from "./boot.js";
import { createHost, type HostApi, type HostRuntime } from "./host.js";
import { routeMatcher } from "./router.js";

export interface PluginDefinition {
  mount(el: HTMLElement, host: HostApi): void | (() => void);
  routes?: Record<string, (params: Record<string, string>) => void>;
}

const RPC_TIMEOUT_MS = 5000;

/** Every RPC method and the cap it needs; mirrored from the host's method table. */
const METHOD_CAPS: Record<string, string> = {
  "context.get": "context.read",
  "theme.get": "theme.read",
  "notify.show": "notify",
  "storage.get": "storage.read",
  "storage.set": "storage.write",
  "storage.remove": "storage.write",
  "host.log": "log",
  "events.on": "events.read",
  "events.off": "events.read",
  "registry.list": "registry.read",
};

type Pending = {
  resolve(value: unknown): void;
  reject(error: unknown): void;
  timer: ReturnType<typeof setTimeout>;
};

function rpcError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

/** The only function a plugin author writes; all transport details live here. */
export function createPlugin(def: PluginDefinition): void {
  const boot = readBoot();
  const query = new URLSearchParams(window.location.search);
  const iid = query.get("iid");
  if (iid === null || iid === "") {
    throw new TypeError("plugin frame URL is missing iid");
  }
  const initialRoute = query.get("route") ?? "/";

  const granted = new Set<string>();
  const pending = new Map<number, Pending>();
  let nextId = 1;
  let runtime: HostRuntime | undefined;
  let root: HTMLElement | undefined;
  let cleanup: (() => void) | undefined;
  let destroyed = false;

  const post = (envelope: Envelope): void => {
    window.parent.postMessage(encodeEnvelope(envelope), "*");
  };

  const call = (method: string, params?: unknown): Promise<unknown> => {
    const cap = METHOD_CAPS[method];
    if (cap === undefined) {
      return Promise.reject(rpcError("unknown_method", `unknown method: ${method}`));
    }
    if (!granted.has(cap)) {
      return Promise.reject(rpcError("cap_denied", `missing capability: ${cap}`));
    }

    const id = nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!pending.delete(id)) return;
        reject(rpcError("timeout", `rpc ${id} timed out after ${RPC_TIMEOUT_MS}ms`));
      }, RPC_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      post({
        type: "rpc",
        iid,
        id,
        api: boot.hostApiMajor,
        method,
        ...(params === undefined ? {} : { params }),
      });
    });
  };

  const onMessage = (event: MessageEvent): void => {
    let envelope: Envelope;
    try {
      envelope = decodeEnvelope(event.data);
    } catch {
      return;
    }
    if (destroyed || envelope.iid !== iid) return;

    switch (envelope.type) {
      case "ready": {
        if (runtime !== undefined) return;
        granted.clear();
        for (const cap of envelope.caps) granted.add(cap);
        runtime = createHost({
          caps: envelope.caps,
          call,
          navigate: (path, replace) => {
            post(
              replace
                ? { type: "navigate", iid, path, replace: true }
                : { type: "navigate", iid, path },
            );
          },
        });

        root = document.createElement("div");
        root.dataset.pluginId = boot.id;
        (document.body ?? document.documentElement).appendChild(root);
        const dispose = def.mount(root, runtime.api);
        cleanup = typeof dispose === "function" ? dispose : undefined;
        if (initialRoute !== "") routeMatcher(def.routes ?? {}, initialRoute);
        break;
      }
      case "rpc.result": {
        const entry = pending.get(envelope.id);
        if (entry === undefined) return;
        clearTimeout(entry.timer);
        pending.delete(envelope.id);
        if (envelope.ok) entry.resolve(envelope.value);
        else entry.reject(rpcError(envelope.error.code, envelope.error.message));
        break;
      }
      case "event":
        runtime?.dispatchEvent(envelope.topic, envelope.value);
        break;
      case "route":
        routeMatcher(def.routes ?? {}, envelope.path);
        break;
      case "lifecycle":
        if (envelope.state === "destroy") destroy();
        break;
      default:
        break;
    }
  };

  const destroy = (): void => {
    if (destroyed) return;
    destroyed = true;
    for (const entry of pending.values()) clearTimeout(entry.timer);
    pending.clear();
    runtime?.clear();
    try {
      cleanup?.();
    } finally {
      root?.remove();
      window.removeEventListener("message", onMessage);
    }
  };

  window.addEventListener("message", onMessage);
  post({
    type: "hello",
    iid,
    // Declared manifest major — never a number from the frame URL (§8.4).
    api: boot.hostApiMajor,
    sdk: boot.sdk,
    plugin: { id: boot.id, version: boot.version },
    wants: [...boot.capabilities],
  });
}
