/**
 * clock-vue: Vue's createApp() mounts the SFC into the SDK-supplied element.
 * All host interaction lives in App.vue; this file only wires the SDK root.
 */
import { createApp } from "vue";
import { createPlugin } from "@vibe/plugin-contracts/sdk";
import App from "./App.vue";

createPlugin({
  mount(el, host) {
    // The SDK root is the sized container the stylesheet relies on; Vue's
    // root node stays transparent for layout (display: contents).
    el.classList.add("clock", "v2");
    const app = createApp(App);
    app.provide("host", host);
    app.mount(el);
    return () => {
      app.unmount();
      el.classList.remove("clock", "v2");
    };
  },
});
