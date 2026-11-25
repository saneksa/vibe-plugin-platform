/**
 * In-memory fixture implementation of the single consumer port (spec §13).
 * Storage is keyed by `pluginId + iid` with no version component, so a value
 * written by an old version is still readable after an upgrade or rollback.
 */

import type { HostAdapter, HostContext, HostMeta, InstanceRef, RpcContext } from "../../src/host-core/types.js";
import { CAPS_CATALOGUE, getMeta, getPolicy } from "../../src/protocol/index.js";

const HOST_VERSION = "2.4.0";
const PLUGIN_ORIGIN = "http://plugin.test:4001";

const CONTEXT: HostContext = {
  theme: "dark",
  locale: "en-US",
  user: { id: "u1", displayName: "Ada" },
  hostVersion: HOST_VERSION,
};

export class FixtureAdapter implements HostAdapter {
  /** `<pluginId>|<iid>|<key>` → JSON value. Never keyed by version. */
  readonly storage = new Map<string, string>();
  /** Backend-owned active version, held in memory for the harness. */
  readonly activeVersions = new Map<string, string>();
  readonly dispatched: Array<{ method: string; params: unknown; ctx: RpcContext }> = [];
  readonly navigations: Array<{ iid: string; path: string; replace: boolean }> = [];
  readonly grants: Array<{ requested: string[]; ref: InstanceRef }> = [];

  static storageKey(pluginId: string, iid: string, key: string): string {
    return `${pluginId}|${iid}|${key}`;
  }

  getMeta(): HostMeta {
    return { ...getMeta(getPolicy()), hostVersion: HOST_VERSION };
  }

  getContext(): HostContext {
    return { ...CONTEXT, user: { ...CONTEXT.user } };
  }

  grantCapabilities(requested: string[], ref: InstanceRef): string[] {
    this.grants.push({ requested: [...requested], ref: { ...ref } });
    return requested.filter((cap) => CAPS_CATALOGUE.includes(cap));
  }

  async dispatchRpc(method: string, params: unknown, ctx: RpcContext): Promise<unknown> {
    this.dispatched.push({ method, params, ctx });
    const scoped = (key: string): string => FixtureAdapter.storageKey(ctx.pluginId, ctx.iid, key);

    switch (method) {
      case "storage.set": {
        const { key, value } = params as { key: string; value: unknown };
        this.storage.set(scoped(key), JSON.stringify(value ?? null));
        return true;
      }
      case "storage.get": {
        const key = typeof params === "string" ? params : String(params);
        const raw = this.storage.get(scoped(key));
        return raw === undefined ? null : (JSON.parse(raw) as unknown);
      }
      case "storage.remove": {
        const key = typeof params === "string" ? params : String(params);
        this.storage.delete(scoped(key));
        return true;
      }
      case "theme.get":
        return { mode: CONTEXT.theme };
      case "notify.show":
      case "host.log":
        return true;
      case "registry.list":
        return [];
      default:
        throw Object.assign(new Error(`unknown method: ${method}`), { code: "unknown_method" });
    }
  }

  onNavigate(iid: string, path: string, replace: boolean): void {
    this.navigations.push({ iid, path, replace });
  }

  getPluginOrigin(_plugin: { id: string; version: string }): string {
    return PLUGIN_ORIGIN;
  }

  getPluginFrameBase(plugin: { id: string; version: string }): string {
    return `${PLUGIN_ORIGIN}/plugins/${plugin.id}`;
  }

  async getActiveVersions(): Promise<Record<string, string>> {
    return Object.fromEntries(this.activeVersions);
  }

  async setActiveVersion(pluginId: string, version: string): Promise<void> {
    this.activeVersions.set(pluginId, version);
  }
}
