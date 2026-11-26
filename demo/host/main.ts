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
import { CANVAS_ID, Canvas, frameSlot, setCanvasResizeHandler } from "./Canvas.js";
import { DemoHostAdapter } from "./DemoHostAdapter.js";
import { RegistryClient } from "./RegistryClient.js";
import { errorMessage, Shell } from "./Shell.js";

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
  frames: Map<string, HTMLIFrameElement>;
  appIid: string | null;
}

let runtime: Runtime | null = null;
let popstateBound = false;

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

/** `FrameManager` can rebuild frames in place; re-read their DOM references. */
function syncFramesFromDom(): void {
  const rt = runtime;
  if (rt === null) return;
  rt.frames.clear();
  for (const frame of document.querySelectorAll<HTMLIFrameElement>("iframe")) {
    const iid = new URL(frame.getAttribute("src") ?? "", "http://localhost").searchParams.get("iid");
    if (iid !== null) rt.frames.set(iid, frame);
  }
}

/** Pane-level error state: an error card in the pane instead of a blank frame. */
function showFrameError(iid: string, message: string): void {
  const rt = runtime;
  if (rt === null) return;
  const container = rt.appIid === iid ? document.getElementById(APP_FRAME_ID) : frameSlot(iid);
  if (container === null) return;
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

/** Shared by the right-click menu and the corner icon: remove via host-core. */
function removeWidget(iid: string): void {
  const rt = runtime;
  if (rt === null) return;
  closeWidgetMenu();
  rt.fm.unmount(iid);
  rt.fm.state.removeWidget(iid);
  rt.frames.delete(iid);
  renderCanvas();
}

/** Right-click menu for one widget pane; deletion goes through host-core. */
function showWidgetMenu(iid: string, x: number, y: number): void {
  const rt = runtime;
  if (rt === null) return;
  closeWidgetMenu();
  const menu = document.createElement("div");
  menu.className = "widget-menu";
  menu.dataset.widgetMenu = iid;
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  const remove = document.createElement("button");
  remove.type = "button";
  remove.dataset.removeWidget = iid;
  remove.dataset.iid = iid;
  remove.textContent = "Удалить виджет";
  remove.addEventListener("click", () => removeWidget(iid));
  menu.appendChild(remove);
  document.body.appendChild(menu);
  widgetMenuClose = () => closeWidgetMenu();
  document.addEventListener("click", widgetMenuClose, { once: true });
}

function renderCanvas(): void {
  const rt = runtime;
  if (rt === null) return;
  Canvas.render(rt.fm.state.getLayout(), (iid) => {
    const slot = frameSlot(iid);
    if (slot === null) return;
    slot.replaceChildren();
    rt.fm.mount(slot, iid);
    const frame = slot.querySelector<HTMLIFrameElement>("iframe");
    if (frame !== null) rt.frames.set(iid, frame);
    const icon = document.createElement("button");
    icon.type = "button";
    icon.className = "widget-remove";
    icon.dataset.removeWidget = iid;
    icon.dataset.iid = iid;
    icon.title = "Удалить виджет";
    icon.textContent = "×";
    icon.addEventListener("click", () => removeWidget(iid));
    slot.appendChild(icon);
  }, showWidgetMenu);
}

function closeCurrentAppFrame(): void {
  const rt = runtime;
  if (rt === null) return;
  if (rt.appIid !== null) {
    rt.fm.unmount(rt.appIid);
    rt.frames.delete(rt.appIid);
  }
  document.getElementById(APP_FRAME_ID)?.replaceChildren();
  rt.appIid = null;
}

function mountApp(iid: string, path?: string): void {
  const rt = runtime;
  const stage = document.getElementById(APP_FRAME_ID);
  if (rt === null || stage === null) return;
  stage.replaceChildren();
  rt.fm.mount(stage, iid, path); // undefined → FrameManager uses the stored route
  const frame = stage.querySelector<HTMLIFrameElement>("iframe");
  if (frame !== null) rt.frames.set(iid, frame);
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

export function boot(opts: BootOptions = {}): FrameManager {
  const root = appContainer(opts.root);
  root.replaceChildren();

  const shellRoot = document.createElement("header");
  shellRoot.id = "shell";
  const canvasRoot = document.createElement("main");
  canvasRoot.id = CANVAS_ID;
  const stageRoot = document.createElement("section");
  stageRoot.id = APP_STAGE_ID;
  stageRoot.classList.add("hidden");
  stageRoot.innerHTML = `<button type="button" class="close-app" data-close-app title="Закрыть">×</button><div id="${APP_FRAME_ID}" class="app-frame"></div>`;
  root.append(shellRoot, canvasRoot, stageRoot);

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
  });
  const fm = createFrameManager({ adapter, onFrameError: showFrameError });
  const rt: Runtime = {
    fm,
    registry,
    launcher: null as unknown as AppLauncher,
    shell: null as unknown as Shell,
    frames: new Map(),
    appIid: null,
  };
  runtime = rt;
  setCanvasResizeHandler((path, ratio) => fm.state.resize(path, ratio));

  const switchVersion = (pluginId: string, version: string): void => {
    void (async () => {
      await registry.setActive(pluginId, version);
      await fm.upgrade(pluginId, version);
      syncFramesFromDom();
    })()
      .catch((error: unknown) => {
        rt.shell.showStatus(`Не удалось обновить плагин: ${errorMessage(error)}`, "error");
      })
      .then(() => rt.shell.refresh())
      .catch((error: unknown) => {
        rt.shell.showStatus(`Не удалось обновить данные реестра: ${errorMessage(error)}`, "error");
      });
  };

  rt.shell = new Shell(
    {
      registry,
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
        // Keep the server's message visible while the registry-derived UI
        // (widgets, launcher and «доступно обновление») updates in place.
        rt.shell.showStatus(result.message ?? "загружено", "info");
        try {
          await rt.shell.refresh();
        } catch (error: unknown) {
          rt.shell.showStatus(
            `${result.message ?? "загружено"}; не удалось обновить данные реестра: ${errorMessage(error)}`,
            "error",
          );
        }
        return result;
      },
      onThemeToggle: () => undefined,
      onUpgrade: switchVersion,
      onRollback: switchVersion,
    },
    shellRoot,
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

  stageRoot.querySelector("[data-close-app]")?.addEventListener("click", closeApp);

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
    });

  if (!popstateBound) {
    window.addEventListener("popstate", applyLocation);
    popstateBound = true;
  }
  return fm;
}
