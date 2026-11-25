/**
 * clock-vue: Vue's createApp() renders into the SDK-supplied element. Render
 * functions (h) keep the example free of SFC/JSX build tooling.
 */
import { createApp, h, onMounted, onUnmounted, ref } from "vue";
import { createPlugin } from "@vibe/plugin-contracts/sdk";

createPlugin({
  mount(el, host) {
    const app = createApp({
      setup() {
        const now = ref(new Date());
        const mode = ref("light");
        let timer: number | undefined;

        onMounted(() => {
          timer = window.setInterval(() => {
            now.value = new Date();
          }, 1000);
          void host.theme.get().then((value) => {
            mode.value = value.mode;
          }).catch(() => undefined);
        });

        onUnmounted(() => {
          if (timer !== undefined) window.clearInterval(timer);
        });

        return () =>
          h("div", { class: "clock-vue", "data-theme": mode.value }, [
            h("div", { class: "clock-version" }, "clock-vue 1.0.0"),
            h("div", { class: "clock-time" }, now.value.toLocaleTimeString()),
            h("div", { class: "clock-mode" }, `theme: ${mode.value}`),
            h(
              "button",
              {
                type: "button",
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
    return () => app.unmount();
  },
});
