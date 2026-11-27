import type { PluginDescriptorDTO } from "@vibe/plugin-contracts/host-core";
import { decodeEnvelope } from "@vibe/plugin-contracts/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CANVAS_ID, Canvas, setCanvasResizeHandler } from "./Canvas.js";
import { boot, PLUGIN_ORIGIN } from "./main.js";
import { RegistryClient } from "./RegistryClient.js";
import { groupPlugins, plural } from "./Shell.js";
import { Toasts } from "./Toasts.js";

const CLOCK: PluginDescriptorDTO = {
  id: "clock",
  version: "1.2.0",
  kind: "widget",
  title: "Clock",
  icon: "clock.svg",
  capabilities: ["theme.read"],
  hostApi: "^2",
  unsupported: false,
};
const NOTES: PluginDescriptorDTO = {
  ...CLOCK,
  id: "notes",
  version: "1.0.0",
  title: "Notes",
  kind: "widget",
};
const SETTINGS: PluginDescriptorDTO = {
  ...CLOCK,
  id: "settings",
  version: "1.0.0",
  title: "Settings",
  kind: "app",
  capabilities: ["navigate"],
};

interface Fixture {
  versions: PluginDescriptorDTO[];
  active: Record<string, string>;
}

function fixture(overrides: Partial<Fixture> = {}): Fixture {
  return {
    versions: [CLOCK, NOTES, SETTINGS],
    active: { clock: "1.2.0", notes: "1.0.0", settings: "1.0.0" },
    ...overrides,
  };
}

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 409 ? "Conflict" : "OK",
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

function stubFetch(fx: Fixture, postStatus = 200, postMessage = "uploaded") {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.endsWith("/api/plugins") && method === "GET") {
      return response({ versions: fx.versions, activeVersion: fx.active });
    }
    if (url.endsWith("/api/plugins") && method === "POST") {
      return response({ ok: postStatus < 300, message: postMessage }, postStatus);
    }
    if (method === "PUT" && url.includes("/api/plugins/")) {
      return response({ ...CLOCK });
    }
    if (url.endsWith("/api/meta")) {
      return response({
        hostVersion: "2.4.0",
        supportedMajors: ["2", "1"],
        deprecated: {},
        capsCatalogue: [],
      });
    }
    return response({ code: "NOT_FOUND", message: url }, 404);
  });
}

/**
 * Fetch fake with switches the test can flip after boot, so only the flow
 * under test fails while the initial restore/refresh still succeed.
 */
function controlledFetch(fx: Fixture) {
  const state = { failGet: false, failPut: false };
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (method === "GET" && url.endsWith("/api/plugins")) {
      if (state.failGet) throw new Error("registry list unavailable");
      return response({ versions: fx.versions, activeVersion: fx.active });
    }
    if (method === "PUT" && url.includes("/active")) {
      if (state.failPut) throw new Error("activation rejected by backend");
      return response({ ...CLOCK });
    }
    if (url.endsWith("/api/meta")) return response({ hostVersion: "2.4.0" });
    return response({}, 404);
  });
  return { fn, state };
}

function statusText(): string {
  return document.querySelector("[data-upload-status]")?.textContent ?? "";
}

function seedApp(iid: string): void {
  window.localStorage.setItem(
    "host.instances.v1",
    JSON.stringify({
      [iid]: { iid, pluginId: "settings", version: "1.0.0", kind: "app", route: "/settings/general" },
    }),
  );
}

function click(selector: string): void {
  const el = document.querySelector<HTMLElement>(selector);
  if (el === null) throw new Error(`missing element: ${selector}`);
  el.click();
}

async function clickAdd(pluginId: string): Promise<void> {
  const selector = `[data-add-widget="${pluginId}"]`;
  await vi.waitFor(() => expect(document.querySelector(selector)).not.toBeNull());
  const before = document.querySelectorAll("iframe").length;
  click(selector);
  await vi.waitFor(() => expect(document.querySelectorAll("iframe").length).toBe(before + 1));
}

describe("demo host", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState(null, "", "/");
    document.body.innerHTML = "";
    vi.stubGlobal("fetch", stubFetch(fixture()));
  });

  afterEach(() => {
    setCanvasResizeHandler(null);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("adding widgets builds a BSP tree and each pane mounts a frame", async () => {
    const fm = boot();

    await clickAdd("clock");
    await clickAdd("clock");
    await clickAdd("notes");

    expect(document.querySelectorAll("iframe")).toHaveLength(3);
    expect(fm.state.getLayout()?.type).toBe("split");
    // T4 axis convention: h = side-by-side (width split).
    expect(document.querySelector<HTMLElement>(".split")?.style.flexDirection).toBe("row");
  });

  it("right-click context menu removes a widget from the canvas", async () => {
    const fm = boot();
    await clickAdd("clock");
    const iid = Object.keys(fm.state.getInstances())[0]!;

    const pane = document.querySelector<HTMLElement>(`#${CANVAS_ID} .pane.leaf[data-iid="${iid}"]`);
    if (pane === null) throw new Error("widget pane missing");
    pane.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 40,
        clientY: 30,
      }),
    );

    const remove = document.querySelector<HTMLElement>("[data-widget-menu] [data-remove-widget]");
    if (remove === null) throw new Error("context menu missing");
    expect(remove.dataset.iid).toBe(iid);
    remove.click();

    await vi.waitFor(() =>
      expect(document.querySelectorAll(`#${CANVAS_ID} iframe`)).toHaveLength(0),
    );
    expect(fm.state.getInstances()[iid]).toBeUndefined();
    expect(fm.state.getLayout()).toBeNull();
  });

  it("tile header button removes a widget whose iframe fills the pane", async () => {
    const fm = boot();
    await clickAdd("clock");
    const iid = Object.keys(fm.state.getInstances())[0]!;
    const slot = document.querySelector<HTMLElement>(
      `#${CANVAS_ID} .frame-slot[data-iid="${iid}"]`,
    );
    if (slot === null) throw new Error("frame slot missing");
    expect(slot.querySelector("iframe")).not.toBeNull();

    // The button lives in the tile header, above the frame, not on top of it.
    const icon = slot.querySelector<HTMLElement>("[data-remove-widget]");
    if (icon === null) throw new Error("tile delete button missing");
    expect(icon.parentElement?.classList.contains("widget-head")).toBe(true);
    expect(icon.parentElement?.parentElement).toBe(slot);
    expect(icon.classList.contains("widget-remove")).toBe(true);
    icon.click();

    await vi.waitFor(() =>
      expect(document.querySelectorAll(`#${CANVAS_ID} iframe`)).toHaveLength(0),
    );
    expect(fm.state.getInstances()[iid]).toBeUndefined();
    expect(fm.state.getLayout()).toBeNull();
  });

  it("widget context menu closes on an outside click without removing the widget", async () => {
    const fm = boot();
    await clickAdd("clock");
    const iid = Object.keys(fm.state.getInstances())[0]!;
    const pane = document.querySelector<HTMLElement>(`#${CANVAS_ID} .pane.leaf[data-iid="${iid}"]`)!;
    pane.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    expect(document.querySelector("[data-widget-menu]")).not.toBeNull();

    document.body.click();

    expect(document.querySelector("[data-widget-menu]")).toBeNull();
    expect(fm.state.getInstances()[iid]).toBeDefined();
    expect(document.querySelectorAll(`#${CANVAS_ID} iframe`)).toHaveLength(1);
  });

  it("dev mode mounts that plugin's frames at the dev origin; neighbours stay on :4001", async () => {
    window.history.replaceState(null, "", "/?devPlugin=clock&devOrigin=http://localhost:5173/");
    const fm = boot();

    await clickAdd("clock");
    await clickAdd("notes");

    const origins = [...document.querySelectorAll<HTMLIFrameElement>("#vibe-canvas iframe")].map(
      (frame) => new URL(frame.getAttribute("src") ?? "").origin,
    );
    expect(origins).toContain("http://localhost:5173");
    expect(origins).toContain(PLUGIN_ORIGIN);
    const devFrame = document
      .querySelector<HTMLIFrameElement>('#vibe-canvas iframe[src*="localhost:5173"]')!
      .getAttribute("src")!;
    expect(devFrame).toContain("/index.html?iid=");
    // The top bar marks the dev loop (clicking the chip drops the params).
    const chip = document.querySelector<HTMLButtonElement>("[data-dev-chip]");
    expect(chip?.textContent).toBe("dev: clock");
    expect(chip?.title).toContain("localhost:5173");
    expect(fm.state.getInstances()).toBeDefined(); // still alive with the dev override
  });

  it("boot mounts the shell and full-screen stage inside the #app flex container", async () => {    const fm = boot();
    const app = document.querySelector<HTMLElement>("#app");
    if (app === null) throw new Error("#app container missing");

    expect(app.parentElement).toBe(document.body);
    expect(app.querySelector("#shell")).not.toBeNull();
    expect(app.querySelector(`#${CANVAS_ID}`)).not.toBeNull();
    expect(app.querySelector("#app-stage")).not.toBeNull();
    expect(document.body.querySelector(":scope > #app-stage")).toBeNull();
  });

  it("deep-link /app/<iid>/<path> resolves iid from registry and passes route", () => {
    seedApp("i7");
    window.history.pushState(null, "", "/app/i7/settings/general");

    const fm = boot();

    expect(Object.keys(fm.state.getInstances())).toEqual(["i7"]);
    const frame = document.querySelector<HTMLIFrameElement>("#app-stage iframe");
    expect(frame).not.toBeNull();
    const url = new URL(frame!.getAttribute("src") ?? "");
    expect(url.searchParams.get("iid")).toBe("i7");
    expect(url.searchParams.get("route")).toBe("/settings/general");
  });

  it("bare /app/<iid> reuses the route stored in the instance registry", () => {
    seedApp("i7");
    window.history.pushState(null, "", "/app/i7");
    const fm = boot();

    expect(fm.state.getInstances()["i7"]?.route).toBe("/settings/general");
    const frame = document.querySelector<HTMLIFrameElement>("#app-stage iframe")!;
    expect(new URL(frame.getAttribute("src") ?? "").searchParams.get("route")).toBe(
      "/settings/general",
    );
  });

  it("back/forward sends a route message to the app frame", () => {
    seedApp("i7");
    window.history.pushState(null, "", "/app/i7/settings/general");
    boot();

    const frame = document.querySelector<HTMLIFrameElement>("#app-stage iframe")!;
    const spy = vi.spyOn(frame.contentWindow!, "postMessage");
    window.history.pushState(null, "", "/app/i7/settings/other");
    window.dispatchEvent(new PopStateEvent("popstate"));

    expect(spy).toHaveBeenCalledOnce();
    const [raw, targetOrigin] = spy.mock.calls[0]!;
    expect(targetOrigin).toBe(PLUGIN_ORIGIN);
    expect(decodeEnvelope(raw as string)).toMatchObject({
      type: "route",
      iid: "i7",
      path: "/settings/other",
    });
  });

  it("RegistryClient reads the snapshot shape, sets active versions and surfaces upload errors", async () => {
    const fx = fixture({ versions: [CLOCK, { ...CLOCK, version: "2.0.0" }] });
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/api/plugins") && method === "GET") {
        return response({ versions: fx.versions, activeVersion: fx.active });
      }
      if (url.endsWith("/api/plugins") && method === "POST") {
        return response({ code: "HOST_API_UNSUPPORTED", message: "hostAPI 1 unsupported" }, 409);
      }
      if (method === "PUT") return response({ ...CLOCK });
      if (url.endsWith("/api/meta")) return response({ hostVersion: "2.4.0" });
      return response({}, 404);
    });
    const client = new RegistryClient({ fetch: fetchImpl, baseUrl: "http://host.test" });

    expect(await client.list()).toEqual(fx.versions);
    expect(await client.getActiveVersions()).toEqual(fx.active);
    expect((await client.meta()).hostVersion).toBe("2.4.0");

    await client.setActive("clock", "2.0.0");
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://host.test/api/plugins/clock/active",
      expect.objectContaining({ method: "PUT", body: JSON.stringify({ version: "2.0.0" }) }),
    );

    expect(await client.upload(new File(["x"], "old.zip"))).toEqual({
      ok: false,
      message: "hostAPI 1 unsupported",
    });
  });

  it("AppLauncher opens a fullscreen app, suspends widgets and resumes on close", async () => {
    const fm = boot();
    await clickAdd("clock");

    const widgetFrame = document.querySelector<HTMLIFrameElement>("#vibe-canvas iframe")!;
    const spy = vi.spyOn(widgetFrame.contentWindow!, "postMessage");
    click('[data-launch="settings"]');

    await vi.waitFor(() => expect(document.querySelector("#app-stage iframe")).not.toBeNull());
    expect(fm.state.getLayout()?.type).toBe("leaf"); // widget tree is untouched
    const appIid = Object.keys(fm.state.getInstances()).find(
      (iid) => fm.state.getInstances()[iid]?.kind === "app",
    );
    expect(window.location.pathname).toBe(`/app/${appIid}`);
    expect(decodeEnvelope(spy.mock.calls.at(-1)![0] as string)).toMatchObject({
      type: "lifecycle",
      state: "suspend",
    });

    click("[data-close-app]");

    expect(document.querySelector("#app-stage iframe")).toBeNull();
    expect(window.location.pathname).toBe("/");
    expect(decodeEnvelope(spy.mock.calls.at(-1)![0] as string)).toMatchObject({
      type: "lifecycle",
      state: "resume",
    });
    expect(Object.values(fm.state.getInstances()).some((r) => r.kind === "app")).toBe(false);
  });

  it("Canvas is a renderer only: honors axis, mounts every leaf and reports resize paths", () => {
    const resize = vi.fn();
    setCanvasResizeHandler(resize);
    document.body.innerHTML = '<div id="vibe-canvas"></div>';
    const mount = vi.fn();
    const leaf = (iid: string) => ({
      type: "leaf" as const,
      iid,
      pluginId: "clock",
      version: "1.2.0",
    });

    Canvas.render({ type: "split", axis: "h", ratio: 0.5, a: leaf("a"), b: leaf("b") }, mount);
    expect(document.querySelector<HTMLElement>(".split")?.style.flexDirection).toBe("row");
    expect(mount.mock.calls.map(([iid]) => iid)).toEqual(["a", "b"]);

    Canvas.render({ type: "split", axis: "v", ratio: 0.5, a: leaf("a"), b: leaf("b") }, mount);
    const split = document.querySelector<HTMLElement>(".split")!;
    expect(split.style.flexDirection).toBe("column");
    vi.spyOn(split, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      width: 200,
      height: 100,
      right: 200,
      bottom: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
    document.querySelector<HTMLElement>(".divider")!.dispatchEvent(
      new MouseEvent("pointerdown", { clientX: 150, clientY: 75 }),
    );
    expect(resize).toHaveBeenCalledWith("", 0.75);
  });

  it("splitter resizes from the keyboard and reports its ratio to assistive tech", () => {
    const resize = vi.fn();
    setCanvasResizeHandler(resize);
    document.body.innerHTML = '<div id="vibe-canvas"></div>';
    const leaf = (iid: string) => ({
      type: "leaf" as const,
      iid,
      pluginId: "clock",
      version: "1.2.0",
    });
    Canvas.render({ type: "split", axis: "h", ratio: 0.5, a: leaf("a"), b: leaf("b") }, () => undefined);

    const divider = document.querySelector<HTMLElement>(".divider")!;
    expect(divider.tabIndex).toBe(0);
    expect(divider.getAttribute("aria-orientation")).toBe("vertical");
    expect(divider.getAttribute("aria-valuenow")).toBe("50");

    divider.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(divider.getAttribute("aria-valuenow")).toBe("52");
    expect(resize).toHaveBeenLastCalledWith("", 0.52);

    divider.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", shiftKey: true, bubbles: true }));
    expect(divider.getAttribute("aria-valuenow")).toBe("42");
    expect(resize).toHaveBeenLastCalledWith("", 0.42);

    // Other keys are left alone, and the limits match a pointer drag.
    divider.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(resize).toHaveBeenCalledTimes(2);
    for (let i = 0; i < 10; i += 1) {
      divider.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", shiftKey: true, bubbles: true }));
    }
    expect(divider.getAttribute("aria-valuenow")).toBe("10");
  });

  it("groupPlugins folds versions into one entry and finds update/rollback targets", () => {
    const v2 = { ...CLOCK, version: "2.0.0" };

    const updatable = groupPlugins([CLOCK, v2, NOTES], { clock: "1.2.0", notes: "1.0.0" });
    expect(updatable.map((entry) => entry.id)).toEqual(["clock", "notes"]);
    expect(updatable[0]).toMatchObject({
      title: "Clock",
      active: "1.2.0",
      installed: ["2.0.0", "1.2.0"],
      newer: "2.0.0",
      older: null,
    });

    expect(groupPlugins([CLOCK, v2], { clock: "2.0.0" })[0]).toMatchObject({
      active: "2.0.0",
      newer: null,
      older: "1.2.0",
    });

    // A stale active pointer falls back to the newest installed archive.
    expect(groupPlugins([CLOCK, v2], { clock: "9.9.9" })[0]).toMatchObject({
      active: "2.0.0",
      newer: null,
      older: "1.2.0",
    });
  });

  it("plural picks the Russian form", () => {
    expect([1, 2, 5, 11, 21, 22].map((n) => plural(n, ["виджет", "виджета", "виджетов"]))).toEqual([
      "виджет",
      "виджета",
      "виджетов",
      "виджетов",
      "виджет",
      "виджета",
    ]);
  });

  it("catalog lists one entry per plugin id with the active version", async () => {
    const fx = fixture({ versions: [CLOCK, { ...CLOCK, version: "2.0.0" }, NOTES, SETTINGS] });
    vi.stubGlobal("fetch", stubFetch(fx));
    boot();

    await vi.waitFor(() => expect(document.querySelector('[data-add-widget="clock"]')).not.toBeNull());
    expect(document.querySelectorAll('[data-plugin="clock"]')).toHaveLength(1);
    expect(document.querySelectorAll('[data-add-widget="clock"]')).toHaveLength(1);
    const row = document.querySelector<HTMLElement>('[data-plugin="clock"]')!;
    expect(row.querySelector(".plugin-name")?.textContent).toBe("Clock");
    expect(row.querySelector(".chip-mono")?.textContent).toBe("v1.2.0");
    expect(row.querySelector("[data-upgrade]")).not.toBeNull();

    // Widgets and apps live in separate sections, each with its own action.
    expect(document.querySelector('[data-section="widgets"] [data-launch="settings"]')).toBeNull();
    expect(document.querySelector('[data-section="apps"] [data-launch="settings"]')).not.toBeNull();
  });

  it("tiles carry a header with title and version; the empty canvas offers quick-add", async () => {
    vi.stubGlobal("fetch", stubFetch(fixture()));
    const fm = boot();

    await vi.waitFor(() => expect(document.querySelector('[data-add-widget="clock"]')).not.toBeNull());
    expect(document.querySelector(".canvas-empty")).not.toBeNull();
    // Quick-add is a convenience, not a second catalog hook.
    expect(document.querySelectorAll('[data-quick-add="clock"]')).toHaveLength(1);
    expect(document.querySelectorAll('[data-add-widget="clock"]')).toHaveLength(1);

    await clickAdd("clock");
    const iid = Object.keys(fm.state.getInstances())[0]!;
    const slot = document.querySelector<HTMLElement>(`#${CANVAS_ID} .frame-slot[data-iid="${iid}"]`)!;
    expect(slot.querySelector(".widget-title")?.textContent).toBe("Clock");
    expect(slot.querySelector(".widget-version")?.textContent).toBe("v1.2.0");
    expect(slot.querySelector("[data-remove-widget]")).not.toBeNull();
    expect(document.querySelector(".canvas-empty")).toBeNull();
  });

  it("theme toggle persists the choice and publishes theme.changed", async () => {
    const fm = boot();
    await vi.waitFor(() => expect(document.querySelector("[data-theme-toggle]")).not.toBeNull());
    const publish = vi.spyOn(fm, "publish");

    click("[data-theme-toggle]");

    expect(document.documentElement.classList.contains("light")).toBe(true);
    expect(window.localStorage.getItem("vibe.theme")).toBe("light");
    expect(publish).toHaveBeenCalledWith("theme.changed", { mode: "light" });

    click("[data-theme-toggle]");

    expect(document.documentElement.classList.contains("light")).toBe(false);
    expect(window.localStorage.getItem("vibe.theme")).toBe("dark");
    expect(publish).toHaveBeenLastCalledWith("theme.changed", { mode: "dark" });
  });

  it("Toasts keeps one status element: transient info, sticky errors, separate plugin toasts", () => {
    vi.useFakeTimers();
    const root = document.createElement("div");
    try {
      document.body.appendChild(root);
      const toasts = new Toasts(root);
      const status = root.querySelector<HTMLElement>("[data-upload-status]")!;
      const hidden = (): boolean => status.closest(".toast")!.classList.contains("is-hidden");

      toasts.showStatus("загружено", "info");
      expect(status.textContent).toBe("загружено");
      expect(hidden()).toBe(false);

      toasts.showStatus("не получилось", "error");
      expect(status.textContent).toBe("не получилось");
      vi.advanceTimersByTime(60_000);
      expect(hidden()).toBe(false);

      toasts.showStatus("готово", "info");
      vi.advanceTimersByTime(5_001);
      expect(hidden()).toBe(true);
      // The text stays readable even while the toast is out of sight.
      expect(status.textContent).toBe("готово");

      toasts.push("Hello from React", "info");
      expect(document.querySelectorAll("[data-upload-status]")).toHaveLength(1);
      expect(root.querySelectorAll(".toast")).toHaveLength(2);
    } finally {
      vi.useRealTimers();
      root.remove();
    }
  });

  it("update indicator switches the active version and upgrades in place", async () => {
    const fx = fixture({
      versions: [CLOCK, { ...CLOCK, version: "2.0.0" }],
      active: { clock: "1.2.0" },
    });
    const fetchImpl = stubFetch(fx);
    vi.stubGlobal("fetch", fetchImpl);
    const fm = boot();
    await clickAdd("clock");
    const iid = Object.keys(fm.state.getInstances())[0]!;

    await vi.waitFor(() => expect(document.querySelector('[data-upgrade="clock"]')).not.toBeNull());
    click('[data-upgrade="clock"]');

    await vi.waitFor(() => expect(fm.state.getLayout()).toMatchObject({ version: "2.0.0" }));
    expect(Object.keys(fm.state.getInstances())).toEqual([iid]);
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/plugins/clock/active",
      expect.objectContaining({ method: "PUT", body: JSON.stringify({ version: "2.0.0" }) }),
    );
  });

  it("rollback button switches back to an older installed version", async () => {
    const fx = fixture({
      versions: [CLOCK, { ...CLOCK, version: "2.0.0" }],
      active: { clock: "2.0.0" },
    });
    vi.stubGlobal("fetch", stubFetch(fx));
    const fm = boot();
    await clickAdd("clock");

    await vi.waitFor(() => expect(document.querySelector('[data-rollback="clock"]')).not.toBeNull());
    expect(document.querySelector<HTMLElement>('[data-rollback="clock"]')?.dataset.version).toBe(
      "1.2.0",
    );
    click('[data-rollback="clock"]');
    await vi.waitFor(() => expect(fm.state.getLayout()).toMatchObject({ version: "1.2.0" }));
  });

  it("Shell shows the server's human-readable upload error", async () => {
    vi.stubGlobal("fetch", stubFetch(fixture(), 409, "плагин собран под hostAPI 1"));
    boot();

    const input = document.querySelector<HTMLInputElement>("[data-upload]")!;
    Object.defineProperty(input, "files", { value: [new File(["x"], "old.zip")] });
    input.dispatchEvent(new Event("change", { bubbles: true }));

    await vi.waitFor(() =>
      expect(document.querySelector("[data-upload-status]")?.textContent).toContain("hostAPI 1"),
    );
  });

  it("a successful upload refreshes the registry UI without a page reload", async () => {
    const fx = fixture({ versions: [CLOCK], active: { clock: "1.2.0" } });
    let uploaded = false;
    const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (method === "GET" && url.endsWith("/api/plugins")) {
        return response({
          versions: uploaded ? [CLOCK, { ...CLOCK, version: "2.0.0" }] : fx.versions,
          activeVersion: fx.active,
        });
      }
      if (url.endsWith("/api/plugins") && method === "POST") {
        uploaded = true;
        return response({ ok: true, message: "загружено" });
      }
      if (url.endsWith("/api/meta")) return response({ hostVersion: "2.4.0" });
      return response({}, 404);
    });
    boot({ fetch: fn });
    await vi.waitFor(() => expect(document.querySelector('[data-add-widget="clock"]')).not.toBeNull());
    expect(document.querySelector('[data-upgrade="clock"]')).toBeNull();

    const input = document.querySelector<HTMLInputElement>("[data-upload]")!;
    Object.defineProperty(input, "files", { value: [new File(["x"], "clock-2.0.0.zip")] });
    input.dispatchEvent(new Event("change", { bubbles: true }));

    await vi.waitFor(() => expect(document.querySelector('[data-upgrade="clock"]')).not.toBeNull());
    expect(document.querySelector<HTMLElement>('[data-upgrade="clock"]')?.textContent).toContain(
      "доступно обновление",
    );
    expect(statusText()).toBe("загружено");
  });

  it("a failed registry refresh after a successful upload is reported as an error", async () => {
    const fx = fixture({ versions: [CLOCK], active: { clock: "1.2.0" } });
    let uploaded = false;
    const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (method === "GET" && url.endsWith("/api/plugins")) {
        if (uploaded) throw new Error("registry refresh down");
        return response({ versions: fx.versions, activeVersion: fx.active });
      }
      if (method === "POST" && url.endsWith("/api/plugins")) {
        uploaded = true;
        return response({ ok: true, message: "загружено" });
      }
      if (url.endsWith("/api/meta")) return response({ hostVersion: "2.4.0" });
      return response({}, 404);
    });
    boot({ fetch: fn });
    await vi.waitFor(() => expect(document.querySelector('[data-add-widget="clock"]')).not.toBeNull());

    const input = document.querySelector<HTMLInputElement>("[data-upload]")!;
    Object.defineProperty(input, "files", { value: [new File(["x"], "clock-2.0.0.zip")] });
    input.dispatchEvent(new Event("change", { bubbles: true }));

    // The error must survive: a later "uploaded" used to overwrite it.
    await vi.waitFor(() => expect(statusText()).toContain("не удалось обновить данные реестра"));
    expect(statusText()).toContain("загружено");
    expect(statusText()).toContain("registry refresh down");
    expect(document.querySelector<HTMLElement>("[data-upload-status]")?.dataset.level).toBe("error");
  });

  it("shows a status in the header when adding a widget fails", async () => {
    const { fn, state } = controlledFetch(fixture());
    boot({ fetch: fn });
    await vi.waitFor(() => expect(document.querySelector('[data-add-widget="clock"]')).not.toBeNull());

    state.failGet = true;
    click('[data-add-widget="clock"]');

    await vi.waitFor(() => expect(statusText()).toContain("Не удалось добавить виджет"));
    expect(statusText()).toContain("registry list unavailable");
    expect(document.querySelectorAll("iframe")).toHaveLength(0);
  });

  it("shows a status in the header when an upgrade fails", async () => {
    const fx = fixture({
      versions: [CLOCK, { ...CLOCK, version: "2.0.0" }],
      active: { clock: "1.2.0" },
    });
    const { fn, state } = controlledFetch(fx);
    boot({ fetch: fn });
    await clickAdd("clock");
    await vi.waitFor(() => expect(document.querySelector('[data-upgrade="clock"]')).not.toBeNull());

    state.failPut = true;
    click('[data-upgrade="clock"]');

    await vi.waitFor(() => expect(statusText()).toContain("Не удалось обновить плагин"));
    expect(statusText()).toContain("activation rejected by backend");
  });

  it("shows a status in the header when restore fails", async () => {
    const fx = fixture();
    let firstGet = true;
    const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (method === "GET" && url.endsWith("/api/plugins")) {
        if (firstGet) {
          firstGet = false;
          throw new Error("restore transport down");
        }
        return response({ versions: fx.versions, activeVersion: fx.active });
      }
      if (url.endsWith("/api/meta")) return response({ hostVersion: "2.4.0" });
      return response({}, 404);
    });

    boot({ fetch: fn });

    await vi.waitFor(() => expect(statusText()).toContain("Не удалось восстановить состояние"));
    expect(statusText()).toContain("restore transport down");
  });

  it("shows a status in the header when opening an app fails", async () => {
    const { fn, state } = controlledFetch(fixture());
    boot({ fetch: fn });
    await vi.waitFor(() => expect(document.querySelector('[data-launch="settings"]')).not.toBeNull());

    state.failGet = true;
    click('[data-launch="settings"]');

    await vi.waitFor(() => expect(statusText()).toContain("Не удалось открыть приложение"));
    expect(statusText()).toContain("registry list unavailable");
    expect(document.querySelector("#app-stage iframe")).toBeNull();
  });

  it("renders a pane-level error card when a frame's handshake times out", async () => {
    vi.useFakeTimers();
    try {
      boot();
      await clickAdd("clock");

      await vi.advanceTimersByTimeAsync(10_000);

      const card = document.querySelector<HTMLElement>("#vibe-canvas .frame-error");
      expect(card).not.toBeNull();
      expect(card?.dataset.iid).toBeTruthy();
      expect(card?.textContent).toContain("handshake timed out");
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows a status in the header when the initial shell refresh fails", async () => {
    const fx = fixture();
    let getCalls = 0;
    const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (method === "GET" && url.endsWith("/api/plugins")) {
        getCalls += 1;
        // call 1 = fm.restore(), calls 2/3 = Shell.refresh()
        if (getCalls >= 2) throw new Error("registry refresh down");
        return response({ versions: fx.versions, activeVersion: fx.active });
      }
      if (url.endsWith("/api/meta")) return response({ hostVersion: "2.4.0" });
      return response({}, 404);
    });

    boot({ fetch: fn });

    await vi.waitFor(() => expect(statusText()).toContain("Не удалось обновить данные реестра"));
    expect(statusText()).toContain("registry refresh down");
  });
});
