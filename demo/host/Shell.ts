/**
 * Chrome of the demo host: the plugin catalog (`#shell`) and the top bar.
 * Shell only lists registry descriptors and reports upload progress; every
 * state change is delegated to callbacks supplied by the host.
 */

import type { PluginDescriptorDTO } from "@vibe/plugin-contracts/host-core";
import { addDevPlugin, removeDevPlugin, type DevPlugin } from "./devPlugins.js";
import { icon, pluginGlyph, type IconName } from "./icons.js";
import type { RegistryClient, UploadResult } from "./RegistryClient.js";
import type { StatusLevel, Toasts } from "./Toasts.js";
import { currentTheme, toggleTheme, type Theme } from "./theme.js";

export interface ShellDeps {
  registry: RegistryClient;
  toasts: Toasts;
  onAddWidget(pluginId: string): void;
  onLaunchApp(pluginId: string): void;
  onUpload(file: File): Promise<UploadResult> | UploadResult;
  /** Receives the theme the user has just switched to. */
  onThemeToggle?(theme: Theme): void;
  onUpgrade(pluginId: string, version: string): void;
  onRollback(pluginId: string, version: string): void;
  onCloseApp(): void;
  /** Widgets of this plugin currently on the canvas. */
  instanceCount?(pluginId: string): number;
  /**
   * Widget dev loop: which ids mount frames from a vite dev origin, backed by
   * localStorage. Shell renders the "Разработка" section and its add-form.
   */
  dev: {
    list(): DevPlugin[];
    add(id: string, origin: string): { ok: boolean; error?: string };
    remove(id: string): void;
  };
}

/** The app shown in the full-screen stage. */
export interface AppInfo {
  title: string;
  icon?: string;
  version: string;
  route: string;
}

/** One catalog entry per plugin id: a single version of a plugin is active. */
export interface PluginEntry {
  id: string;
  title: string;
  icon: string;
  kind: "widget" | "app";
  /** Backend-owned active version; the newest installed one when it is unset. */
  active: string;
  /** Installed versions, newest first. */
  installed: string[];
  newer: string | null;
  older: string | null;
  unsupported: boolean;
}

export function compareVersions(a: string, b: string): number {
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

/** Folds every installed version of a plugin into one catalog entry. */
export function groupPlugins(
  versions: PluginDescriptorDTO[],
  active: Record<string, string>,
): PluginEntry[] {
  const groups = new Map<
    string,
    { first: PluginDescriptorDTO; installed: string[]; unsupported: boolean }
  >();
  for (const dto of versions) {
    const group = groups.get(dto.id) ?? {
      first: dto,
      installed: [],
      unsupported: false,
    };
    group.installed.push(dto.version);
    group.unsupported = group.unsupported || dto.unsupported;
    groups.set(dto.id, group);
  }

  return [...groups].map(([id, group]) => {
    const installed = [...group.installed].sort((a, b) => compareVersions(b, a));
    const newest = installed[0] ?? "";
    const oldest = installed[installed.length - 1] ?? "";
    const current = active[id];
    const currentActive = current !== undefined && installed.includes(current) ? current : newest;
    return {
      id,
      title: group.first.title || id,
      icon: group.first.icon,
      kind: group.first.kind,
      active: currentActive,
      installed,
      newer: compareVersions(newest, currentActive) > 0 ? newest : null,
      older: compareVersions(oldest, currentActive) < 0 ? oldest : null,
      unsupported: group.unsupported,
    };
  });
}

/** Russian plural form: 1 виджет, 2 виджета, 5 виджетов. */
export function plural(count: number, forms: readonly [string, string, string]): string {
  const n = Math.abs(count) % 100;
  const n1 = n % 10;
  if (n > 10 && n < 20) return forms[2];
  if (n1 > 1 && n1 < 5) return forms[1];
  if (n1 === 1) return forms[0];
  return forms[2];
}

function button(dataset: Record<string, string>, className: string): HTMLButtonElement {
  const el = document.createElement("button");
  el.type = "button";
  el.className = className;
  for (const [key, value] of Object.entries(dataset)) el.dataset[key] = value;
  return el;
}

/** Decorative inline SVG; never carries text. */
function glyph(name: IconName, size?: number): HTMLSpanElement {
  const el = document.createElement("span");
  el.className = "glyph";
  el.setAttribute("aria-hidden", "true");
  el.innerHTML = icon(name, size);
  return el;
}

function text(className: string, value: string): HTMLSpanElement {
  const el = document.createElement("span");
  if (className !== "") el.className = className;
  el.textContent = value;
  return el;
}

export class Shell {
  private versions: PluginDescriptorDTO[] = [];
  private active: Record<string, string> = {};
  private catalog: PluginEntry[] = [];
  private appInfo: AppInfo | null = null;
  /** Common ancestor of the catalog, the top bar and the canvas. */
  private readonly appRoot: HTMLElement;

  constructor(
    private readonly deps: ShellDeps,
    private readonly root: HTMLElement,
    private readonly bar: HTMLElement,
  ) {
    this.appRoot = root.parentElement ?? root;
    this.renderCatalog();
    this.renderBar();
    this.syncThemeIcon();
    // One delegated listener covers the catalog, the top bar and the canvas
    // (its empty state offers quick-add buttons).
    this.appRoot.addEventListener("click", this.onClick);
    this.root.addEventListener("change", this.onChange);
    this.root.addEventListener("submit", this.onSubmit);
  }

  /** Handles the "Разработка" add-form. */
  private onSubmit = (event: SubmitEvent): void => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || form.dataset.devForm === undefined) return;
    event.preventDefault();
    const idInput = form.querySelector<HTMLInputElement>("[data-dev-id]")!;
    const originInput = form.querySelector<HTMLInputElement>("[data-dev-origin]")!;
    const result = addDevPlugin(this.deps.dev.list(), idInput.value, originInput.value);
    if (!result.ok) {
      this.showStatus(result.error ?? "Не удалось включить разработку", "error");
      return;
    }
    idInput.value = "";
    originInput.value = "";
    this.paint();
  };

  /** The one status surface of the host, shared by upload and every UI flow. */
  showStatus(message: string, level: StatusLevel = "info"): void {
    this.deps.toasts.showStatus(message, level);
  }

  /** Registry entries as the catalog shows them. */
  get entries(): PluginEntry[] {
    return this.catalog;
  }

  /** Title, icon and active version of one plugin, when the registry has it. */
  describe(pluginId: string): { title: string; icon: string; version: string } | undefined {
    const entry = this.catalog.find((candidate) => candidate.id === pluginId);
    return entry === undefined
      ? undefined
      : { title: entry.title, icon: entry.icon, version: entry.active };
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

  /** Re-read what depends on the canvas (instance counts) without a fetch. */
  repaint(): void {
    this.paint();
  }

  /** Uploads one archive and reports the outcome; the host refreshes via `onUpload`. */
  async upload(file: File): Promise<void> {
    this.setUploading(true);
    try {
      const result = await this.deps.onUpload(file);
      // The one place an upload outcome is reported, so nothing overwrites an
      // error with a later "uploaded".
      this.showStatus(
        result.message ?? (result.ok ? "загружено" : "ошибка загрузки"),
        result.level ?? (result.ok ? "info" : "error"),
      );
    } catch (error: unknown) {
      this.showStatus(errorMessage(error), "error");
    } finally {
      this.setUploading(false);
    }
  }

  setCanvasCount(count: number): void {
    const chip = this.bar.querySelector<HTMLElement>("[data-canvas-count]");
    if (chip === null) return;
    chip.textContent = `${count} ${plural(count, ["виджет", "виджета", "виджетов"])}`;
    chip.hidden = count === 0;
  }

  /** Marks the dev loop in the top bar; the chip lists every dev plugin id. */
  setDev(dev: DevPlugin[] | undefined): void {
    const chip = this.bar.querySelector<HTMLElement>("[data-dev-chip]");
    const ids = dev?.map((entry) => entry.id) ?? [];
    if (ids.length === 0) {
      chip?.remove();
      return;
    }
    const label = `dev: ${ids.join(", ")}`;
    if (chip === null) {
      const title = this.bar.querySelector<HTMLElement>(".bar-title");
      if (title === null) return;
      const created = document.createElement("span");
      created.className = "chip chip-mono dev-chip";
      created.dataset.devChip = "";
      title.appendChild(created);
    }
    const mark = this.bar.querySelector<HTMLElement>("[data-dev-chip]")!;
    mark.textContent = label;
    mark.title = `Разработка: фреймы ${ids.join(", ")} грузятся с dev-серверов (см. «Разработка» в каталоге)`;
  }

  /** Swaps the top bar between the canvas and the app view. */
  setApp(app: AppInfo | null): void {
    this.appInfo = app;
    this.paintApp();
  }

  /** Updates who the open app is; the route stays with the host's router. */
  setAppIdentity(identity: { title: string; icon?: string; version: string }): void {
    if (this.appInfo === null) return;
    this.appInfo = { ...this.appInfo, ...identity };
    this.paintApp();
  }

  private paintApp(): void {
    const app = this.appInfo;
    this.appRoot.classList.toggle("app-open", app !== null);
    if (app === null) return;
    this.appRoot.classList.remove("catalog-open");
    const fill = (selector: string, value: string): void => {
      const el = this.bar.querySelector<HTMLElement>(selector);
      if (el !== null) el.textContent = value;
    };
    fill("[data-app-title]", app.title);
    fill("[data-app-version]", `v${app.version}`);
    fill("[data-app-route]", app.route);
    const mark = this.bar.querySelector<HTMLElement>("[data-app-icon]");
    if (mark !== null) mark.innerHTML = icon(pluginGlyph(app.icon));
    this.bar.querySelector<HTMLElement>("[data-app-version]")?.toggleAttribute("hidden", false);
    this.bar.querySelector<HTMLElement>("[data-app-route]")?.toggleAttribute("hidden", false);
  }

  private renderCatalog(): void {
    this.root.innerHTML = `
      <div class="brand">${icon("logo", 20)}<span class="brand-name">VIBE</span><span class="brand-sub">Plugin Platform</span></div>
      <nav class="catalog-body" aria-label="Установленные плагины">
        <section class="catalog-section" data-section="dev">
          <h2 class="catalog-title">Разработка <span class="catalog-count" data-count="dev"></span></h2>
          <form class="dev-form" data-dev-form>
            <input type="text" data-dev-id list="dev-plugin-ids" placeholder="id плагина (см. под строкой в каталоге)" aria-label="id плагина">
            <input type="text" data-dev-origin placeholder="http://localhost:5173" aria-label="dev-origin">
            <button type="submit" class="btn btn-sm dev-chip" aria-label="Включить разработку" title="Фреймы этого плагина будут грузиться с dev-сервера">＋ dev</button>
            <datalist id="dev-plugin-ids"></datalist>
          </form>
          <ul class="plugin-list" data-dev-list></ul>
        </section>
        <section class="catalog-section" data-section="widgets" hidden>
          <h2 class="catalog-title">Виджеты <span class="catalog-count" data-count="widgets"></span></h2>
          <ul class="plugin-list" data-widgets></ul>
        </section>
        <section class="catalog-section" data-section="apps" hidden>
          <h2 class="catalog-title">Приложения <span class="catalog-count" data-count="apps"></span></h2>
          <ul class="plugin-list" data-apps></ul>
        </section>
        <div class="catalog-empty" data-catalog-empty hidden>
          <strong>Плагины ещё не установлены</strong>
          <span>Загрузите zip-архив — плагин появится здесь.</span>
        </div>
      </nav>
      <div class="catalog-foot">
        <label class="upload-zone" data-upload-zone>
          <input type="file" accept=".zip,application/zip" data-upload aria-label="Загрузить zip">
          ${icon("upload", 18)}
          <span class="upload-title" data-upload-title>Загрузить zip</span>
          <span class="upload-hint">или перетащите архив в окно</span>
        </label>
      </div>
    `;
    this.root.id = "shell";
    this.root.className = "catalog";
    this.root.addEventListener("submit", this.onSubmit);
  }

  private renderBar(): void {
    this.bar.className = "topbar";
    this.bar.innerHTML = `
      <button type="button" class="btn btn-icon btn-ghost catalog-toggle" data-catalog-toggle aria-label="Каталог плагинов" aria-controls="shell">${icon("menu")}</button>
      <div class="bar-title canvas-only">
        <h1 class="page-title">Холст</h1>
        <span class="chip" data-canvas-count hidden></span>
      </div>
      <div class="app-bar app-only">
        <button type="button" class="btn btn-ghost" data-close-app>${icon("arrow-left")}<span>Холст</span></button>
        <div class="app-identity">
          <span class="plugin-icon plugin-icon-sm" data-app-icon aria-hidden="true"></span>
          <span class="plugin-name" data-app-title></span>
          <span class="chip chip-mono" data-app-version hidden></span>
          <span class="chip chip-mono app-route" data-app-route hidden></span>
        </div>
      </div>
      <div class="bar-tools">
        <button type="button" class="btn btn-icon btn-ghost catalog-toggle" data-pick-zip aria-label="Загрузить zip" title="Загрузить zip">${icon("upload")}</button>
        <button type="button" class="btn btn-icon btn-ghost" data-theme-toggle aria-label="Переключить тему" title="Переключить тему"></button>
      </div>
    `;
  }

  private setUploading(busy: boolean): void {
    const zone = this.root.querySelector<HTMLElement>("[data-upload-zone]");
    const title = this.root.querySelector<HTMLElement>("[data-upload-title]");
    if (zone !== null) zone.setAttribute("aria-busy", String(busy));
    if (title !== null) title.textContent = busy ? "Загружаем…" : "Загрузить zip";
  }

  private onThemeToggle(): void {
    const theme = toggleTheme();
    this.syncThemeIcon();
    this.deps.onThemeToggle?.(theme);
  }

  private syncThemeIcon(): void {
    const control = this.bar.querySelector<HTMLElement>("[data-theme-toggle]");
    if (control === null) return;
    const light = currentTheme() === "light";
    const label = light ? "Переключить на тёмную тему" : "Переключить на светлую тему";
    control.innerHTML = icon(light ? "moon" : "sun");
    control.setAttribute("aria-label", label);
    control.title = label;
  }

  private onClick = (event: MouseEvent): void => {
    const target = event.target as Element | null;
    const backdrop = target?.closest("[data-catalog-backdrop]");
    if (backdrop !== null && backdrop !== undefined) {
      this.appRoot.classList.remove("catalog-open");
      return;
    }
    const el = target?.closest<HTMLElement>("button");
    if (el === null || el === undefined || !this.appRoot.contains(el)) return;
    const { addWidget, quickAdd, launch, upgrade, rollback, version, themeToggle, closeApp, catalogToggle, pickZip, devRemove } =
      el.dataset;
    if (addWidget !== undefined) this.deps.onAddWidget(addWidget);
    else if (quickAdd !== undefined) this.deps.onAddWidget(quickAdd);
    else if (launch !== undefined) this.deps.onLaunchApp(launch);
    else if (upgrade !== undefined) this.deps.onUpgrade(upgrade, version ?? "");
    else if (rollback !== undefined) this.deps.onRollback(rollback, version ?? "");
    else if (closeApp !== undefined) this.deps.onCloseApp();
    else if (themeToggle !== undefined) this.onThemeToggle();
    else if (catalogToggle !== undefined) this.appRoot.classList.toggle("catalog-open");
    else if (pickZip !== undefined) this.pickZip();
    else if (devRemove !== undefined) {
      removeDevPlugin(this.deps.dev.list(), devRemove);
      this.paint();
    }
  };

  /** Opens the file picker of the one hidden `[data-upload]` input. */
  private pickZip(): void {
    this.root.querySelector<HTMLInputElement>("[data-upload]")?.click();
  }

  private onChange = (event: Event): void => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || input.dataset.upload === undefined) return;
    const file = input.files?.[0];
    if (file === undefined) return;
    // Let the same archive be picked again later.
    try {
      input.value = "";
    } catch {
      // Some DOM shims refuse the reset; the upload itself is unaffected.
    }
    void this.upload(file);
  };

  private paint(): void {
    this.catalog = groupPlugins(this.versions, this.active);
    this.renderSection("widgets", this.catalog.filter((entry) => entry.kind === "widget"));
    this.renderSection("apps", this.catalog.filter((entry) => entry.kind === "app"));
    this.renderDev();
    const empty = this.root.querySelector<HTMLElement>("[data-catalog-empty]");
    if (empty !== null) empty.hidden = this.catalog.length > 0;
    this.setDev(this.deps.dev.list());
  }

  /** The "Разработка" section: dev entries plus the installed ids they shadow. */
  private renderDev(): void {
    const list = this.root.querySelector<HTMLElement>("[data-dev-list]");
    const count = this.root.querySelector<HTMLElement>('[data-count="dev"]');
    if (list === null || count === null) return;
    const entries = this.deps.dev.list();
    count.textContent = String(entries.length);
    list.replaceChildren(...entries.map((entry) => this.devRow(entry)));
    // The dev form autocompletes with the installed plugin ids.
    const ids = this.root.querySelector<HTMLDataListElement>("#dev-plugin-ids");
    if (ids !== null) {
      ids.replaceChildren(
        ...this.catalog.map((entry) => {
          const option = document.createElement("option");
          option.value = entry.id;
          return option;
        }),
      );
    }
    // An installed plugin running from a dev origin gets a badge on its row.
    for (const row of this.root.querySelectorAll<HTMLElement>(".plugin[data-plugin]")) {
      row.dataset.dev = entries.some((entry) => entry.id === row.dataset.plugin) ? "" : undefined;
    }
  }

  private devRow(entry: DevPlugin): HTMLLIElement {
    const row = document.createElement("li");
    row.className = "plugin";
    row.dataset.devPlugin = entry.id;
    row.dataset.dev = "";

    const symbol = document.createElement("span");
    symbol.className = "plugin-icon";
    symbol.setAttribute("aria-hidden", "true");
    symbol.innerHTML = icon("puzzle");

    const info = document.createElement("div");
    info.className = "plugin-info";
    info.append(text("plugin-name", entry.id));
    const meta = document.createElement("div");
    meta.className = "plugin-meta";
    meta.append(text("plugin-note dev-origin", entry.origin));
    info.append(meta);
    row.append(symbol, info);

    const actions = document.createElement("div");
    actions.className = "dev-actions";
    const add = button({ addWidget: entry.id }, "btn btn-sm btn-accent");
    add.innerHTML = icon("plus");
    add.title = "Добавить как виджет";
    add.setAttribute("aria-label", `Добавить «${entry.id}» как виджет`);
    const launch = button({ launch: entry.id }, "btn btn-sm");
    launch.innerHTML = icon("play");
    launch.title = "Открыть как приложение";
    launch.setAttribute("aria-label", `Открыть «${entry.id}» как приложение`);
    const remove = button({ devRemove: entry.id }, "btn btn-sm btn-ghost dev-remove");
    remove.innerHTML = icon("close", 14);
    remove.title = "Выключить разработку";
    remove.setAttribute("aria-label", `Выключить разработку для «${entry.id}»`);
    actions.append(add, launch, remove);
    row.append(actions);
    return row;
  }

  private renderSection(name: "widgets" | "apps", entries: PluginEntry[]): void {
    const section = this.root.querySelector<HTMLElement>(`[data-section="${name}"]`);
    const list = this.root.querySelector<HTMLElement>(`[data-${name}]`);
    const count = this.root.querySelector<HTMLElement>(`[data-count="${name}"]`);
    if (section === null || list === null || count === null) return;
    section.hidden = entries.length === 0;
    count.textContent = String(entries.length);
    list.replaceChildren(...entries.map((entry) => this.pluginRow(entry)));
  }

  private pluginRow(entry: PluginEntry): HTMLLIElement {
    const row = document.createElement("li");
    row.className = "plugin";
    row.dataset.plugin = entry.id;
    if (entry.newer !== null) row.dataset.update = "newer";
    else if (entry.older !== null) row.dataset.update = "older";

    const symbol = document.createElement("span");
    symbol.className = "plugin-icon";
    symbol.setAttribute("aria-hidden", "true");
    symbol.innerHTML = icon(pluginGlyph(entry.icon));

    const info = document.createElement("div");
    info.className = "plugin-info";
    const name = text("plugin-name", entry.title);
    name.title = entry.title;
    const meta = document.createElement("div");
    meta.className = "plugin-meta";
    meta.append(text("chip chip-mono", `v${entry.active}`));
    if (entry.installed.length > 1) {
      meta.append(
        text(
          "plugin-note",
          `${entry.installed.length} ${plural(entry.installed.length, ["версия", "версии", "версий"])}`,
        ),
      );
    }
    const instances = entry.kind === "widget" ? (this.deps.instanceCount?.(entry.id) ?? 0) : 0;
    if (instances > 0) meta.append(text("plugin-note", `на холсте: ${instances}`));
    // The id is what the dev form and the CLI ask for: keep it visible.
    meta.append(text("plugin-note chip-mono", entry.id));
    if (this.deps.dev.list().some((dev) => dev.id === entry.id)) {
      meta.append(text("chip chip-mono dev-chip", "dev"));
    }
    info.append(name, meta);
    row.append(symbol, info);

    if (entry.kind === "widget") {
      const add = button({ addWidget: entry.id }, "btn btn-sm btn-accent");
      add.innerHTML = icon("plus");
      add.setAttribute("aria-label", `Добавить «${entry.title}» на холст`);
      add.title = "Добавить на холст";
      row.append(add);
    } else {
      const launch = button({ launch: entry.id }, "btn btn-sm");
      launch.innerHTML = icon("play");
      launch.setAttribute("aria-label", `Открыть «${entry.title}» на весь экран`);
      launch.title = "Открыть на весь экран";
      row.append(launch);
    }

    if (entry.newer !== null || entry.older !== null) {
      const actions = document.createElement("div");
      actions.className = "plugin-actions";
      if (entry.newer !== null) {
        const upgrade = button({ upgrade: entry.id, version: entry.newer }, "version-action update");
        upgrade.title = "Обновить";
        upgrade.append(
          glyph("arrow-up"),
          text("", "доступно обновление"),
          document.createTextNode(" "),
          text("va-versions", `${entry.active} → ${entry.newer}`),
        );
        actions.append(upgrade);
      }
      if (entry.older !== null) {
        const rollback = button({ rollback: entry.id, version: entry.older }, "version-action rollback");
        rollback.title = "Откатить";
        rollback.append(
          glyph("undo"),
          text("", "Откатить"),
          document.createTextNode(" "),
          text("va-versions", `${entry.active} → ${entry.older}`),
        );
        actions.append(rollback);
      }
      row.append(actions);
    }
    return row;
  }
}
