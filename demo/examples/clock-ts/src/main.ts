/**
 * clock-ts@2.0.0: same plugin id and same hostAPI major as 1.2.0, with an
 * updated two-panel render. It reads the note written by 1.2.0 from the
 * instance-scoped host storage, which is what makes a live upgrade visible.
 */
import { createPlugin, type HostApi } from "@vibe/plugin-contracts/sdk";

const NOTE_KEY = "k";

createPlugin({
  mount(el, host: HostApi) {
    el.classList.add("clock", "v2");

    const header = document.createElement("header");
    header.className = "clock-header";
    const version = document.createElement("span");
    version.className = "clock-version";
    version.textContent = "clock 2.0.0";
    const mode = document.createElement("span");
    mode.className = "clock-mode";
    mode.textContent = "theme: …";
    header.append(version, mode);

    const panel = document.createElement("div");
    panel.className = "clock-panel";
    const time = document.createElement("div");
    time.className = "clock-time";
    const date = document.createElement("div");
    date.className = "clock-date";
    panel.append(time, date);

    const note = document.createElement("input");
    note.type = "text";
    note.placeholder = "note (host.storage)";
    note.setAttribute("aria-label", "note");

    const saved = document.createElement("div");
    saved.className = "clock-saved";

    el.append(header, panel, note, saved);

    const paint = (): void => {
      const now = new Date();
      time.textContent = now.toLocaleTimeString();
      date.textContent = now.toLocaleDateString(undefined, {
        year: "numeric",
        month: "long",
        day: "numeric",
      });
    };
    const onTheme = (value: unknown): void => {
      const next =
        typeof value === "object" && value !== null && "mode" in value
          ? String((value as { mode: unknown }).mode)
          : String(value);
      el.dataset.theme = next;
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

    paint();
    const timer = window.setInterval(paint, 1000);

    return () => {
      window.clearInterval(timer);
      host.off("theme.changed", onTheme);
      el.replaceChildren();
    };
  },
});
