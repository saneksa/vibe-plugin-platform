/**
 * tasks-app: an app plugin whose routing is react-router. The SDK still sees
 * a plain route table (for `route` envelopes); react-router owns the views.
 */
import { createRoot } from "react-dom/client";
import { createPlugin } from "@vibe/plugin-contracts/sdk";
import { App } from "./App";
import { createHostRouting, pathFromPattern, SDK_ROUTE_PATTERNS, type HostRouting } from "./hostRouting";

// The SDK's route table is the host→app direction: every `route` envelope
// (echoes, back/forward, deep links) lands here. Handlers are registered
// before mount runs, so `routing` is always set by the time one fires.
let routing: HostRouting | undefined;
const routes = Object.fromEntries(
  SDK_ROUTE_PATTERNS.map((pattern) => [
    pattern,
    (params: Record<string, string>) => routing?.applyHostRoute(pathFromPattern(pattern, params)),
  ]),
);

createPlugin({
  routes,
  mount(el, host) {
    el.classList.add("tasks-app");
    // Pre-paint guess; corrected once theme.get resolves.
    document.documentElement.dataset.theme = "dark";
    const onTheme = (value: unknown): void => {
      const next =
        typeof value === "object" && value !== null && "mode" in value
          ? String((value as { mode: unknown }).mode)
          : String(value);
      document.documentElement.dataset.theme = next;
    };
    void host.theme.get().then(onTheme).catch(() => undefined);
    host.on("theme.changed", onTheme);

    const initialPath = new URLSearchParams(window.location.search).get("route") ?? "/";
    routing = createHostRouting(host, initialPath);
    const root = createRoot(el);
    root.render(<App host={host} routing={routing} />);
    return () => {
      root.unmount();
      routing = undefined;
      el.classList.remove("tasks-app");
    };
  },
});
