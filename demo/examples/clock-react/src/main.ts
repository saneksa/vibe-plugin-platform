/**
 * clock-react: React is mounted into the element supplied by the same SDK as
 * the vanilla and Vue widgets. No framework-specific host code is involved.
 */
import React from "react";
import { createRoot } from "react-dom/client";
import { createPlugin } from "@vibe/plugin-contracts/sdk";

createPlugin({
  mount(el, host) {
    const root = createRoot(el);

    function Clock() {
      const [now, setNow] = React.useState(() => new Date());
      const [mode, setMode] = React.useState("light");

      React.useEffect(() => {
        const timer = window.setInterval(() => setNow(new Date()), 1000);
        void host.theme.get().then((value) => setMode(value.mode)).catch(() => undefined);
        return () => window.clearInterval(timer);
      }, []);

      return React.createElement(
        "div",
        { className: "clock-react", "data-theme": mode },
        React.createElement("div", { className: "clock-version" }, "clock-react 1.0.0"),
        React.createElement("div", { className: "clock-time" }, now.toLocaleTimeString()),
        React.createElement("div", { className: "clock-mode" }, `theme: ${mode}`),
        React.createElement(
          "button",
          {
            type: "button",
            onClick: () => {
              void host.notify.show({ level: "info", message: "Hello from React" });
            },
          },
          "Notify host",
        ),
      );
    }

    root.render(React.createElement(Clock));
    return () => root.unmount();
  },
});
