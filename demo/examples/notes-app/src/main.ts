/**
 * notes-app: a full-canvas routed application. The route table is handed to
 * the SDK (which drives it with routeMatcher), while all persistence and
 * navigation go through the framework-agnostic host API.
 */
import { createPlugin, routeMatcher, type HostApi } from "@vibe/plugin-contracts/sdk";

const NOTES_KEY = "notes";
type Params = Record<string, string>;

interface View {
  home(): void;
  list(): void;
  settings(params: Params): void;
}

let view: View | undefined;

const routes = {
  "/": () => view?.home(),
  "/list": () => view?.list(),
  "/settings/:tab": (params: Params) => view?.settings(params),
};

createPlugin({
  routes,
  mount(el, host: HostApi) {
    el.classList.add("notes-app");

    const header = document.createElement("header");
    header.className = "notes-bar";
    const title = document.createElement("h1");
    title.textContent = "Notes";
    const nav = document.createElement("nav");
    nav.setAttribute("aria-label", "Sections");
    const button = (label: string, path: string): HTMLButtonElement => {
      const control = document.createElement("button");
      control.type = "button";
      control.textContent = label;
      control.addEventListener("click", () => host.navigate(path));
      return control;
    };
    nav.append(button("Home", "/"), button("List", "/list"), button("Settings", "/settings/general"));
    const routeLabel = document.createElement("div");
    routeLabel.className = "notes-route";
    header.append(title, nav, routeLabel);
    const content = document.createElement("main");
    el.append(header, content);

    // The stylesheet keys on <html data-theme>, so the whole page follows the host.
    const onTheme = (value: unknown): void => {
      const next =
        typeof value === "object" && value !== null && "mode" in value
          ? String((value as { mode: unknown }).mode)
          : String(value);
      document.documentElement.dataset.theme = next;
    };
    void host.theme.get().then(onTheme).catch(() => undefined);
    host.on("theme.changed", onTheme);

    const state = { items: [] as string[], route: "/", params: {} as Params };

    const persist = (): void => {
      void host.storage.set(NOTES_KEY, state.items).catch(() => undefined);
    };
    const paint = (): void => {
      routeLabel.textContent = `route: ${state.route}`;
      // Highlight the tab that owns the current route pattern.
      const current = state.route === "/" ? 0 : state.route === "/list" ? 1 : 2;
      Array.from(nav.children).forEach((control, index) => {
        if (index === current) control.setAttribute("aria-current", "page");
        else control.removeAttribute("aria-current");
      });
      content.replaceChildren();

      if (state.route === "/") {
        const form = document.createElement("div");
        form.className = "notes-form";
        const input = document.createElement("input");
        input.type = "text";
        input.placeholder = "A new note";
        input.setAttribute("aria-label", "new note");
        const add = document.createElement("button");
        add.type = "button";
        add.className = "btn";
        add.textContent = "Save note";
        add.addEventListener("click", () => {
          const value = input.value.trim();
          if (value === "") return;
          state.items.push(value);
          input.value = "";
          persist();
          paint();
        });
        form.append(input, add);
        content.append(form);
      } else if (state.route === "/list") {
        const list = document.createElement("ul");
        list.className = "notes-list";
        for (const item of state.items) {
          const entry = document.createElement("li");
          entry.textContent = item;
          list.append(entry);
        }
        if (state.items.length === 0) {
          const empty = document.createElement("li");
          empty.className = "is-empty";
          empty.textContent = "No notes yet";
          list.append(empty);
        }
        const clear = document.createElement("button");
        clear.type = "button";
        clear.className = "btn btn-ghost";
        clear.textContent = "Clear all";
        clear.addEventListener("click", () => {
          state.items = [];
          void host.storage.remove(NOTES_KEY).catch(() => undefined);
          paint();
        });
        content.append(list, clear);
      } else if (state.route === "/settings/:tab") {
        const setting = document.createElement("p");
        setting.className = "notes-setting";
        setting.textContent = `Settings tab: ${state.params.tab ?? ""}`;
        content.append(setting);
      }
    };

    view = {
      home() {
        state.route = "/";
        state.params = {};
        paint();
      },
      list() {
        state.route = "/list";
        state.params = {};
        paint();
      },
      settings(params) {
        state.route = "/settings/:tab";
        state.params = params;
        paint();
      },
    };

    void host.storage.get(NOTES_KEY).then((value) => {
      state.items = Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string")
        : [];
      paint();
    }).catch(() => undefined);

    // The SDK calls routeMatcher again after mount for the frame's initial
    // route; doing it here keeps the first paint correct even before `ready`.
    routeMatcher(routes, new URLSearchParams(window.location.search).get("route") ?? "/");

    return () => {
      view = undefined;
      host.off("theme.changed", onTheme);
      el.replaceChildren();
    };
  },
});
