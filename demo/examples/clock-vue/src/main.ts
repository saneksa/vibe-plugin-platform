/**
 * clock-vue: Vue's createApp() renders into the SDK-supplied element. Render
 * functions (h) keep the example free of SFC/JSX build tooling.
 */
import { createApp, h, onMounted, onUnmounted, ref } from "vue";
import { createPlugin } from "@vibe/plugin-contracts/sdk";

createPlugin({
  mount(el, host) {
    // The SDK root is the sized container the stylesheet relies on; Vue's own
    // root node stays transparent for layout (display: contents).
    el.classList.add("clock", "v2");
    const app = createApp({
      setup() {
        const now = ref(new Date());
        const mode = ref("dark");
        let timer: number | undefined;
        // The stylesheet keys on <html data-theme>: the whole page follows the host.
        const onTheme = (value: unknown): void => {
          const next =
            typeof value === "object" && value !== null && "mode" in value
              ? String((value as { mode: unknown }).mode)
              : String(value);
          document.documentElement.dataset.theme = next;
          mode.value = next;
        };

        onMounted(() => {
          timer = window.setInterval(() => {
            now.value = new Date();
          }, 1000);
          void host.theme.get().then(onTheme).catch(() => undefined);
          host.on("theme.changed", onTheme);
        });

        onUnmounted(() => {
          if (timer !== undefined) window.clearInterval(timer);
          host.off("theme.changed", onTheme);
        });

        return () =>
          h("div", { class: "clock-inner" }, [
            h("header", { class: "clock-header" }, [
              h("span", { class: "clock-version" }, "clock-vue 1.0.0"),
              h("span", { class: "clock-mode" }, `theme: ${mode.value}`),
            ]),
            h("div", { class: "clock-panel" }, [
              h("div", { class: "clock-time" }, now.value.toLocaleTimeString()),
              h(
                "div",
                { class: "clock-date" },
                now.value.toLocaleDateString(undefined, {
                  year: "numeric",
                  month: "long",
                  day: "numeric",
                }),
              ),
            ]),
            h(
              "button",
              {
                type: "button",
                class: "clock-notify",
                onClick: () => {
                  void host.notify.show({ level: "info", message: "Hello from Vue" });
                },
              },
              "Notify host",
            ),
          ]);
      },
    });

    app.mount(el);
    return () => {
      app.unmount();
      el.classList.remove("clock", "v2");
    };
  },
});
