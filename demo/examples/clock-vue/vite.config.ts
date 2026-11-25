import { defineConfig } from "vite";

// One self-contained ES bundle; the SDK is bundled in, not fetched at runtime.
// Vue's esm-bundler build needs its feature flags pinned explicitly.
export default defineConfig({
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
