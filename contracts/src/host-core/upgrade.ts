/**
 * Version switching through the single backend port (spec §9.1). No HTTP and
 * no URL knowledge: the host never decides which version is active. No direct
 * `HostState` mutation either — frame rebuilding and version-cache
 * reconciliation belong to `FrameManager.upgrade` (T7).
 */

import type { HostAdapter } from "./types.js";

export async function switchActiveVersion(
  adapter: HostAdapter,
  pluginId: string,
  version: string,
): Promise<void> {
  await adapter.setActiveVersion(pluginId, version);
}
