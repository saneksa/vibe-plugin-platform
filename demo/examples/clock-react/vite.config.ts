import { defineConfig } from "vite";

// One self-contained ES bundle; the SDK is bundled in, not fetched at runtime.
export default defineConfig({
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
