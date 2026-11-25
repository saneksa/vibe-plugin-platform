/**
 * Portable host port (spec §8.5) and the values shared by the DOM-free router
 * with the frame host. No DOM types and no consumer state live here.
 */

export type InstanceRef = { iid: string; pluginId: string; version: string };

export type RpcContext = InstanceRef & { caps: string[] };

export interface HostMeta {
  supportedMajors: string[];
  deprecated: Record<string, { sunset: string }>;
  sunset?: string;
  capsCatalogue: string[];
  hostVersion: string;
}

export interface HostContext {
  theme: string;
  locale: string;
  user: { id: string; displayName: string };
  hostVersion: string;
}

export interface PluginDescriptor {
  id: string;
  version: string;
  kind: "widget" | "app";
  entry: string;
  capabilities: string[];
  hostApi: string;
}

/**
 * The only port the consumer implements. Instance state, capability checks and
 * host-owned methods (context.get, events.on/off, navigate) belong to
 * `host-core`, not to this interface.
 */
export interface HostAdapter {
  getMeta(): HostMeta;
  getContext(): HostContext;
  grantCapabilities(requested: string[], ref: InstanceRef): string[];
  dispatchRpc(method: string, params: unknown, ctx: RpcContext): Promise<unknown>;
  onNavigate(iid: string, path: string, replace: boolean): void;
  getPluginOrigin(plugin: { id: string; version: string }): string;
  getPluginFrameBase(plugin: { id: string; version: string }): string;
  getActiveVersions(): Promise<Record<string, string>>;
  setActiveVersion(pluginId: string, version: string): Promise<void>;
}

/** Minimal identity of an already-extracted message source. */
export interface FrameSourceRef {
  id: string;
}

export interface FrameHandle {
  iid: string;
  expectedOrigin: string;
  source: FrameSourceRef;
  pluginId: string;
  version: string;
  caps: string[];
  state: "handshake" | "ready" | "destroyed";
}
