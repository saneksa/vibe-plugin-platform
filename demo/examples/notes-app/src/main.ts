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
    const title = document.createElement("h1");
    header.append(title);

    const nav = document.createElement("nav");
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
    const content = document.createElement("main");
    el.append(header, nav, routeLabel, content);

    const state = { items: [] as string[], route: "/", params: {} as Params };

    const persist = (): void => {
      void host.storage.set(NOTES_KEY, state.items).catch(() => undefined);
    };
    const paint = (): void => {
      routeLabel.textContent = `route: ${state.route}`;
      content.replaceChildren();
      title.textContent = "Notes";

      if (state.route === "/") {
        const input = document.createElement("input");
        input.type = "text";
        input.placeholder = "A new note";
        input.setAttribute("aria-label", "new note");
        const add = document.createElement("button");
        add.type = "button";
        add.textContent = "Save note";
        add.addEventListener("click", () => {
          const value = input.value.trim();
          if (value === "") return;
          state.items.push(value);
          input.value = "";
          persist();
          paint();
        });
        content.append(input, add);
      } else if (state.route === "/list") {
        const list = document.createElement("ul");
        for (const item of state.items) {
          const entry = document.createElement("li");
          entry.textContent = item;
          list.append(entry);
        }
        if (state.items.length === 0) {
          const empty = document.createElement("li");
          empty.textContent = "No notes yet";
          list.append(empty);
        }
        const clear = document.createElement("button");
        clear.type = "button";
        clear.textContent = "Clear all";
        clear.addEventListener("click", () => {
          state.items = [];
          void host.storage.remove(NOTES_KEY).catch(() => undefined);
          paint();
        });
        content.append(list, clear);
      } else if (state.route === "/settings/:tab") {
        const setting = document.createElement("p");
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
      el.replaceChildren();
    };
  },
});
