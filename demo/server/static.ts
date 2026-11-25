/** Static listeners: the host on :4000 and untrusted plugin code on :4001. */
import express, { type Express, type RequestHandler } from "express";
import { existsSync } from "node:fs";
import { join } from "node:path";

/** Spec §10: exact CSP for plugin static, with network access disabled by default. */
export const PLUGIN_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src 'none'; frame-ancestors http://localhost:4000";

/** Plugin listener: every response carries the restrictive isolation headers. */
export function createPluginApp(pluginsDir: string): Express {
  const app = express();
  app.use((_req, res, next) => {
    res.setHeader("Content-Security-Policy", PLUGIN_CSP);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    next();
  });
  app.use("/plugins", express.static(pluginsDir));
  app.use((_req, res) => res.status(404).json({ code: "NOT_FOUND", message: "plugin file not found" }));
  return app;
}

/** Host listener: Vite middleware in dev, built static (with SPA fallback) otherwise. */
export function createHostApp(hostDir: string, viteMiddlewares?: RequestHandler[]): Express {
  const app = express();
  if (viteMiddlewares) app.use(viteMiddlewares);
  app.use(express.static(hostDir));
  app.get("*", (_req, res, next) => {
    const index = join(hostDir, "index.html");
    if (existsSync(index)) res.sendFile(index);
    else next();
  });
  return app;
}
