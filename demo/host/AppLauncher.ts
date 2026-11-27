/**
 * App launcher: resolves the active version from the backend, allocates an
 * `InstanceRecord` through the host and hands the resulting iid to the router.
 * Apps are full-screen and never enter the widget BSP tree.
 */

import type { RegistryClient } from "./RegistryClient.js";
import { errorMessage } from "./Shell.js";

export interface AppLauncherDeps {
  registry: RegistryClient;
  /**
   * Widget dev loop: a version to use when the plugin is not installed yet
   * (its frames mount from the dev origin instead of the registry).
   */
  resolveDev?(pluginId: string): string | undefined;
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
    const version = dto === undefined ? this.deps.resolveDev?.(pluginId) : active[pluginId] ?? dto.version;
    if (dto === undefined && version === undefined) return;

    const path = route ?? "/";
    const iid = this.deps.createApp(pluginId, version ?? dto!.version, path);
    this.deps.showApp(iid, path);
  }
}
