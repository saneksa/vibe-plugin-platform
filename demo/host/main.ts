/**
 * Thin demo host: builds the DOM shell, wires UI callbacks to `host-core`, and
 * owns the virtual URL router (`/` for widgets, `/app/<iid>/<path>` for apps).
 * All instance/layout state stays inside `FrameManager`/`HostState`.
 */

import {
  createFrameManager,
  type FrameManager,
  type PluginDescriptor,
} from "@vibe/plugin-contracts/host-core";
import { encodeEnvelope, type Envelope } from "@vibe/plugin-contracts/protocol";
import { AppLauncher } from "./AppLauncher.js";
import {
  CANVAS_ID,
  Canvas,
  frameSlot,
  setCanvasResizeHandler,
  type TileMeta,
} from "./Canvas.js";
import { DemoHostAdapter } from "./DemoHostAdapter.js";
import { icon, pluginGlyph } from "./icons.js";
import { RegistryClient } from "./RegistryClient.js";
import { errorMessage, Shell } from "./Shell.js";
import { Toasts } from "./Toasts.js";
import { applyStoredTheme, currentTheme } from "./theme.js";

export const PLUGIN_ORIGIN = "http://localhost:4001";
export const HOST_VERSION = "2.4.0";

const APP_STAGE_ID = "app-stage";
const APP_FRAME_ID = "app-frame";

export interface BootOptions {
  fetch?: typeof fetch;
  baseUrl?: string;
  root?: HTMLElement;
}

interface Runtime {
  fm: FrameManager;
  registry: RegistryClient;
  launcher: AppLauncher;
  shell: Shell;
  toasts: Toasts;
  frames: Map<string, HTMLIFrameElement>;
  appIid: string | null;
}

let runtime: Runtime | null = null;
let popstateBound = false;
let dropBound = false;
let dropOverlay: HTMLElement | null = null;
let dropDepth = 0;

/** `path` is absent when the URL is bare `/app/<iid>`: keep the stored route. */
function parseAppUrl(): { iid: string; path?: string } | null {
  const match = /^\/app\/([^/]+)(?:\/(.*))?$/.exec(window.location.pathname);
  if (match === null) return null;
  const rest = match[2];
  return rest === undefined || rest === ""
    ? { iid: decodeURIComponent(match[1]!) }
    : { iid: decodeURIComponent(match[1]!), path: `/${rest}` };
}

function descriptorOf(dto: {
  id: string;
  version: string;
  kind: "widget" | "app";
  capabilities: string[];
  hostApi: string;
}): PluginDescriptor {
  return {
    id: dto.id,
    version: dto.version,
    kind: dto.kind,
    entry: "index.html",
    capabilities: dto.capabilities,
    hostApi: dto.hostApi,
  };
}

/** Host → plugin envelopes go through the mounted frame at the plugin origin. */
function post(iid: string, envelope: Envelope): void {
  const win = runtime?.frames.get(iid)?.contentWindow ?? null;
  if (win !== null) win.postMessage(encodeEnvelope(envelope), PLUGIN_ORIGIN);
}

function postAll(state: "suspend" | "resume", exceptIid: string | null): void {
  const rt = runtime;
  if (rt === null) return;
  for (const [iid, frame] of rt.frames) {
    if (iid === exceptIid || !document.contains(frame)) continue;
    post(iid, { type: "lifecycle", iid, state });
  }
}

/**
 * Shows the loading state of a freshly mounted frame. First mounts get the
 * skeleton; in-place rebuilds (upgrade/rollback recreate the iframe) only dim
 * the content — a skeleton there reads as the tile "shrinking" for a moment.
 * `FrameManager` can rebuild frames in place, so the host re-runs this after
 * every rebuild.
 */
function decorateFrame(
  iid: string,
  frame: HTMLIFrameElement,
  opts: { rebuild?: boolean } = {},
): void {
  const rt = runtime;
  const container = frame.parentElement;
  if (rt === null || container === null) return;
  const pluginId = rt.fm.state.getInstances()[iid]?.pluginId;
  const meta = pluginId === undefined ? undefined : rt.shell.describe(pluginId);
  frame.title = meta === undefined ? "Плагин" : `${meta.title} — плагин`;
  container.setAttribute(opts.rebuild ? "data-rebuilding" : "data-loading", "");
  frame.addEventListener(
    "load",
    () => {
      if (!frame.isConnected) return;
      container.removeAttribute("data-loading");
      container.removeAttribute("data-rebuilding");
    },
    { once: true },
  );
}

/** After `fm.upgrade` / `fm.restore` the DOM holds new frame elements. */
function syncFramesFromDom(): void {
  const rt = runtime;
  if (rt === null) return;
  const known = new Map(rt.frames);
  rt.frames.clear();
  for (const frame of document.querySelectorAll<HTMLIFrameElement>("iframe")) {
    const iid = new URL(frame.getAttribute("src") ?? "", "http://localhost").searchParams.get("iid");
    if (iid === null) continue;
    rt.frames.set(iid, frame);
    // Only rebuilt frames are new DOM nodes; the others have already loaded.
    if (known.get(iid) !== frame) decorateFrame(iid, frame, { rebuild: true });
  }
  refreshTileHeaders();
}

/** Frames are rebuilt in place, so the version in tile headers follows the state. */
function refreshTileHeaders(): void {
  const rt = runtime;
  if (rt === null) return;
  const instances = rt.fm.state.getInstances();
  for (const slot of document.querySelectorAll<HTMLElement>(`#${CANVAS_ID} .frame-slot`)) {
    const record = instances[slot.dataset.iid ?? ""];
    const meta: TileMeta = {
      title: rt.shell.describe(record?.pluginId ?? "")?.title ?? record?.pluginId ?? "",
      version: record?.version ?? "",
    };
    const version = slot.querySelector<HTMLElement>('[data-role="version"]');
    if (version !== null) version.textContent = meta.version === "" ? "" : `v${meta.version}`;
    const title = slot.querySelector<HTMLElement>('[data-role="title"]');
    if (title !== null && meta.title !== "") title.textContent = meta.title;
  }
  if (rt.appIid !== null) {
    const record = instances[rt.appIid];
    const described = record === undefined ? undefined : rt.shell.describe(record.pluginId);
    if (record !== undefined && described !== undefined) {
      rt.shell.setAppIdentity({
        title: described.title,
        icon: described.icon,
        version: record.version,
      });
    }
  }
}

/** Pane-level error state: an error card in the pane instead of a blank frame. */
function showFrameError(iid: string, message: string): void {
  const rt = runtime;
  if (rt === null) return;
  const container = rt.appIid === iid ? document.getElementById(APP_FRAME_ID) : frameSlot(iid);
  if (container === null) return;
  container.removeAttribute("data-loading");
  container.removeAttribute("data-rebuilding");
  container.querySelector(".frame-error")?.remove();
  const card = document.createElement("div");
  card.className = "frame-error";
  card.dataset.iid = iid;
  card.setAttribute("role", "alert");
  card.textContent = message;
  container.appendChild(card);
}

let widgetMenuClose: (() => void) | null = null;

function closeWidgetMenu(): void {
  if (widgetMenuClose !== null) {
    document.removeEventListener("click", widgetMenuClose);
    widgetMenuClose = null;
  }
  document.querySelector("[data-widget-menu]")?.remove();
}

/** Shared by the tile header button and the right-click menu: removal goes through host-core. */
function removeWidget(iid: string): void {
  const rt = runtime;
  if (rt === null) return;
  closeWidgetMenu();
  const pluginId = rt.fm.state.getInstances()[iid]?.pluginId;
  const title = pluginId === undefined ? undefined : rt.shell.describe(pluginId)?.title;
  rt.fm.unmount(iid);
  rt.fm.state.removeWidget(iid);
  rt.frames.delete(iid);
  renderCanvas();
  rt.shell.showStatus(`Виджет${title === undefined ? "" : ` «${title}»`} удалён`, "info");
}

/** Right-click menu for one widget pane; deletion goes through host-core. */
function showWidgetMenu(iid: string, x: number, y: number): void {
  const rt = runtime;
  if (rt === null) return;
  closeWidgetMenu();
  const menu = document.createElement("div");
  menu.className = "widget-menu";
  menu.dataset.widgetMenu = iid;
  const remove = document.createElement("button");
  remove.type = "button";
  remove.dataset.removeWidget = iid;
  remove.dataset.iid = iid;
  remove.innerHTML = icon("trash", 14);
  remove.append(document.createTextNode("Удалить виджет"));
  remove.addEventListener("click", () => removeWidget(iid));
  menu.appendChild(remove);
  document.body.appendChild(menu);
  // Keep the menu inside the window when it opens near an edge.
  const box = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - box.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - box.height - 8))}px`;
  widgetMenuClose = () => closeWidgetMenu();
  document.addEventListener("click", widgetMenuClose, { once: true });
}

function widgetCount(): number {
  return document.querySelectorAll(`#${CANVAS_ID} .frame-slot`).length;
}

/** Canvas-dependent chrome: the empty state, the widget counter, instance counts. */
function syncChrome(): void {
  const rt = runtime;
  if (rt === null) return;
  renderEmptyState();
  rt.shell.setCanvasCount(widgetCount());
  rt.shell.repaint();
}

/** Empty canvas: what to do next, and the shortest way to do it. */
function renderEmptyState(): void {
  const rt = runtime;
  const canvas = document.getElementById(CANVAS_ID);
  if (rt === null || canvas === null) return;
  canvas.querySelector(".canvas-empty")?.remove();
  if (rt.fm.state.getLayout() !== null) return;

  const entries = rt.shell.entries;
  const installed = entries.length > 0;
  const empty = document.createElement("div");
  empty.className = "canvas-empty";
  empty.innerHTML =
    `<div class="empty-art" aria-hidden="true">${icon("tiles", 40)}</div>` +
    '<h2 class="empty-title"></h2><div class="empty-text"></div><div class="empty-actions"></div>';
  empty.querySelector(".empty-title")!.textContent = installed
    ? "Холст пуст"
    : "Плагины ещё не установлены";
  empty.querySelector(".empty-text")!.textContent = installed
    ? "Добавьте виджет из каталога слева — он появится здесь плиткой. Размеры плиток меняются перетаскиванием разделителей."
    : "Загрузите zip-архив плагина — он появится в каталоге слева.";

  const actions = empty.querySelector(".empty-actions")!;
  if (!installed) {
    const upload = document.createElement("button");
    upload.type = "button";
    upload.className = "btn btn-primary";
    upload.dataset.pickZip = "";
    upload.innerHTML = `${icon("upload")}<span>Загрузить zip</span>`;
    actions.append(upload);
  } else {
    // A convenience, deliberately not a catalog hook: `data-add-widget` must
    // stay unique per plugin for the tests.
    for (const entry of entries.filter((candidate) => candidate.kind === "widget")) {
      const add = document.createElement("button");
      add.type = "button";
      add.className = "btn";
      add.dataset.quickAdd = entry.id;
      add.innerHTML = `<span class="plugin-icon plugin-icon-sm" aria-hidden="true">${icon(pluginGlyph(entry.icon))}</span>`;
      add.append(document.createTextNode(entry.title));
      actions.append(add);
    }
  }
  if (actions.childElementCount === 0) actions.remove();
  canvas.appendChild(empty);
}

function renderCanvas(): void {
  const rt = runtime;
  if (rt === null) return;
  Canvas.render(
    rt.fm.state.getLayout(),
    (iid) => {
      const slot = frameSlot(iid);
      if (slot === null) return;
      slot.querySelector("[data-remove-widget]")?.addEventListener("click", () => removeWidget(iid));
      rt.fm.mount(slot, iid);
      const frame = slot.querySelector<HTMLIFrameElement>("iframe");
      if (frame !== null) {
        rt.frames.set(iid, frame);
        decorateFrame(iid, frame);
      }
    },
    showWidgetMenu,
    (leaf) => {
      const meta = rt.shell.describe(leaf.pluginId);
      return { title: meta?.title ?? leaf.pluginId, icon: meta?.icon, version: leaf.version };
    },
  );
  syncChrome();
}

function closeCurrentAppFrame(): void {
  const rt = runtime;
  if (rt === null) return;
  if (rt.appIid !== null) {
    rt.fm.unmount(rt.appIid);
    rt.frames.delete(rt.appIid);
  }
  const stage = document.getElementById(APP_FRAME_ID);
  stage?.replaceChildren();
  if (stage !== null) delete stage.dataset.loading;
  rt.appIid = null;
}

function mountApp(iid: string, path?: string): void {
  const rt = runtime;
  const stage = document.getElementById(APP_FRAME_ID);
  if (rt === null || stage === null) return;
  stage.replaceChildren();
  rt.fm.mount(stage, iid, path); // undefined → FrameManager uses the stored route
  const frame = stage.querySelector<HTMLIFrameElement>("iframe");
  if (frame !== null) {
    rt.frames.set(iid, frame);
    decorateFrame(iid, frame);
  }
  rt.appIid = iid;
}

function appUrl(iid: string, path: string): string {
  const tail = path.replace(/^\/+|\/+$/g, "");
  return tail === "" ? `/app/${iid}` : `/app/${iid}/${tail}`;
}

function showApp(
  iid: string,
  path: string | undefined,
  push: boolean,
  replace = false,
): void {
  const rt = runtime;
  if (rt === null) return;
  const record = rt.fm.state.getInstances()[iid];
  if (record === undefined || record.kind !== "app") return;
  const route = path ?? record.route ?? "/";

  const frameMounted =
    rt.appIid === iid && document.getElementById(APP_FRAME_ID)?.querySelector("iframe") !== null;
  if (!frameMounted) {
    if (rt.appIid !== null && rt.appIid !== iid) rt.fm.state.closeApp();
    closeCurrentAppFrame();
    rt.fm.activateApp(iid);
    mountApp(iid, path);
    postAll("suspend", iid);
  }

  document.getElementById(CANVAS_ID)?.classList.add("hidden");
  document.getElementById(APP_STAGE_ID)?.classList.remove("hidden");
  rt.shell.setApp({ ...(rt.shell.describe(record.pluginId) ?? {
    title: record.pluginId,
    icon: "",
    version: record.version,
  }), route });
  const url = appUrl(iid, route);
  if (push && window.location.pathname !== url) {
    if (replace) window.history.replaceState(null, "", url);
    else window.history.pushState(null, "", url);
  }
  post(iid, { type: "route", iid, path: route });
}

function closeApp(): void {
  const rt = runtime;
  if (rt === null) return;
  closeCurrentAppFrame();
  rt.fm.state.closeApp();
  document.getElementById(APP_STAGE_ID)?.classList.add("hidden");
  document.getElementById(CANVAS_ID)?.classList.remove("hidden");
  rt.shell.setApp(null);
  postAll("resume", null);
  if (window.location.pathname !== "/") window.history.pushState(null, "", "/");
}

/** popstate: resolve the iid from the persisted registry, never reallocate it. */
function applyLocation(): void {
  const rt = runtime;
  if (rt === null) return;
  const target = parseAppUrl();
  if (target !== null && rt.fm.state.getInstances()[target.iid]?.kind === "app") {
    showApp(target.iid, target.path, false);
  } else {
    closeApp();
  }
}

function appContainer(root?: HTMLElement): HTMLElement {
  if (root !== undefined) return root;
  const existing = document.getElementById("app");
  if (existing !== null) return existing;
  const created = document.createElement("div");
  created.id = "app";
  document.body.appendChild(created);
  return created;
}

function isFileDrag(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}

/** Drag-and-drop upload: an archive can be dropped anywhere on the page. */
function watchDrops(): void {
  if (dropBound) return;
  dropBound = true;
  const hide = (): void => {
    dropDepth = 0;
    if (dropOverlay !== null) dropOverlay.hidden = true;
  };
  window.addEventListener("dragenter", (event) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    dropDepth += 1;
    if (dropOverlay !== null) dropOverlay.hidden = false;
  });
  window.addEventListener("dragover", (event) => {
    if (isFileDrag(event)) event.preventDefault();
  });
  window.addEventListener("dragleave", () => {
    dropDepth = Math.max(0, dropDepth - 1);
    if (dropDepth === 0 && dropOverlay !== null) dropOverlay.hidden = true;
  });
  window.addEventListener("drop", (event) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    hide();
    const file = event.dataTransfer?.files[0];
    if (file !== undefined) void runtime?.shell.upload(file);
  });
}

export function boot(opts: BootOptions = {}): FrameManager {
  applyStoredTheme();
  const root = appContainer(opts.root);
  root.replaceChildren();

  const shellRoot = document.createElement("aside");
  shellRoot.id = "shell";
  shellRoot.className = "catalog";
  const backdrop = document.createElement("div");
  backdrop.className = "catalog-backdrop";
  backdrop.dataset.catalogBackdrop = "";
  const workspace = document.createElement("div");
  workspace.className = "workspace";
  const bar = document.createElement("header");
  const canvasRoot = document.createElement("main");
  canvasRoot.id = CANVAS_ID;
  const stageRoot = document.createElement("section");
  stageRoot.id = APP_STAGE_ID;
  stageRoot.classList.add("hidden");
  stageRoot.innerHTML = `<div id="${APP_FRAME_ID}" class="app-frame"></div>`;
  const toastRoot = document.createElement("div");
  dropOverlay = document.createElement("div");
  dropOverlay.className = "drop-overlay";
  dropOverlay.hidden = true;
  dropOverlay.innerHTML = `<div class="drop-card">${icon("upload", 28)}<span>Отпустите, чтобы загрузить плагин</span></div>`;
  workspace.append(bar, canvasRoot, stageRoot, toastRoot);
  root.append(shellRoot, backdrop, workspace, dropOverlay);

  const registry = new RegistryClient({ fetch: opts.fetch, baseUrl: opts.baseUrl });
  const adapter = new DemoHostAdapter({
    pluginOrigin: PLUGIN_ORIGIN,
    frameBase: (d) => `${PLUGIN_ORIGIN}/plugins/${d.id}/${d.version}/index.html`,
    registry,
    store: window.localStorage,
    hostVersion: HOST_VERSION,
    // A plugin's navigate envelope must be echoed back as `route` (spec §12):
    // only the host knows the full /app/<iid>/<path> URL.
    onNavigate: (iid, path, replace) => showApp(iid, path, true, replace),
    // Plugins see the theme the chrome is painted in.
    getTheme: currentTheme,
    onNotify: (notification) => rt.toasts.push(notification.message, notification.level),
  });
  const fm = createFrameManager({ adapter, onFrameError: showFrameError });
  const rt: Runtime = {
    fm,
    registry,
    launcher: null as unknown as AppLauncher,
    shell: null as unknown as Shell,
    toasts: new Toasts(toastRoot),
    frames: new Map(),
    appIid: null,
  };
  runtime = rt;
  setCanvasResizeHandler((path, ratio) => fm.state.resize(path, ratio));

  const switchVersion = (pluginId: string, version: string): void => {
    const before = rt.shell.describe(pluginId)?.version ?? "?";
    void (async () => {
      try {
        await registry.setActive(pluginId, version);
        await fm.upgrade(pluginId, version);
      } catch (error: unknown) {
        rt.shell.showStatus(`Не удалось обновить плагин: ${errorMessage(error)}`, "error");
        return;
      }
      syncFramesFromDom();
      try {
        await rt.shell.refresh();
      } catch (error: unknown) {
        rt.shell.showStatus(`Не удалось обновить данные реестра: ${errorMessage(error)}`, "error");
        return;
      }
      refreshTileHeaders();
      const title = rt.shell.describe(pluginId)?.title ?? pluginId;
      rt.shell.showStatus(`${title}: ${before} → ${version}. Данные и раскладка сохранены`, "success");
    })();
  };

  rt.shell = new Shell(
    {
      registry,
      toasts: rt.toasts,
      onAddWidget: (pluginId) => {
        void (async () => {
          const [versions, active] = await Promise.all([
            registry.list(),
            registry.getActiveVersions(),
          ]);
          const dto = versions.find((d) => d.id === pluginId);
          if (dto === undefined) return;
          const version = active[pluginId] ?? dto.version;
          fm.createInstance(descriptorOf({ ...dto, version }), "widget");
          renderCanvas();
        })().catch((error: unknown) => {
          rt.shell.showStatus(`Не удалось добавить виджет: ${errorMessage(error)}`, "error");
        });
      },
      onLaunchApp: (pluginId) => rt.launcher.open(pluginId),
      onUpload: async (file) => {
        const result = await registry.upload(file);
        if (!result.ok) return result;
        // The archive is in; refresh the registry-derived UI (catalog, update
        // hints) in place. A failed refresh must not read as a clean success,
        // so the error is reported as part of the upload outcome.
        try {
          await rt.shell.refresh();
          return result;
        } catch (error: unknown) {
          return {
            ...result,
            level: "error" as const,
            message: `${result.message ?? "загружено"}; не удалось обновить данные реестра: ${errorMessage(error)}`,
          };
        }
      },
      onThemeToggle: (theme) => fm.publish("theme.changed", { mode: theme }),
      onUpgrade: switchVersion,
      onRollback: switchVersion,
      onCloseApp: closeApp,
      instanceCount: (pluginId) =>
        Object.values(fm.state.getInstances()).filter(
          (record) => record.kind === "widget" && record.pluginId === pluginId,
        ).length,
    },
    shellRoot,
    bar,
  );
  rt.launcher = new AppLauncher(
    {
      registry,
      createApp: (pluginId, version, route) => {
        const record = fm.createInstance(
          {
            id: pluginId,
            version,
            kind: "app",
            entry: "index.html",
            capabilities: [],
            hostApi: "^2",
          },
          "app",
          route,
        );
        return record.iid;
      },
      showApp: (iid, path) => showApp(iid, path, true),
      closeApp,
      onError: (message) => rt.shell.showStatus(message, "error"),
    },
  );

  watchDrops();
  renderCanvas();
  const target = parseAppUrl();
  if (target !== null && fm.state.getInstances()[target.iid]?.kind === "app") {
    showApp(target.iid, target.path, false);
  } else if (target !== null) {
    window.history.replaceState(null, "", "/");
  }

  void fm
    .restore()
    .catch((error: unknown) => {
      rt.shell.showStatus(`Не удалось восстановить состояние: ${errorMessage(error)}`, "error");
    })
    .then(() => {
      syncFramesFromDom();
      return rt.shell.refresh();
    })
    .catch((error: unknown) => {
      rt.shell.showStatus(`Не удалось обновить данные реестра: ${errorMessage(error)}`, "error");
    })
    // Titles and update hints come from the registry: repaint what used ids as a fallback.
    .then(() => {
      refreshTileHeaders();
      syncChrome();
    });

  if (!popstateBound) {
    window.addEventListener("popstate", applyLocation);
    popstateBound = true;
  }
  return fm;
}
