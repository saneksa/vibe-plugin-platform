import { readFileSync, readdirSync } from "node:fs";
import { describe, it, expect } from "vitest";
it("contracts has zero imports from demo", () => {
  for (const dir of ["src", "conformance"]) {
    const files = readdirSync(dir, { recursive: true }) as string[];
    for (const f of files.filter(f => f.endsWith(".ts"))) {
      expect(readFileSync(`${dir}/${f}`, "utf8")).not.toMatch(/from ["'].*demo\//);
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
