/**
 * clock-react: React is mounted into the element supplied by the same SDK as
 * the vanilla and Vue widgets. No framework-specific host code is involved.
 */
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { createPlugin, type HostApi } from "@vibe/plugin-contracts/sdk";

function Clock({ host }: { host: HostApi }) {
  const [now, setNow] = useState(() => new Date());
  const [mode, setMode] = useState("dark");

  useEffect(() => {
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
  }, [host]);

  return (
    <div className="clock-inner">
      <header className="clock-header">
        <span className="clock-version">clock-react 1.0.0</span>
        <span className="clock-mode">theme: {mode}</span>
      </header>
      <div className="clock-panel">
        <div className="clock-time">{now.toLocaleTimeString()}</div>
        <div className="clock-date">
          {now.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })}
        </div>
      </div>
      <button
        type="button"
        className="clock-notify"
        onClick={() => void host.notify.show({ level: "info", message: "Hello from React" })}
      >
        Notify host
      </button>
    </div>
  );
}

createPlugin({
  mount(el, host) {
    // The SDK root is the sized container the stylesheet relies on; React's
    // own root node stays transparent for layout (display: contents).
    el.classList.add("clock", "v2");
    const root = createRoot(el);
    root.render(<Clock host={host} />);
    return () => {
      root.unmount();
      el.classList.remove("clock", "v2");
    };
  },
});
