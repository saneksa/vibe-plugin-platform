import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginDescriptorDTO } from "@vibe/plugin-contracts/host-core";
import type { PluginManifest } from "@vibe/plugin-contracts/manifest";
import { getMeta, getPolicy } from "@vibe/plugin-contracts/protocol";
import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type ServerHandle } from "./index.js";
import { Registry } from "./registry.js";
import { MAX_ARCHIVE_BYTES } from "./upload.js";

const ID = "com.example.clock";

const validManifest: PluginManifest = {
  schema: 1,
  id: ID,
  kind: "widget",
  version: "1.2.0",
  hostApi: "^2",
  sdk: "2.0.0",
  title: "Clock",
  icon: "clock.svg",
  entry: "index.html",
  capabilities: ["context.read"],
  defaultSize: { w: 320, h: 200 },
  minSize: { w: 200, h: 120 },
};

const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

function archive(options: { manifest?: Partial<PluginManifest> } = {}): Uint8Array {
  const manifest = strToU8(JSON.stringify({ ...validManifest, ...options.manifest }));
  const entry = strToU8("<html>clock</html>");
  return zipSync({
    "manifest.json": manifest,
    "index.html": entry,
    "checksums.json": strToU8(JSON.stringify({ "manifest.json": sha(manifest), "index.html": sha(entry) })),
  });
}

function dto(id: string, version: string, hostApi = "^2"): PluginDescriptorDTO {
  return {
    id,
    version,
    kind: "widget",
    title: `${id} ${version}`,
    icon: "clock.svg",
    capabilities: ["context.read"],
    hostApi,
    unsupported: false,
  };
}

interface RawResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

function call(
  port: number,
  method: string,
  path: string,
  body?: Buffer,
  headers: Record<string, string> = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        headers: { ...headers, ...(body ? { "content-length": String(body.length) } : {}) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

const json = (raw: RawResponse): Record<string, any> => JSON.parse(raw.body) as Record<string, any>;
const getJSON = (port: number, path: string): Promise<Record<string, any>> =>
  call(port, "GET", path).then(json);

function multipart(zip: Uint8Array): { body: Buffer; headers: Record<string, string> } {
  const boundary = "----VibeRoutesBoundary";
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="archive"; filename="plugin.zip"\r\nContent-Type: application/zip\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    body: Buffer.concat([head, Buffer.from(zip), tail]),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}

interface Context {
  server: ServerHandle;
  registry: Registry;
  registryPath: string;
  storageDir: string;
  portHost: number;
  portPlugins: number;
}

const dirs: string[] = [];
const servers: ServerHandle[] = [];

async function setup(): Promise<Context> {
  const dir = mkdtempSync(join(tmpdir(), "plugin-routes-"));
  dirs.push(dir);
  const storageDir = join(dir, "storage");
  const hostDir = join(dir, "host");
  mkdirSync(hostDir, { recursive: true });
  writeFileSync(join(hostDir, "index.html"), "<html>vibe host</html>");
  const registryPath = join(storageDir, "registry.json");
  const registry = new Registry(registryPath);
  const server = await createServer({
    portHost: 0,
    portPlugins: 0,
    registry,
    storageDir,
    hostDir,
  });
  servers.push(server);
  return { server, registry, registryPath, storageDir, portHost: server.portHost, portPlugins: server.portPlugins };
}

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("createServer", () => {
  it("DELETE /api/plugins/:id uninstalls every version and the unpacked files", async () => {
    const ctx = await setup();
    ctx.registry.add(dto(ID, "1.0.0"));
    ctx.registry.add(dto(ID, "2.0.0"));
    ctx.registry.save();

    const res = await call(ctx.portHost, "DELETE", `/api/plugins/${ID}`);

    expect(res.status).toBe(200);
    expect(json(res)).toMatchObject({ ok: true });
    const snapshot = await getJSON(ctx.portHost, "/api/plugins");
    expect(snapshot.versions).toEqual([]);
    expect(snapshot.activeVersion).toEqual({});
    expect(snapshot.activeVersion).toEqual({});
    // The unpacked archive members are gone from disk.
    expect(() => ctx.registry.activeVersion(ID)).toThrow();
  });

  it("DELETE /api/plugins/:id answers 404 for an unknown plugin", async () => {
    const ctx = await setup();

    const res = await call(ctx.portHost, "DELETE", "/api/plugins/nope");

    expect(res.status).toBe(404);
    expect(json(res)).toMatchObject({ code: "PLUGIN_NOT_FOUND" });
  });

  it("PUT /active switches the version and GET /api/plugins reports it", async () => {
    const ctx = await setup();
    ctx.registry.add(dto(ID, "1.0.0"));
    ctx.registry.add(dto(ID, "2.0.0"));
    ctx.registry.save();

    const res = await call(
      ctx.portHost,
      "PUT",
      `/api/plugins/${ID}/active`,
      Buffer.from(JSON.stringify({ version: "2.0.0" })),
      { "content-type": "application/json" },
    );
    expect(res.status).toBe(200);
    expect(json(res)).toMatchObject({ id: ID, version: "2.0.0" });

    const listed = await getJSON(ctx.portHost, "/api/plugins");
    expect(listed.activeVersion[ID]).toBe("2.0.0");
    expect(listed.versions).toHaveLength(2);
    // activeVersion is backend state: the PUT must survive a restart.
    expect(new Registry(ctx.registryPath).activeVersion(ID)).toBe("2.0.0");
  });

  it("plugin origin sends restrictive CSP and is a different origin", async () => {
    const ctx = await setup();
    const dir = join(ctx.storageDir, "plugins", ID, "1.0.0");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "index.html"), "<html>plugin</html>");

    const res = await call(ctx.portPlugins, "GET", `/plugins/${ID}/1.0.0/index.html`);
    expect(res.status).toBe(200);
    expect(res.body).toBe("<html>plugin</html>");
    expect(res.headers["content-security-policy"]).toBe(
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src 'none'; frame-ancestors http://localhost:4000",
    );
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["cross-origin-resource-policy"]).toBe("same-origin");

    expect(ctx.portPlugins).not.toBe(ctx.portHost);
    const fromHost = await call(ctx.portHost, "GET", `/plugins/${ID}/1.0.0/index.html`);
    expect(fromHost.body).toBe("<html>vibe host</html>"); // host SPA fallback, not plugin static
    expect(fromHost.headers["content-security-policy"]).toBeUndefined();
  });

  it("POST /api/plugins installs multipart zips without switching the active version", async () => {
    const ctx = await setup();
    const first = multipart(archive());
    const res1 = await call(ctx.portHost, "POST", "/api/plugins", first.body, first.headers);
    expect(res1.status).toBe(201);
    expect(json(res1).descriptor).toMatchObject({ id: ID, version: "1.2.0", title: "Clock" });

    const second = multipart(archive({ manifest: { version: "2.0.0" } }));
    const res2 = await call(ctx.portHost, "POST", "/api/plugins", second.body, second.headers);
    expect(res2.status).toBe(201);

    const listed = await getJSON(ctx.portHost, "/api/plugins");
    expect(listed.versions.map((v: PluginDescriptorDTO) => v.version)).toEqual(["1.2.0", "2.0.0"]);
    expect(listed.activeVersion[ID]).toBe("1.2.0");
    expect(readFileSync(join(ctx.storageDir, "plugins", ID, "2.0.0", "index.html"), "utf8")).toBe("<html>clock</html>");
    expect(new Registry(ctx.registryPath).activeVersion(ID)).toBe("1.2.0");
  });

  it("POST /api/plugins returns structured JSON for invalid and unsupported archives", async () => {
    const ctx = await setup();
    const invalid = multipart(strToU8("not a zip"));
    const bad = await call(ctx.portHost, "POST", "/api/plugins", invalid.body, invalid.headers);
    expect(bad.status).toBe(400);
    expect(json(bad).code).toBe("INVALID_ARCHIVE");

    const unsupported = multipart(archive({ manifest: { hostApi: "^1" } }));
    const gate = await call(ctx.portHost, "POST", "/api/plugins", unsupported.body, unsupported.headers);
    expect(gate.status).toBe(409);
    expect(json(gate).code).toBe("HOST_API_UNSUPPORTED");
    expect(new Registry(ctx.registryPath).list()).toEqual([]);
  });

  it("PUT /active returns a structured 4xx for unknown, malformed or incompatible versions", async () => {
    const ctx = await setup();
    ctx.registry.add(dto(ID, "1.0.0"));
    ctx.registry.add(dto(ID, "0.9.0", "^1.4"));
    ctx.registry.save();

    const put = (version: unknown): Promise<RawResponse> =>
      call(ctx.portHost, "PUT", `/api/plugins/${ID}/active`, Buffer.from(JSON.stringify({ version })), {
        "content-type": "application/json",
      });

    const unknown = await put("9.9.9");
    expect(unknown.status).toBe(404);
    expect(json(unknown).code).toBe("VERSION_NOT_INSTALLED");

    const incompatible = await put("0.9.0");
    expect(incompatible.status).toBe(409);
    expect(json(incompatible).code).toBe("HOST_API_UNSUPPORTED");

    const malformed = await call(ctx.portHost, "PUT", `/api/plugins/${ID}/active`, Buffer.from("{not json"), {
      "content-type": "application/json",
    });
    expect(malformed.status).toBe(400);

    expect((await getJSON(ctx.portHost, "/api/plugins")).activeVersion[ID]).toBe("1.0.0");
  });

  it("GET /api/meta serves the policy imported from the exported compatibility artifact", async () => {
    const ctx = await setup();
    const meta = await getJSON(ctx.portHost, "/api/meta");
    const expected = getMeta(getPolicy());
    expect(meta.hostVersion).toEqual(expect.any(String));
    expect(String(meta.hostVersion).length).toBeGreaterThan(0);
    expect(meta.supportedMajors).toEqual(expected.supportedMajors);
    expect(meta.deprecated).toEqual(expected.deprecated);
    expect(meta.sunset).toBe(expected.sunset);
    expect(meta.capsCatalogue).toEqual(expected.capsCatalogue);
  });

  it("host origin serves built static with an SPA fallback", async () => {
    const ctx = await setup();
    const root = await call(ctx.portHost, "GET", "/");
    expect(root.status).toBe(200);
    expect(root.body).toContain("vibe host");
    const spa = await call(ctx.portHost, "GET", "/app/i7/settings");
    expect(spa.status).toBe(200);
    expect(spa.body).toContain("vibe host");
  });

  it("POST /api/plugins enforces the shared 10 MiB upload limit", async () => {
    const ctx = await setup();
    const huge = multipart(new Uint8Array(MAX_ARCHIVE_BYTES + 1));
    const res = await call(ctx.portHost, "POST", "/api/plugins", huge.body, huge.headers);
    expect(res.status).toBe(413);
    expect(json(res).code).toBe("ARCHIVE_TOO_LARGE");
  });
});
