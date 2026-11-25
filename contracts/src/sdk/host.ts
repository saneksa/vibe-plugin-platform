/**
 * Typed, framework-agnostic hostAPI surface handed to the plugin's `mount`.
 * HostContext is intentionally structural: the SDK must not import host-core.
 */

export interface HostApi {
  has(cap: string): boolean;
  context: {
    get(): Promise<{ theme: string; locale: string; user: { id: string; displayName: string }; hostVersion: string }>;
  };
  theme: { get(): Promise<{ mode: string }> };
  notify: { show(p: { level: string; message: string }): Promise<void> };
  navigate(path: string, opts?: { replace?: boolean }): void;
  storage: {
    get(key: string): Promise<unknown>;
    set(key: string, v: unknown): Promise<void>;
    remove(key: string): Promise<void>;
  };
  log(level: string, ...args: unknown[]): void;
  on(topic: string, cb: (v: unknown) => void): void;
  off(topic: string, cb: (v: unknown) => void): void;
  registry: { list(): Promise<unknown[]> };
}

export interface HostDeps {
  caps: string[];
  call(method: string, params?: unknown): Promise<unknown>;
  navigate(path: string, replace: boolean): void;
}

export interface HostRuntime {
  api: HostApi;
  /** Fan a host `event` envelope out to locally registered callbacks. */
  dispatchEvent(topic: string, value: unknown): void;
  clear(): void;
}

function capDenied(cap: string): Promise<never> {
  const error = new Error(`missing capability: ${cap}`) as Error & { code: string };
  error.code = "cap_denied";
  return Promise.reject(error);
}

export function createHost(deps: HostDeps): HostRuntime {
  const caps = new Set(deps.caps);
  const listeners = new Map<string, Set<(v: unknown) => void>>();

  const guarded = <T>(cap: string, method: string, params?: unknown): Promise<T> =>
    caps.has(cap) ? (deps.call(method, params) as Promise<T>) : capDenied(cap);

  const fire = (cap: string, method: string, params: unknown): void => {
    void guarded(cap, method, params).catch(() => {});
  };

  const api: HostApi = {
    has: (cap) => caps.has(cap),
    context: {
      get: () => guarded("context.read", "context.get"),
    },
    theme: {
      get: () => guarded("theme.read", "theme.get"),
    },
    notify: {
      show: (p) => guarded("notify", "notify.show", p),
    },
    navigate: (path, opts) => {
      if (caps.has("navigate")) deps.navigate(path, opts?.replace === true);
    },
    storage: {
      get: (key) => guarded("storage.read", "storage.get", key),
      set: (key, v) => guarded("storage.write", "storage.set", { key, value: v }),
      remove: (key) => guarded("storage.write", "storage.remove", key),
    },
    log: (level, ...args) => fire("log", "host.log", { level, args }),
    // Subscriptions are kept locally; the host router fans out `event` envelopes.
    // Registering with the host makes the router publish those topics at all.
    on: (topic, cb) => {
      let callbacks = listeners.get(topic);
      if (callbacks === undefined) {
        callbacks = new Set();
        listeners.set(topic, callbacks);
      }
      callbacks.add(cb);
      fire("events.read", "events.on", topic);
    },
    off: (topic, cb) => {
      const callbacks = listeners.get(topic);
      if (callbacks !== undefined) {
        callbacks.delete(cb);
        if (callbacks.size === 0) listeners.delete(topic);
      }
      fire("events.read", "events.off", topic);
    },
    registry: {
      list: () => guarded("registry.read", "registry.list"),
    },
  };

  return {
    api,
    dispatchEvent(topic, value) {
      for (const cb of listeners.get(topic) ?? []) cb(value);
    },
    clear() {
      listeners.clear();
    },
  };
}
