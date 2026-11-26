/**
 * clock-react: React is mounted into the element supplied by the same SDK as
 * the vanilla and Vue widgets. No framework-specific host code is involved.
 */
import React from "react";
import { createRoot } from "react-dom/client";
import { createPlugin } from "@vibe/plugin-contracts/sdk";

createPlugin({
  mount(el, host) {
    // The SDK root is the sized container the stylesheet relies on; React's
    // own root node stays transparent for layout (display: contents).
    el.classList.add("clock", "v2");
    const root = createRoot(el);

    function Clock() {
      const [now, setNow] = React.useState(() => new Date());
      const [mode, setMode] = React.useState("dark");

      React.useEffect(() => {
        const timer = window.setInterval(() => setNow(new Date()), 1000);
        // The stylesheet keys on <html data-theme>: the whole page follows the host.
        const onTheme = (value: unknown): void => {
          const next =
            typeof value === "object" && value !== null && "mode" in value
              ? String((value as { mode: unknown }).mode)
              : String(value);
          document.documentElement.dataset.theme = next;
          setMode(next);
        };
        void host.theme.get().then(onTheme).catch(() => undefined);
        host.on("theme.changed", onTheme);
        return () => {
          window.clearInterval(timer);
          host.off("theme.changed", onTheme);
        };
      }, []);

      return React.createElement(
        "div",
        { className: "clock-inner" },
        React.createElement(
          "header",
          { className: "clock-header" },
          React.createElement("span", { className: "clock-version" }, "clock-react 1.0.0"),
          React.createElement("span", { className: "clock-mode" }, `theme: ${mode}`),
        ),
        React.createElement(
          "div",
          { className: "clock-panel" },
          React.createElement("div", { className: "clock-time" }, now.toLocaleTimeString()),
          React.createElement(
            "div",
            { className: "clock-date" },
            now.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }),
          ),
        ),
        React.createElement(
          "button",
          {
            type: "button",
            className: "clock-notify",
            onClick: () => {
              void host.notify.show({ level: "info", message: "Hello from React" });
            },
          },
          "Notify host",
        ),
      );
    }

    root.render(React.createElement(Clock));
    return () => {
      root.unmount();
      el.classList.remove("clock", "v2");
    };
  },
});
