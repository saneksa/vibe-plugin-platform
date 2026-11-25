/**
 * Task 19: every example is a real, self-contained plugin built by the same
 * SDK and validated by the same pack/check pipeline as production plugins.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { strFromU8, unzipSync } from "fflate";
import { check, pack } from "@vibe/plugin-contracts/cli";
import { expect, it } from "vitest";

const EXAMPLES_DIR = dirname(fileURLToPath(import.meta.url));

/** The canonical template is documentation, not a packable example (spec §8.5). */
const exampleDirs = readdirSync(EXAMPLES_DIR, { withFileTypes: true })
  .filter(
    (entry) =>
      entry.isDirectory() &&
      entry.name !== "_template" &&
      existsSync(join(EXAMPLES_DIR, entry.name, "manifest.json")),
  )
  .map((entry) => join(EXAMPLES_DIR, entry.name));

function manifestOfExample(dir: string): Record<string, any> {
  return JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
}

function clockManifest(version: string): Record<string, any> {
  for (const dir of exampleDirs.filter((d) => basename(d).startsWith("clock-ts"))) {
    const manifest = manifestOfExample(dir);
    if (manifest.version === version) return manifest;
  }
  throw new Error(`no clock-ts example with version ${version}`);
}

function pkgOf(name: string): any {
  return JSON.parse(readFileSync(join(EXAMPLES_DIR, name, "package.json"), "utf8"));
}

function archive(zipPath: string): Record<string, Uint8Array> {
  return unzipSync(new Uint8Array(readFileSync(zipPath)));
}

it("every example packs a valid self-contained archive", async () => {
  expect(exampleDirs.length).toBeGreaterThan(0);
  for (const dir of exampleDirs) {
    const zip = await pack(dir);
    expect(await check(zip), basename(dir)).toMatchObject({ ok: true });
    const files = archive(zip);
    expect(Object.keys(files), basename(dir)).toContain("dist/bundle.js");
    expect(strFromU8(files["index.html"]), basename(dir)).toContain("__VIBE_BOOT__");
  }
});

it("clock-ts ships 1.2.0 and 2.0.0 with the same id", () => {
  expect(clockManifest("1.2.0").id).toBe(clockManifest("2.0.0").id);
  expect(clockManifest("2.0.0").hostApi).toBe("^2");
});

it("three frameworks use the same sdk", () => {
  for (const dir of ["clock-ts", "clock-react", "clock-vue"]) {
    expect(pkgOf(dir).dependencies["@vibe/plugin-contracts"], dir).toBeTruthy();
  }
});
