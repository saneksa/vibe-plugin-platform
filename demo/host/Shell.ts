/**
 * Header UI. All state changes are delegated to callbacks supplied by the
 * host; Shell only lists registry descriptors and reports upload progress.
 */

import type { PluginDescriptorDTO } from "@vibe/plugin-contracts/host-core";
import type { RegistryClient, UploadResult } from "./RegistryClient.js";

export interface ShellDeps {
  registry: RegistryClient;
  onAddWidget(pluginId: string): void;
  onLaunchApp(pluginId: string): void;
  onUpload(file: File): Promise<UploadResult> | UploadResult;
  onThemeToggle?(): void;
  onUpgrade(pluginId: string, version: string): void;
  onRollback(pluginId: string, version: string): void;
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number(n) || 0);
  const pb = b.split(".").map((n) => Number(n) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

/** Shared formatting for every reported host/UI failure. */
export function errorMessage(error: unknown): string {
  return error instanceof Error && error.message !== "" ? error.message : String(error);
}

function button(dataset: Record<string, string>, label: string): HTMLButtonElement {
  const el = document.createElement("button");
  el.type = "button";
  el.textContent = label;
  for (const [key, value] of Object.entries(dataset)) el.dataset[key] = value;
  return el;
}

export class Shell {
  private versions: PluginDescriptorDTO[] = [];
  private active: Record<string, string> = {};

  constructor(
    private readonly deps: ShellDeps,
    private readonly root: HTMLElement,
  ) {
    this.render();
  }

  /** The one status surface in the header, shared by upload and host flows. */
  showStatus(message: string, level: "info" | "error" = "info"): void {
    const status = this.root.querySelector<HTMLElement>("[data-upload-status]");
    if (status === null) return;
    status.textContent = message;
    status.dataset.level = level;
  }

  async refresh(): Promise<void> {
    const [versions, active] = await Promise.all([
      this.deps.registry.list(),
      this.deps.registry.getActiveVersions(),
    ]);
    this.versions = versions;
    this.active = active;
    this.paint();
  }

  private render(): void {
    this.root.innerHTML = `
      <span class="brand">VIBE plugins</span>
      <label class="upload">Загрузить zip
        <input type="file" accept=".zip,application/zip" data-upload>
      </label>
      <span class="upload-status" data-upload-status></span>
      <button type="button" data-widgets-toggle>+ виджет</button>
      <span class="widget-list" data-widgets></span>
      <span class="app-list" data-apps></span>
      <button type="button" data-theme-toggle>тема</button>
      <span class="updates" data-updates></span>
    `;

    this.root.addEventListener("click", (event) => {
      const el = (event.target as Element | null)?.closest<HTMLElement>("button");
      if (el === null || el === undefined || !this.root.contains(el)) return;
      const { addWidget, launch, upgrade, rollback, version, themeToggle, widgetsToggle } =
        el.dataset;
      if (addWidget !== undefined) this.deps.onAddWidget(addWidget);
      else if (launch !== undefined) this.deps.onLaunchApp(launch);
      else if (upgrade !== undefined) this.deps.onUpgrade(upgrade, version ?? "");
      else if (rollback !== undefined) this.deps.onRollback(rollback, version ?? "");
      else if (themeToggle !== undefined) {
        document.documentElement.classList.toggle("light");
        this.deps.onThemeToggle?.();
      } else if (widgetsToggle !== undefined) {
        this.root.querySelector("[data-widgets]")?.classList.toggle("collapsed");
      }
    });

    this.root.addEventListener("change", (event) => {
      const input = event.target;
      if (!(input instanceof HTMLInputElement) || input.dataset.upload === undefined) return;
      const file = input.files?.[0];
      if (file === undefined) return;
      void Promise.resolve(this.deps.onUpload(file)).then(
        (result) => {
          if (result.ok) this.showStatus(result.message ?? "загружено", "info");
          else this.showStatus(result.message ?? "ошибка загрузки", "error");
        },
        (error: unknown) => this.showStatus(errorMessage(error), "error"),
      );
    });
  }

  private paint(): void {
    const widgets = this.root.querySelector<HTMLElement>("[data-widgets]");
    const apps = this.root.querySelector<HTMLElement>("[data-apps]");
    const updates = this.root.querySelector<HTMLElement>("[data-updates]");
    if (widgets === null || apps === null || updates === null) return;

    widgets.replaceChildren(
      ...this.versions
        .filter((dto) => dto.kind === "widget")
        .map((dto) => button({ addWidget: dto.id }, `+ ${dto.title || dto.id}`)),
    );
    apps.replaceChildren(
      ...this.versions
        .filter((dto) => dto.kind === "app")
        .map((dto) => button({ launch: dto.id }, `▶ ${dto.title || dto.id}`)),
    );

    const versionButtons: HTMLButtonElement[] = [];
    for (const [id, current] of Object.entries(this.active)) {
      const installed = this.versions.filter((dto) => dto.id === id).map((dto) => dto.version);
      const newest = installed.reduce((best, v) => (compareVersions(v, best) > 0 ? v : best), current);
      const oldest = installed.reduce((best, v) => (compareVersions(v, best) < 0 ? v : best), current);
      if (compareVersions(newest, current) > 0) {
        versionButtons.push(
          button(
            { upgrade: id, version: newest },
            `доступно обновление: ${id} ${current} → ${newest}`,
          ),
        );
      }
      // Older archives stay installed, so the same UI knob performs a rollback.
      if (compareVersions(oldest, current) < 0) {
        versionButtons.push(
          button({ rollback: id, version: oldest }, `Откатить: ${id} ${current} → ${oldest}`),
        );
      }
    }
    updates.replaceChildren(...versionButtons);
  }
}
