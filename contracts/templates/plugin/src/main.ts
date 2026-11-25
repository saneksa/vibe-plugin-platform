import { createPlugin } from "@vibe/plugin-contracts/sdk";

// The SDK reads window.__VIBE_BOOT__ (injected by `vibe-plugin pack`) and the
// frame's iid/route query; all host communication goes through `host`.
createPlugin({
  mount(root, host) {
    const heading = document.createElement("h1");
    heading.textContent = "My plugin";
    root.appendChild(heading);

    const button = document.createElement("button");
    button.textContent = "Notify the host";
    button.addEventListener("click", () => {
      void host.notify.show({ level: "info", message: "Hello from my plugin" });
    });
    root.appendChild(button);

    return () => root.replaceChildren();
  },
});
