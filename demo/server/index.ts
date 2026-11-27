/**
 * Two listeners = two origins: host + API on :4000, plugin static on :4001.
 * `npm run dev` runs this file through tsx and starts both in one process.
 */
import { readFileSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Express, type RequestHandler } from "express";
import { Registry } from "./registry.js";
import { apiErrorHandler, createApiRouter } from "./routes.js";
import { createHostApp, createPluginApp } from "./static.js";

export const DEFAULT_PORT_HOST = 4000;
export const DEFAULT_PORT_PLUGINS = 4001;

export interface CreateServerOptions {
  portHost?: number;
  portPlugins?: number;
  registry: Registry;
  storageDir?: string;
  hostDir?: string;
  /** Vite dev middleware; when present it serves the host instead of built static. */
  vite?: {
    middlewares: RequestHandler;
    close(): Promise<void>;
    /** Vite's HTML transform, used for the SPA fallback at `/` and `/app/**`. */
    transformIndexHtml?(url: string, html: string): Promise<string> | string;
  };
  /** Dev host entry; defaults to `host/index.html` next to the server. */
  hostHtmlPath?: string;
}

export interface ServerHandle {
  close(): Promise<void>;
  portHost: number;
  portPlugins: number;
}

function listen(app: Express, port: number): Promise<Server> {
  return new Promise((resolveListen, reject) => {
    const server = createHttpServer(app);
    server.once("error", reject);
    server.listen(port, () => {
      server.off("error", reject);
      resolveListen(server);
    });
  });
}

function boundPort(server: Server, fallback: number): number {
  const address = server.address();
  return address && typeof address === "object" ? address.port : fallback;
}

function shutdown(server: Server): Promise<void> {
  return new Promise((resolveClose, reject) => {
    if (!server.listening) {
      resolveClose();
      return;
    }
    server.close((error) => (error ? reject(error) : resolveClose()));
  });
}

/** Starts both origins. Ports of 0 allocate ephemeral ports (used by tests). */
export async function createServer(opts: CreateServerOptions): Promise<ServerHandle> {
  const portHost = opts.portHost ?? DEFAULT_PORT_HOST;
  const portPlugins = opts.portPlugins ?? DEFAULT_PORT_PLUGINS;
  const storageDir = opts.storageDir ?? resolve("storage");
  const hostDir = opts.hostDir ?? resolve("dist");

  let spaHtml: string | undefined;
  if (opts.vite) {
    const htmlPath = opts.hostHtmlPath ?? resolve("host/index.html");
    // Vite resolves root-relative imports against its root (demo/), so the
    // host entry must be referenced absolutely from a deep SPA URL as well.
    const raw = readFileSync(htmlPath, "utf8").replace(/(href|src)="\.\//g, '$1="/host/');
    spaHtml = opts.vite.transformIndexHtml
      ? await opts.vite.transformIndexHtml("/", raw)
      : raw;
  }

  const hostApp = express();
  hostApp.use(createApiRouter({ registry: opts.registry, storageDir }));
  hostApp.use(apiErrorHandler);
  hostApp.use(createHostApp(hostDir, opts.vite ? [opts.vite.middlewares] : undefined, spaHtml));

  const pluginApp = createPluginApp(resolve(storageDir, "plugins"), {
    // A deployed host caches the versioned plugin paths hard; in dev the
    // browser must revalidate so a repacked archive reaches the frames.
    cache: process.env.NODE_ENV === "production" ? "immutable" : "revalidate",
  });

  const hostServer = await listen(hostApp, portHost);
  let pluginServer: Server;
  try {
    pluginServer = await listen(pluginApp, portPlugins);
  } catch (error) {
    await shutdown(hostServer);
    throw error;
  }
  let closed = false;

  return {
    portHost: boundPort(hostServer, portHost),
    portPlugins: boundPort(pluginServer, portPlugins),
    async close() {
      if (closed) return;
      closed = true;
      await Promise.all([shutdown(hostServer), shutdown(pluginServer), opts.vite?.close()]);
    },
  };
}

async function main(): Promise<void> {
  const storageDir = resolve(process.cwd(), "storage");
  const registry = new Registry(resolve(storageDir, "registry.json"));
  const vite =
    process.env.NODE_ENV === "production"
      ? undefined
      : await (await import("vite")).createServer({
          root: process.cwd(),
          server: {
            middlewareMode: true,
            // Archive extraction writes into storage/; those files are not
            // host sources and must not trigger a Vite full reload.
            watch: { ignored: ["**/storage/**"] },
          },
          // The explicit fallback below serves host/index.html for SPA routes;
          // Vite's own SPA middleware would look for demo/index.html instead.
          appType: "custom",
        });

  const server = await createServer({
    portHost: Number(process.env.PORT_HOST ?? DEFAULT_PORT_HOST),
    portPlugins: Number(process.env.PORT_PLUGINS ?? DEFAULT_PORT_PLUGINS),
    registry,
    storageDir,
    hostDir: resolve(process.cwd(), "dist"),
    vite: vite
      ? {
          middlewares: vite.middlewares as RequestHandler,
          close: () => vite.close(),
          transformIndexHtml: (url, html) => vite.transformIndexHtml(url, html),
        }
      : undefined,
  });
  console.log(`host + API: http://localhost:${server.portHost}`);
  console.log(`plugin static: http://localhost:${server.portPlugins}`);

  const stop = (): void => {
    void server.close();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
