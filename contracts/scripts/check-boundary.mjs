#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Same rule as scripts/boundary.test.ts: contracts/src must never import from demo/.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = resolve(root, "src");
const violation = /from ["'].*demo\//;

if (!existsSync(srcDir)) {
  console.error(`boundary: missing source directory ${srcDir}`);
  process.exit(1);
}

const found = [];
for (const name of readdirSync(srcDir, { recursive: true })) {
  if (typeof name !== "string" || !name.endsWith(".ts")) continue;
  readFileSync(resolve(srcDir, name), "utf8")
    .split(/\r?\n/)
    .forEach((line, index) => {
      if (violation.test(line)) found.push(`${name}:${index + 1}: ${line.trim()}`);
    });
}

if (found.length > 0) {
  console.error("boundary: contracts must not import from demo/");
  for (const entry of found) console.error(`  ${entry}`);
  process.exit(1);
}

console.log("boundary: OK — no imports from demo/ in contracts/src");
