/**
 * Headers of the plugin origin: the isolation CSP on every response plus a
 * long cache for the versioned plugin paths (spec §10). The cache is what
 * keeps re-adding a widget from revalidating every plugin file.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express, { type Express } from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPluginApp } from "./static.js";

describe("plugin static listener", () => {
  let app: Express;
  let root: string;

  beforeEach(() => {
    root = join(tmpdir(), `vibe-static-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(root, "plugins", "clock", "2.0.0", "dist"), { recursive: true });
    writeFileSync(join(root, "plugins", "clock", "2.0.0", "dist", "bundle.js"), "console.log(1);\n");
    app = createPluginApp(join(root, "plugins"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** The body is read once here so the server can close; tests use `text`. */
  const get = (path: string): Promise<{ res: Response; text: string }> =>
    new Promise((resolveResponse, reject) => {
      const server = app.listen(0, "127.0.0.1");
      server.once("listening", () => {
        const { port } = server.address() as { port: number };
        void fetch(`http://127.0.0.1:${port}${path}`)
          .then(async (res) => {
            const text = await res.text();
            server.close(() => resolveResponse({ res, text }));
          })
          .catch(reject);
      });
      server.once("error", reject);
    });

  it("serves plugin files with the isolation CSP and a long immutable cache", async () => {
    const { res } = await get("/plugins/clock/2.0.0/dist/bundle.js");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("connect-src 'none'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    // Without this the browser revalidates every plugin file on every frame
    // reload (Cache-Control: public, max-age=0 is express.static's default).
    const cacheControl = res.headers.get("cache-control") ?? "";
    expect(cacheControl).toContain("immutable");
    expect(Number(/max-age=(\d+)/.exec(cacheControl)?.[1] ?? 0)).toBeGreaterThan(0);
  });

  it("answers unknown plugin paths with the JSON 404 and the same headers", async () => {
    const { res, text } = await get("/plugins/clock/2.0.0/missing.js");

    expect(res.status).toBe(404);
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors");
    expect(JSON.parse(text)).toMatchObject({ code: "NOT_FOUND" });
  });
});
