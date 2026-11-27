import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import { readBoot } from "../src/sdk/boot.js";
import { create } from "./create.mjs";
import { check } from "./check.mjs";
import { injectBoot, pack } from "./pack.mjs";

const CLI_DIR = dirname(fileURLToPath(import.meta.url));
const CONTRACTS_DIR = resolve(CLI_DIR, "..");
const tempDirs: string[] = [];

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "vibe-cli-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

const validManifest = {
  schema: 1,
  id: "clock-ts",
  kind: "widget",
  version: "1.2.0",
  hostApi: "^2",
  sdk: "2.0.0",
  title: "Clock",
  icon: "clock",
  entry: "index.html",
  capabilities: ["theme.read", "notify"],
  defaultSize: { w: 320, h: 200 },
  minSize: { w: 200, h: 120 },
};

type Manifest = Parameters<typeof injectBoot>[1];

function makePlugin(dir: string, manifest: unknown = validManifest): void {
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "fixture-plugin",
      version: "1.0.0",
      private: true,
      type: "module",
      scripts: { build: "node scripts/build.mjs" },
    }),
  );
  writeFileSync(
    join(dir, "scripts", "build.mjs"),
    'import { mkdirSync, writeFileSync } from "node:fs";\n' +
      'mkdirSync("dist", { recursive: true });\n' +
      'writeFileSync("dist/bundle.js", "export const ok = 1;\\n");\n',
  );
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  writeFileSync(
    join(dir, "index.html"),
    "<html><head><title>clock</title></head><body><div id='root'></div></body></html>",
  );
}

function archive(zipPath: string): Record<string, Uint8Array> {
  return unzipSync(new Uint8Array(readFileSync(zipPath)));
}

function namesInZip(zipPath: string): string[] {
  return Object.keys(archive(zipPath));
}

function text(zip: Record<string, Uint8Array>, name: string): string {
  return strFromU8(zip[name]);
}

describe("injectBoot", () => {
  it("injectBoot adds __VIBE_BOOT__ with declared major", () => {
    const html = injectBoot("<html><body></body></html>", {
      ...validManifest,
      hostApi: "^1",
    } as Manifest);
    expect(html).toContain("window.__VIBE_BOOT__");
    expect(html).toContain('"hostApiMajor":"1"');
  });

  it("injects a boot object that satisfies the SDK's readBoot()", () => {
    const manifest = {
      ...validManifest,
      hostApi: "~2.3",
      routes: ["/settings"],
    } as Manifest;
    const html = injectBoot("<html><head></head><body></body></html>", manifest);
    const match = /window\.__VIBE_BOOT__\s*=\s*(\{.*?\});/.exec(html);
    expect(match).not.toBeNull();
    window.__VIBE_BOOT__ = JSON.parse(match![1]);
    expect(readBoot()).toEqual({
      id: manifest.id,
      version: manifest.version,
      hostApiMajor: "2",
      sdk: manifest.sdk,
      capabilities: manifest.capabilities,
      kind: manifest.kind,
      routes: ["/settings"],
    });
    delete window.__VIBE_BOOT__;
  });

  it("omits routes when the manifest has none", () => {
    const html = injectBoot("<html><head></head></html>", validManifest as Manifest);
    expect(html).toContain('"kind":"widget"');
    expect(html).not.toContain('"routes"');
  });
});

describe("pack", () => {
  it("rewrites the dev source entry (./src/main.ts) to the built bundle", async () => {
    const dir = tmp();
    makePlugin(dir);
    // Dev-style entry: vite dev serves the live source; the archive must not.
    writeFileSync(
      join(dir, "index.html"),
      "<!doctype html><html><head><title>clock</title></head>" +
        '<body><script type="module" src="./src/main.ts"></script></body></html>',
    );
    const zipPath = await pack(dir);
    const html = text(archive(zipPath), "index.html");

    expect(html).toContain('src="./dist/bundle.js"');
    expect(html).not.toContain("src/main.ts");
    expect(html).toContain("window.__VIBE_BOOT__");
  });
});

describe("create", () => {
  it("copies the canonical template verbatim", async () => {
    const target = join(tmp(), "new-plugin");
    await create(target);
    for (const file of [
      "package.json",
      "tsconfig.json",
      "vite.config.ts",
      "index.html",
      "manifest.json",
      "src/main.ts",
      "scripts/pack.mjs",
    ]) {
      expect(existsSync(join(target, file)), file).toBe(true);
    }
    const pkg = JSON.parse(readFileSync(join(target, "package.json"), "utf8"));
    expect(pkg.dependencies["@vibe/plugin-contracts"]).toMatch(/^file:/);
    expect(pkg.scripts.build).toBeTruthy();
    expect(pkg.scripts.pack).toBeTruthy();
    expect(readFileSync(join(target, "src/main.ts"), "utf8")).toContain("createPlugin");
  });

  it("refuses to overwrite a non-empty directory", async () => {
    const target = tmp();
    writeFileSync(join(target, "keep.txt"), "user work");
    await expect(create(target)).rejects.toThrow(/not empty/);
    expect(readFileSync(join(target, "keep.txt"), "utf8")).toBe("user work");
  });
});

describe("pack", () => {
  it("pack produces zip with manifest, checksums.json and built bundle", async () => {
    const dir = tmp();
    makePlugin(dir);
    const zip = await pack(dir);
    expect(existsSync(zip)).toBe(true);
    expect(zip).toContain(`${validManifest.id}-${validManifest.version}.zip`);
    expect(namesInZip(zip)).toEqual(
      expect.arrayContaining([
        "manifest.json",
        "checksums.json",
        "index.html",
        "dist/bundle.js",
      ]),
    );
  });

  it("injects boot into index.html and checksums every other member", async () => {
    const dir = tmp();
    makePlugin(dir);
    const zip = await pack(dir);
    const files = archive(zip);
    const html = text(files, "index.html");
    expect(html).toContain("window.__VIBE_BOOT__");
    expect(html).toContain('"hostApiMajor":"2"');
    expect(text(files, "dist/bundle.js")).toContain("export const ok = 1");

    const checksums = JSON.parse(text(files, "checksums.json"));
    expect(Object.keys(checksums).sort()).toEqual(
      Object.keys(files).filter((name) => name !== "checksums.json").sort(),
    );
    expect(checksums["manifest.json"]).toMatch(/^[a-f0-9]{64}$/);
    expect((await check(zip)).ok).toBe(true);
  });
});

describe("check", () => {
  it("accepts a well-formed archive", async () => {
    const dir = tmp();
    makePlugin(dir);
    expect(await check(await pack(dir))).toEqual({ ok: true, errors: [] });
  });

  it("check rejects archive with bad hostApi", async () => {
    const dir = tmp();
    makePlugin(dir, { ...validManifest, hostApi: "^1" });
    const result = await check(await pack(dir));
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/hostAPI 1|≥ 2\.0/);
  });

  it("rejects an archive whose bytes do not match checksums.json", async () => {
    const dir = tmp();
    makePlugin(dir);
    const files = archive(await pack(dir));
    files["dist/bundle.js"] = strToU8("tampered");
    const badZip = join(dir, "tampered.zip");
    writeFileSync(badZip, zipSync(files));
    const result = await check(badZip);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/checksum/i);
  });

  it("rejects zip-slip member names", async () => {
    const dir = tmp();
    const badZip = join(dir, "slip.zip");
    const files: Record<string, Uint8Array> = Object.create(null);
    files["manifest.json"] = strToU8(JSON.stringify(validManifest));
    files["../escape.js"] = strToU8("bad");
    files["checksums.json"] = strToU8("{}");
    writeFileSync(badZip, zipSync(files));
    const result = await check(badZip);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/unsafe archive member/);
  });

  it("rejects an invalid manifest", async () => {
    const dir = tmp();
    const badZip = join(dir, "invalid.zip");
    const files: Record<string, Uint8Array> = {
      "manifest.json": strToU8(JSON.stringify({ ...validManifest, kind: "bad" })),
    };
    files["checksums.json"] = strToU8(
      JSON.stringify({
        "manifest.json": createHash("sha256").update(files["manifest.json"]).digest("hex"),
      }),
    );
    writeFileSync(badZip, zipSync(files));
    const result = await check(badZip);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/kind must be widget or app/);
  });

  it("rejects a member named __proto__", async () => {
    const dir = tmp();
    const badZip = join(dir, "proto.zip");
    // fflate itself uses plain objects, so patch a same-length placeholder name
    // in the raw zip headers instead of asking it to emit "__proto__".
    const files: Record<string, Uint8Array> = {
      "manifest.json": strToU8(JSON.stringify(validManifest)),
      "checksums.json": strToU8("{}"),
      "XXXXXXXXX": strToU8("bad"),
    };
    const raw = Buffer.from(zipSync(files));
    for (let index = raw.indexOf("XXXXXXXXX"); index !== -1; index = raw.indexOf("XXXXXXXXX", index + 9)) {
      raw.write("__proto__", index, "ascii");
    }
    writeFileSync(badZip, raw);
    const result = await check(badZip);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/__proto__/);
  });
});

describe("binary", () => {
  it("exposes create/pack/check subcommands", async () => {
    const dir = tmp();
    const cli = join(CONTRACTS_DIR, "cli", "index.mjs");
    execFileSync(process.execPath, [cli, "create", join(dir, "plugin")], {
      cwd: CONTRACTS_DIR,
      stdio: "pipe",
    });
    expect(existsSync(join(dir, "plugin", "manifest.json"))).toBe(true);

    const pluginDir = tmp();
    makePlugin(pluginDir);
    const zip = await pack(pluginDir);
    const stdout = execFileSync(process.execPath, [cli, "check", zip], {
      cwd: CONTRACTS_DIR,
      encoding: "utf8",
    });
    expect(stdout).toContain("ok");
  });
});
