/**
 * The single consumer-side `HostAdapter` implementation, shared by the demo
 * shell and by conformance. Every environment-specific value (plugin origin,
 * frame URL builder, registry transport, storage and host version) is injected
 * through `DemoAdapterConfig`; nothing here reaches out to the demo servers.
 */

import type {
  HostAdapter,
  HostContext,
  HostMeta,
  InstanceRef,
  PluginDescriptorDTO,
  RpcContext,
} from "@vibe/plugin-contracts/host-core";
import { CAPS_CATALOGUE, getMeta, getPolicy } from "@vibe/plugin-contracts/protocol";

/** Backend-owned registry projection used by the adapter. */
export interface RegistryTransport {
  getActiveVersions(): Promise<Record<string, string>>;
  setActiveVersion(id: string, version: string): Promise<void>;
  list(): Promise<PluginDescriptorDTO[]>;
}

/** Synchronous key/value store. `removeItem` is used when the store offers it. */
export interface KeyValueStore {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

export interface DemoAdapterConfig {
  pluginOrigin: string;
  frameBase: (d: { id: string; version: string }) => string;
  registry: RegistryTransport;
  store: KeyValueStore;
  hostVersion: string;
  onNavigate?: (iid: string, path: string, replace: boolean) => void;
  /** Theme reported to plugins through `context.get` / `theme.get`; "dark" when unset. */
  getTheme?: () => string;
  /** Sink for `notify.show`; notifications are dropped when it is not set. */
  onNotify?: (notification: { level: string; message: string }, ctx: RpcContext) => void;
}

const CONTEXT = {
  theme: "dark",
  locale: "en-US",
  user: { id: "u1", displayName: "Ada" },
};

function storageKeyParam(params: unknown): string {
  if (typeof params === "string") return params;
  if (params !== null && typeof params === "object" && "key" in params) {
    return String((params as { key: unknown }).key);
  }
  return String(params);
}

export class DemoHostAdapter implements HostAdapter {
  constructor(private readonly cfg: DemoAdapterConfig) {}

  getMeta(): HostMeta {
    return { ...getMeta(getPolicy()), hostVersion: this.cfg.hostVersion };
  }

  private theme(): string {
    return this.cfg.getTheme?.() ?? CONTEXT.theme;
  }

  getContext(): HostContext {
    return {
      theme: this.theme(),
      locale: CONTEXT.locale,
      user: { ...CONTEXT.user },
      hostVersion: this.cfg.hostVersion,
    };
  }

  grantCapabilities(requested: string[], _ref: InstanceRef): string[] {
    return requested.filter((cap) => CAPS_CATALOGUE.includes(cap));
  }

  async dispatchRpc(method: string, params: unknown, ctx: RpcContext): Promise<unknown> {
    const scoped = (key: string): string => `${ctx.pluginId}|${ctx.iid}|${key}`;

    switch (method) {
      case "theme.get":
        return { mode: this.theme() };

      case "storage.set": {
        const { key, value } = params as { key: string; value: unknown };
        this.cfg.store.setItem(scoped(key), JSON.stringify(value ?? null));
        return true;
      }

      case "storage.get": {
        const raw = this.cfg.store.getItem(scoped(storageKeyParam(params)));
        return raw === null || raw === "" ? null : (JSON.parse(raw) as unknown);
      }

      case "storage.remove": {
        const key = scoped(storageKeyParam(params));
        const store = this.cfg.store as KeyValueStore & { removeItem?: (k: string) => void };
        if (typeof store.removeItem === "function") store.removeItem(key);
        else store.setItem(key, "");
        return true;
      }

      case "notify.show": {
        const { level, message } = (params ?? {}) as { level?: string; message?: string };
        this.cfg.onNotify?.({ level: level ?? "info", message: message ?? "" }, ctx);
        return true;
      }

      case "host.log":
        return true;

      case "registry.list":
        return this.cfg.registry.list();

      default:
        throw Object.assign(new Error(`unknown method: ${method}`), { code: "unknown_method" });
    }
  }

  onNavigate(iid: string, path: string, replace: boolean): void {
    if (this.cfg.onNavigate) {
      this.cfg.onNavigate(iid, path, replace);
      return;
    }
    const url = `/app/${iid}/${path.replace(/^\/+/, "")}`;
    if (replace) window.history.replaceState(null, "", url);
    else window.history.pushState(null, "", url);
  }

  getPluginOrigin(_plugin: { id: string; version: string }): string {
    return this.cfg.pluginOrigin;
  }

  getPluginFrameBase(plugin: { id: string; version: string }): string {
    return this.cfg.frameBase(plugin);
  }

  async getActiveVersions(): Promise<Record<string, string>> {
    return this.cfg.registry.getActiveVersions();
  }

  async setActiveVersion(pluginId: string, version: string): Promise<void> {
    return this.cfg.registry.setActiveVersion(pluginId, version);
  }
}
