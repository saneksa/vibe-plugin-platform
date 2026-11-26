/**
 * clock-ts@1.2.0: vanilla TypeScript widget. Reads the theme through the SDK,
 * listens for theme changes and persists a note in the host's scoped storage
 * under the key "k" so the upgraded build can read the same value.
 */
import { createPlugin, type HostApi } from "@vibe/plugin-contracts/sdk";

const NOTE_KEY = "k";

createPlugin({
  mount(el, host: HostApi) {
    el.classList.add("clock", "v1");

    const version = document.createElement("div");
    version.className = "clock-version";
    version.textContent = "clock 1.2.0";

    const time = document.createElement("div");
    time.className = "clock-time";

    const mode = document.createElement("div");
    mode.className = "clock-mode";

    const note = document.createElement("input");
    note.type = "text";
    note.placeholder = "note (host.storage)";
    note.setAttribute("aria-label", "note");

    const saved = document.createElement("div");
    saved.className = "clock-saved";

    el.append(version, time, mode, note, saved);

    const paintTime = (): void => {
      time.textContent = new Date().toLocaleTimeString();
    };
    // The stylesheet keys on <html data-theme>, so the whole page (background
    // included) follows the host theme, not just the widget root.
    const onTheme = (value: unknown): void => {
      const next =
        typeof value === "object" && value !== null && "mode" in value
          ? String((value as { mode: unknown }).mode)
          : String(value);
      document.documentElement.dataset.theme = next;
      mode.textContent = `theme: ${next}`;
    };

    void host.theme.get().then(onTheme).catch(() => undefined);
    host.on("theme.changed", onTheme);

    void host.storage.get(NOTE_KEY).then((value) => {
      note.value = typeof value === "string" ? value : "";
      saved.textContent = note.value === "" ? "" : `saved: ${note.value}`;
    }).catch(() => undefined);

    note.addEventListener("change", () => {
      void host.storage.set(NOTE_KEY, note.value).then(() => {
        saved.textContent = `saved: ${note.value}`;
      }).catch(() => undefined);
    });

    paintTime();
    const timer = window.setInterval(paintTime, 1000);

    return () => {
      window.clearInterval(timer);
      host.off("theme.changed", onTheme);
      el.replaceChildren();
    };
  },
});
