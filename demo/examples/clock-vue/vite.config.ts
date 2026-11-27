import { readFileSync } from "node:fs";
import type { Plugin } from "vite";
import { defineConfig } from "vite";

// `vite dev` serves index.html with the live ./src/main.ts — but the SDK's
// readBoot() needs the __VIBE_BOOT__ global that `pack` injects into built
// archives. The dev server adds it as a tag: replacing the html itself would
// drop Vite's own HMR client injection. `vite build` uses the source entry as
// its rollup input, so this transform never runs there. The boot shape mirrors
// contracts/cli (kept import-free: the config must not pull contracts sources).
const manifest = JSON.parse(readFileSync(new URL("./manifest.json", import.meta.url), "utf8"));
const boot = {
  id: manifest.id,
  version: manifest.version,
  hostApiMajor: (/\d+/.exec(String(manifest.hostApi))?.[0] ?? "2"),
  sdk: manifest.sdk,
  capabilities: manifest.capabilities,
  kind: manifest.kind,
  ...(manifest.routes === undefined ? {} : { routes: manifest.routes }),
};
const devBoot: Plugin = {
  name: "vibe-dev-boot",
  transformIndexHtml: {
    // Pre: return the same html plus the boot tag, so Vite's own HMR client
    // injection still applies afterwards.
    order: "pre",
    handler: (html: string) => ({
      html,
      tags: [
        {
          tag: "script",
          children: `window.__VIBE_BOOT__ = ${JSON.stringify(boot).replace(/</g, "\u003c")};`,
          injectTo: "head",
        },
      ],
    }),
  },
};

import vue from "@vitejs/plugin-vue";

// One self-contained ES bundle; the SDK is bundled in, not fetched at runtime.
// Vue's esm-bundler build needs its feature flags pinned explicitly.
export default defineConfig({
  plugins: [devBoot, vue()],
  define: {
    __VUE_OPTIONS_API__: "true",
    __VUE_PROD_DEVTOOLS__: "false",
    __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: "false",
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: "src/main.ts",
      output: {
        format: "es",
        entryFileNames: "bundle.js",
        assetFileNames: "assets/[name][extname]",
      },
    },
  },
});
