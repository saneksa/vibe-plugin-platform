/**
 * App launcher: resolves the active version from the backend, allocates an
 * `InstanceRecord` through the host and hands the resulting iid to the router.
 * Apps are full-screen and never enter the widget BSP tree.
 */

import type { RegistryClient } from "./RegistryClient.js";
import { errorMessage } from "./Shell.js";

export interface AppLauncherDeps {
  registry: RegistryClient;
  createApp(pluginId: string, version: string, route?: string): string;
  showApp(iid: string, path: string): void;
  closeApp(): void;
  onError(message: string): void;
}

export class AppLauncher {
  constructor(private readonly deps: AppLauncherDeps) {}

  open(pluginId: string, route?: string): void {
    void this.openAsync(pluginId, route).catch((error: unknown) => {
      this.deps.onError(`Не удалось открыть приложение: ${errorMessage(error)}`);
    });
  }

  close(): void {
    this.deps.closeApp();
  }

  private async openAsync(pluginId: string, route?: string): Promise<void> {
    const [versions, active] = await Promise.all([
      this.deps.registry.list(),
      this.deps.registry.getActiveVersions(),
    ]);
    const dto =
      versions.find((d) => d.id === pluginId && d.kind === "app") ??
      versions.find((d) => d.id === pluginId);
    if (dto === undefined) return;

    const version = active[pluginId] ?? dto.version;
    const path = route ?? "/";
    const iid = this.deps.createApp(pluginId, version, path);
    this.deps.showApp(iid, path);
  }
}
