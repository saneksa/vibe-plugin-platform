/**
 * Portable two-origin static server for the browser conformance rig (spec §13).
 * `node:http` only: no external packages, no demo code, no build step. Origin A
 * serves a tiny host page; origin B serves the prebuilt hostile-plugin fixture.
 * Distinct HTTP origins are mandatory — with srcdoc/opaque origins `event.origin`
 * would be "null" and there would be nothing to check for isolation.
 */

import { readFile } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "hostile-plugin");
const PLUGIN_PREFIX = "/plugins/hostile-widget/";

export interface TwoOrigins {
  hostOrigin: string;
  pluginOrigin: string;
  close(): Promise<void>;
}

const HOST_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Conformance host</title>
<style>
  @font-face { font-family: "HostOnlyFont"; src: local("Arial"); }
  body { background: rgb(240, 240, 240); margin: 0; }
  #host-sentinel { color: rgb(1, 2, 3); font-family: "HostOnlyFont"; }
</style>
</head>
<body>
<div id="host-sentinel">HOST-SENTINEL</div>
<div id="frames"></div>
<script>
(function () {
  var PLUGIN_ORIGIN = "__PLUGIN_ORIGIN__";
  var HOSTILE_IID = "i-hostile";
  window.__rigReports = [];
  window.__rigNavigations = [];
  window.__rigRoutes = [];
  window.__rigRpcAttempts = [];
  window.__hostMarker = "host-value";
  window.__hostFetch = window.fetch;
  window.__hostTick = 0;
  window.setInterval(function () { window.__hostTick++; }, 50);
  try { window.localStorage.setItem("host-secret", "host-only"); } catch (e) {}

  var deepLink = /^\\/app\\/([^/]+)(\\/.*)?$/.exec(window.location.pathname);
  window.__rigInitialRoute = deepLink && deepLink[2] ? deepLink[2] : "/";

  window.__rigMount = function () {
    var container = document.getElementById("frames");
    while (container.firstChild) container.removeChild(container.firstChild);

    var hostile = document.createElement("iframe");
    hostile.id = "hostile-frame";
    hostile.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms");
    hostile.src = PLUGIN_ORIGIN + "${PLUGIN_PREFIX}index.html?iid=" +
      encodeURIComponent(HOSTILE_IID) + "&route=" + encodeURIComponent(window.__rigInitialRoute);
    container.appendChild(hostile);

    // The sibling lives on the HOST origin, so the hostile frame (plugin
    // origin) cannot read its document through parent.frames.
    var sibling = document.createElement("iframe");
    sibling.id = "sibling-frame";
    sibling.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms");
    sibling.src = "/sibling/index.html?iid=i-sibling";
    container.appendChild(sibling);
  };

  window.__rigUnmount = function () {
    var container = document.getElementById("frames");
    while (container.firstChild) container.removeChild(container.firstChild);
  };

  function postToHostile(envelope) {
    var frame = document.getElementById("hostile-frame");
    if (frame && frame.contentWindow) {
      frame.contentWindow.postMessage(envelope, PLUGIN_ORIGIN);
    }
  }

  window.addEventListener("message", function (event) {
    var data = event.data;
    if (!data || data.__rig !== true) return;
    // Triple check: origin, source window and iid must all match the frame.
    if (event.origin !== PLUGIN_ORIGIN) return;
    var frame = document.getElementById("hostile-frame");
    if (!frame || frame.contentWindow !== event.source) return;
    if (data.iid !== HOSTILE_IID) return;

    if (data.type === "report") {
      window.__rigReports.push(data.report);
    } else if (data.type === "navigate") {
      window.__rigNavigations.push(data.path);
      window.history.pushState(null, "", "/app/" + data.iid + data.path);
      if (typeof window.__rigOnNavigate === "function") {
        window.__rigOnNavigate(data.iid, data.path, false);
      }
      postToHostile({ type: "route", iid: data.iid, path: data.path });
    } else if (data.type === "rpc-no-caps") {
      // Capability enforcement belongs to host-core; with no caps granted the
      // adapter is deliberately not called. Record the attempt for the rig.
      window.__rigRpcAttempts.push(data.method);
    }
  });

  window.addEventListener("popstate", function () {
    var link = /^\\/app\\/([^/]+)(\\/.*)?$/.exec(window.location.pathname);
    var path = link && link[2] ? link[2] : "/";
    window.__rigRoutes.push(path);
    postToHostile({ type: "route", iid: link ? link[1] : HOSTILE_IID, path: path });
  });
})();
</script>
</body>
</html>`;

const SIBLING_PAGE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Sibling pane</title></head>
<body>
<div id="sibling-secret">SIBLING-ONLY</div>
<script>
  window.__siblingMarker = "sibling-value";
  // Forged source/iid attempt: a message from the wrong frame claims the
  // hostile plugin's iid. The host must drop it on the origin/source check.
  window.parent.postMessage(
    { __rig: true, type: "report", iid: "i-hostile", report: { forged: true } },
    "*"
  );
</script>
</body>
</html>`;

function respond(res: ServerResponse, status: number, body: string, contentType: string): void {
  res.writeHead(status, {
    "content-type": contentType,
    "cache-control": "no-store",
  });
  res.end(body);
}

/** Starts one HTTP listener on 127.0.0.1 and resolves with its bound port. */
function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("conformance server has no TCP address"));
        return;
      }
      resolve(address.port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.closeAllConnections();
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

export async function startTwoOrigins(ports: [number, number] = [0, 0]): Promise<TwoOrigins> {
  const hostServer = createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (pathname === "/sibling/index.html") {
      respond(res, 200, SIBLING_PAGE, "text/html; charset=utf-8");
      return;
    }
    respond(res, 200, HOST_PAGE.replace("__PLUGIN_ORIGIN__", pluginOrigin), "text/html; charset=utf-8");
  });

  const pluginServer = createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (!pathname.startsWith(PLUGIN_PREFIX)) {
      respond(res, 404, "not found", "text/plain; charset=utf-8");
      return;
    }
    const name = pathname.slice(PLUGIN_PREFIX.length);
    const allowed = new Set(["index.html", "plugin.js", "style.css"]);
    if (!allowed.has(name)) {
      respond(res, 404, "not found", "text/plain; charset=utf-8");
      return;
    }
    readFile(join(FIXTURE_DIR, name), "utf8").then(
      (body) => {
        res.writeHead(200, {
          "content-type": name.endsWith(".html")
            ? "text/html; charset=utf-8"
            : name.endsWith(".css")
              ? "text/css; charset=utf-8"
              : "text/javascript; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "cross-origin-resource-policy": "same-origin",
          "content-security-policy": [
            "default-src 'self'",
            "script-src 'self'",
            "style-src 'self' 'unsafe-inline'",
            "font-src 'self' data:",
            "connect-src 'none'",
            `frame-ancestors ${hostOrigin}`,
          ].join("; "),
        });
        res.end(body);
      },
      () => respond(res, 404, "not found", "text/plain; charset=utf-8"),
    );
  });

  let hostOrigin = "";
  let pluginOrigin = "";
  try {
    const [hostPort, pluginPort] = await Promise.all([
      listen(hostServer, ports[0]),
      listen(pluginServer, ports[1]),
    ]);
    hostOrigin = `http://127.0.0.1:${hostPort}`;
    pluginOrigin = `http://127.0.0.1:${pluginPort}`;
  } catch (err) {
    hostServer.closeAllConnections();
    pluginServer.closeAllConnections();
    hostServer.close();
    pluginServer.close();
    throw err;
  }

  return {
    hostOrigin,
    pluginOrigin,
    async close(): Promise<void> {
      await Promise.all([closeServer(hostServer), closeServer(pluginServer)]);
    },
  };
}
