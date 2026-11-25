#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Same rule as scripts/boundary.test.ts: contracts/src and contracts/conformance
// must never import from demo/.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scanDirs = [resolve(root, "src"), resolve(root, "conformance")];
const violation = /from ["'].*demo\//;

for (const dir of scanDirs) {
  if (!existsSync(dir)) {
    console.error(`boundary: missing source directory ${dir}`);
    process.exit(1);
  }
}

const found = [];
for (const dir of scanDirs) {
  for (const name of readdirSync(dir, { recursive: true })) {
    if (typeof name !== "string" || !name.endsWith(".ts")) continue;
    readFileSync(resolve(dir, name), "utf8")
      .split(/\r?\n/)
      .forEach((line, index) => {
        if (violation.test(line)) found.push(`${name}:${index + 1}: ${line.trim()}`);
      });
  }
}

if (found.length > 0) {
  console.error("boundary: contracts must not import from demo/");
  for (const entry of found) console.error(`  ${entry}`);
  process.exit(1);
}

console.log("boundary: OK — no imports from demo/ in contracts/src or contracts/conformance");
