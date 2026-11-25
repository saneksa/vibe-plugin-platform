import { readFileSync, readdirSync } from "node:fs";
import { describe, it, expect } from "vitest";
it("contracts has zero imports from demo", () => {
  for (const dir of ["src", "conformance", "cli", "templates"]) {
    const files = readdirSync(dir, { recursive: true }) as string[];
    const sources = files.filter((f) => [".ts", ".js", ".mjs"].some((ext) => f.endsWith(ext)));
    for (const f of sources) {
      expect(readFileSync(`${dir}/${f}`, "utf8"), `${dir}/${f}`).not.toMatch(/from ["'].*demo\//);
    }
  }
});
it("exports every required subpath", () => {
  const p = JSON.parse(readFileSync("package.json", "utf8"));
  expect(Object.keys(p.exports).sort()).toEqual([
    "./cli", "./compatibility.json", "./conformance", "./host-core",
    "./manifest", "./protocol", "./sdk",
  ].sort());
  expect(p.bin["vibe-plugin"]).toBeTruthy();
});
