/** Static listeners: the host on :4000 and untrusted plugin code on :4001. */
import express, { type Express, type RequestHandler } from "express";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Plugin-static CSP (spec §10) with network access disabled by default.
 * `pack` injects the synchronous `window.__VIBE_BOOT__` bootstrap as an inline
 * script, so the demo needs inline script permission on the plugin origin.
 */
export const PLUGIN_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src 'none'; frame-ancestors http://localhost:4000";

/** Plugin listener: every response carries the restrictive isolation headers. */
export function createPluginApp(pluginsDir: string): Express {
  const app = express();
  app.use((_req, res, next) => {
    res.setHeader("Content-Security-Policy", PLUGIN_CSP);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    next();
  });
  // Versioned paths (/plugins/<id>/<version>/…) never change content, so the
  // browser can reuse them from disk cache instead of revalidating every file
  // whenever a widget is added and every frame reloads. `immutable` keeps the
  // re-add flow request-free; repacking the same version in dev stays stale
  // until the maxAge window passes — reinstall under a bumped version instead.
  app.use("/plugins", express.static(pluginsDir, { immutable: true, maxAge: "1h" }));
  app.use((_req, res) => res.status(404).json({ code: "NOT_FOUND", message: "plugin file not found" }));
  return app;
}

/**
 * Host listener: Vite middleware in dev, built static otherwise. Both modes
 * fall back to the host HTML for browser routes (`/` and `/app/<iid>/<path>`);
 * the dev HTML references `/host/…` absolutely so its assets resolve from a
 * deep URL too. API routes are mounted before this app.
 */
export function createHostApp(
  hostDir: string,
  viteMiddlewares?: RequestHandler[],
  spaHtml?: string,
): Express {
  const app = express();
  if (viteMiddlewares) app.use(viteMiddlewares);
  app.use(express.static(hostDir));
  app.get("*", (_req, res, next) => {
    if (spaHtml !== undefined) {
      res.type("html").send(spaHtml);
      return;
    }
    const index = join(hostDir, "index.html");
    if (existsSync(index)) res.sendFile(index);
    else next();
  });
  return app;
}
