#!/usr/bin/env node
/**
 * Proves that `@vibe/plugin-contracts/conformance` is core-only safe: copy the
 * package sources into a directory with NO node_modules, confirm that
 * `@playwright/test` cannot be resolved there, then import the conformance
 * subpath and run the whole DOM-free core suite.
 */
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const temp = mkdtempSync(join(tmpdir(), "vibe-conformance-no-pw-"));

// The CLI's resolver: NodeNext ".js" specifiers point at ".ts" sources.
const resolver = `
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND" && specifier.startsWith(".") && specifier.endsWith(".js")) {
      return nextResolve(specifier.slice(0, -3) + ".ts", context);
    }
    throw error;
  }
}`;
const hookFile = `
import { register } from "node:module";
register("data:text/javascript," + encodeURIComponent(${JSON.stringify(resolver)}));
`;

const verify = `
try {
  await import("@playwright/test");
  console.error("FAIL: @playwright/test unexpectedly resolved");
  process.exit(1);
} catch (error) {
  if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
}
const { runCoreConformance, FixtureAdapter, FakeFrameHost, MemoryStore } =
  await import("./conformance/index.ts");
const { HostState } = await import("./src/host-core/HostState.ts");
const result = runCoreConformance({
  adapterFactory: () => new FixtureAdapter(),
  frameHostFactory: () => new FakeFrameHost(),
  state: new HostState(new MemoryStore()),
});
if (result.failed.length > 0) {
  console.error("FAIL: core cases failed", result.failed);
  process.exit(1);
}
console.log("OK: conformance subpath imported and " + result.passed.length +
  " core cases passed with @playwright/test unresolvable");
`;

try {
  for (const entry of ["src", "conformance", "compatibility.json"]) {
    cpSync(join(root, entry), join(temp, entry), { recursive: true });
  }
  writeFileSync(join(temp, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(join(temp, "verify.mjs"), verify);
  writeFileSync(join(temp, "register-hook.mjs"), hookFile);
  const child = spawnSync(
    process.execPath,
    ["--experimental-transform-types", "--import", "./register-hook.mjs", "verify.mjs"],
    {
      cwd: temp,
      encoding: "utf8",
    },
  );
  process.stdout.write(child.stdout ?? "");
  process.stderr.write(child.stderr ?? "");
  if (child.status !== 0) process.exit(child.status ?? 1);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
