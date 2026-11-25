import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginManifest } from "@vibe/plugin-contracts/manifest";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import { Registry } from "./registry.js";
import { handleUpload, MAX_ARCHIVE_BYTES } from "./upload.js";

const ID = "com.example.clock";
const VERSION = "1.2.0";

const validManifest: PluginManifest = {
  schema: 1,
  id: ID,
  kind: "widget",
  version: VERSION,
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

interface ArchiveOptions {
  manifest?: Partial<PluginManifest>;
  extra?: Record<string, string>;
  checksums?: Record<string, string>;
  rawChecksums?: string;
  omitChecksums?: boolean;
  omitManifest?: boolean;
}

function archive(options: ArchiveOptions = {}): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  if (!options.omitManifest) {
    files["manifest.json"] = strToU8(JSON.stringify({ ...validManifest, ...options.manifest }));
  }
  files["index.html"] = strToU8("<html>clock</html>");
  for (const [name, body] of Object.entries(options.extra ?? {})) files[name] = strToU8(body);
  if (!options.omitChecksums) {
    const expected =
      options.checksums ??
      Object.fromEntries(
        Object.entries(files)
          .filter(([name]) => name !== "checksums.json")
          .map(([name, bytes]) => [name, sha(bytes)]),
      );
    files["checksums.json"] = strToU8(options.rawChecksums ?? JSON.stringify(expected));
  }
  return zipSync(files);
}

function tampered(name: string, body: string): Uint8Array {
  const files = unzipSync(archive());
  files[name] = strToU8(body);
  return zipSync(files);
}

const dirs: string[] = [];
function setup(): { dest: string; registry: Registry; registryPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "plugin-upload-"));
  dirs.push(dir);
  const registryPath = join(dir, "registry.json");
  return { dest: join(dir, "storage", "plugins"), registry: new Registry(registryPath), registryPath };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("handleUpload", () => {
  it("rejects zip-slip BEFORE extracting anything", async () => {
    const { dest, registry } = setup();
    const result = await handleUpload(archive({ extra: { "../../evil.js": "bad" } }), registry, dest);

    expect(result.status).toBe(400);
    expect(result.body.code).toBe("UNSAFE_ARCHIVE_MEMBER");
    expect(result.body.message).toContain("../evil.js");
    expect(existsSync(join(dest, "../evil.js"))).toBe(false);
    expect(existsSync(join(dest, ID))).toBe(false);
    expect(registry.list()).toEqual([]);
  });

  it("rejects absolute and backslash member paths", async () => {
    const { dest, registry } = setup();
    for (const name of ["/etc/evil.js", "..\\evil.js"]) {
      const result = await handleUpload(archive({ extra: { [name]: "bad" } }), registry, dest);
      expect(result.status).toBe(400);
      expect(result.body.code).toBe("UNSAFE_ARCHIVE_MEMBER");
    }
    expect(existsSync(join(dest, ID))).toBe(false);
  });

  it("rejects a member named __proto__ before it can poison the checksum map", async () => {
    const { dest, registry } = setup();
    // fflate writes members through a plain object, so patch a same-length
    // placeholder in the raw zip headers like the CLI's own conformance test.
    const files: Record<string, Uint8Array> = {
      "manifest.json": strToU8(JSON.stringify(validManifest)),
      "index.html": strToU8("<html>clock</html>"),
      "XXXXXXXXX": strToU8("bad"),
    };
    files["checksums.json"] = strToU8(
      JSON.stringify({
        "manifest.json": sha(files["manifest.json"]!),
        "index.html": sha(files["index.html"]!),
        "XXXXXXXXX": sha(files["XXXXXXXXX"]!),
      }),
    );
    const raw = Buffer.from(zipSync(files));
    for (let i = raw.indexOf("XXXXXXXXX"); i !== -1; i = raw.indexOf("XXXXXXXXX", i + 9)) {
      raw.write("__proto__", i, "ascii");
    }

    const result = await handleUpload(new Uint8Array(raw), registry, dest);
    expect(result.status).toBe(400);
    expect(result.body.code).toBe("UNSAFE_ARCHIVE_MEMBER");
    expect(result.body.message).toContain("__proto__");
    expect(existsSync(join(dest, ID))).toBe(false);
  });

  it("returns 409 with actionable text for unsupported major, without extracting", async () => {
    const { dest, registry } = setup();
    const result = await handleUpload(archive({ manifest: { hostApi: "^1" } }), registry, dest);

    expect(result.status).toBe(409);
    expect(result.body.code).toBe("HOST_API_UNSUPPORTED");
    expect(result.body.message).toBe(
      "плагин собран под hostAPI 1, хост поддерживает 2; соберите с @vibe/plugin-contracts ≥ 2.0",
    );
    expect(result.body.message).toContain("соберите с @vibe/plugin-contracts ≥ 2.0");
    expect(existsSync(join(dest, ID))).toBe(false);
    expect(registry.list()).toEqual([]);
  });

  it("checks the hostAPI gate before checksums (gate wins over tampering)", async () => {
    const { dest, registry } = setup();
    const files = unzipSync(archive({ manifest: { hostApi: "^1" } }));
    files["index.html"] = strToU8("tampered");
    const result = await handleUpload(zipSync(files), registry, dest);

    expect(result.status).toBe(409);
    expect(result.body.message).toContain("соберите с @vibe/plugin-contracts ≥ 2.0");
  });

  it("extracts a valid archive into <id>/<version>/ and registers it persistently", async () => {
    const { dest, registry, registryPath } = setup();
    const result = await handleUpload(archive(), registry, dest);

    expect(result.status).toBe(201);
    expect(result.body.descriptor).toEqual({
      id: ID,
      version: VERSION,
      kind: "widget",
      title: "Clock",
      icon: "clock.svg",
      capabilities: ["context.read"],
      hostApi: "^2",
      unsupported: false,
    });
    expect(readFileSync(join(dest, ID, VERSION, "index.html"), "utf8")).toBe("<html>clock</html>");
    expect(readFileSync(join(dest, ID, VERSION, "manifest.json"), "utf8")).toContain(ID);

    const restored = new Registry(registryPath);
    expect(restored.list()).toEqual([result.body.descriptor]);
    expect(restored.activeVersion(ID)).toBe(VERSION);
  });

  it("uploading another version does not switch the active version", async () => {
    const { dest, registry, registryPath } = setup();
    expect((await handleUpload(archive(), registry, dest)).status).toBe(201);
    const next = archive({ manifest: { version: "2.0.0" } });
    expect((await handleUpload(next, registry, dest)).status).toBe(201);

    expect(registry.list()).toHaveLength(2);
    expect(new Registry(registryPath).activeVersion(ID)).toBe(VERSION);
    expect(existsSync(join(dest, ID, "2.0.0", "index.html"))).toBe(true);
  });

  it("rejects an invalid manifest with a structured 400", async () => {
    const { dest, registry } = setup();
    const result = await handleUpload(
      archive({ manifest: { kind: "bad", version: "not-semver" } }),
      registry,
      dest,
    );

    expect(result.status).toBe(400);
    expect(result.body.code).toBe("INVALID_MANIFEST");
    expect(result.body.message).toContain("kind must be widget or app");
    expect(existsSync(join(dest, ID))).toBe(false);
  });

  it("rejects a missing manifest or a missing entry member", async () => {
    const { dest, registry } = setup();
    const missingManifest = await handleUpload(archive({ omitManifest: true }), registry, dest);
    expect(missingManifest.status).toBe(400);
    expect(missingManifest.body.code).toBe("INVALID_MANIFEST");

    const missingEntry = await handleUpload(
      archive({ manifest: { entry: "missing.html" } }),
      registry,
      dest,
    );
    expect(missingEntry.status).toBe(400);
    expect(missingEntry.body.code).toBe("INVALID_MANIFEST");
    expect(missingEntry.body.message).toContain("entry");
    expect(existsSync(join(dest, ID))).toBe(false);
  });

  it("accepts an app with routes and requires them by kind", async () => {
    const { dest, registry } = setup();
    const app = { ...validManifest, kind: "app" as const, routes: ["/", "/settings/:tab"] };
    expect((await handleUpload(archive({ manifest: app, extra: {} }), registry, dest)).status).toBe(201);

    const { dest: otherDest, registry: otherRegistry } = setup();
    const noRoutes = await handleUpload(
      archive({ manifest: { kind: "app" } }),
      otherRegistry,
      otherDest,
    );
    expect(noRoutes.status).toBe(400);
    expect(noRoutes.body.message).toContain("routes");
    expect(existsSync(join(otherDest, ID))).toBe(false);
  });

  it("rejects a checksum mismatch or a missing checksum without writing files", async () => {
    const { dest, registry } = setup();
    const mismatch = await handleUpload(tampered("index.html", "evil"), registry, dest);
    expect(mismatch.status).toBe(400);
    expect(mismatch.body.code).toBe("CHECKSUM_MISMATCH");

    const files = unzipSync(archive());
    const checksums = JSON.parse(strFromU8(files["checksums.json"]!)) as Record<string, string>;
    delete checksums["manifest.json"]; // declared digests omit a real member
    files["checksums.json"] = strToU8(JSON.stringify(checksums));
    const missing = await handleUpload(zipSync(files), registry, dest);
    expect(missing.status).toBe(400);
    expect(missing.body.code).toBe("CHECKSUM_MISMATCH");
    expect(existsSync(join(dest, ID))).toBe(false);
  });

  it("enforces the archive size limit before unzipping", async () => {
    const { dest, registry } = setup();
    const huge = new Uint8Array(MAX_ARCHIVE_BYTES + 1);
    const result = await handleUpload(huge, registry, dest);

    expect(result.status).toBe(413);
    expect(result.body.code).toBe("ARCHIVE_TOO_LARGE");
    expect(existsSync(join(dest, ID))).toBe(false);
  });

  it("reports a corrupt archive as a structured 400", async () => {
    const { dest, registry } = setup();
    const result = await handleUpload(strToU8("not a zip"), registry, dest);
    expect(result.status).toBe(400);
    expect(result.body.code).toBe("INVALID_ARCHIVE");
    expect(result.body.message.length).toBeGreaterThan(0);
    expect(existsSync(join(dest, ID))).toBe(false);
  });

  it("returns structured JSON (code and human-readable message) for every failure", async () => {
    const { dest, registry } = setup();
    const result = await handleUpload(
      archive({ rawChecksums: "{ not json" }),
      registry,
      dest,
    );
    expect(result.status).toBe(400);
    expect(typeof result.body.code).toBe("string");
    expect(typeof result.body.message).toBe("string");
    expect(result.body.message.length).toBeGreaterThan(0);
    expect(existsSync(join(dest, ID))).toBe(false);
  });
});
