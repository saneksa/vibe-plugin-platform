import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { strToU8, zipSync } from "fflate";
import {
  computeChecksums,
  hostApiMajor,
  validateManifest,
  verifyArchiveNames,
} from "@vibe/plugin-contracts/manifest";
import { majorOf } from "@vibe/plugin-contracts/protocol";

const INJECTED_BOOT = /<script[^>]*>\s*window\.__VIBE_BOOT__\s*=[\s\S]*?<\/script>/i;
const HEAD_END = /<\/head\s*>/i;

/** The exact shape validated by `readBoot()` in the SDK (spec §8.4). */
function bootData(manifest) {
  const major = hostApiMajor(manifest.hostApi);
  if (major === null) {
    throw new Error(`pack: cannot derive a bare hostApi major from ${JSON.stringify(manifest.hostApi)}`);
  }
  const boot = {
    id: manifest.id,
    version: manifest.version,
    hostApiMajor: majorOf(major),
    sdk: manifest.sdk,
    capabilities: [...manifest.capabilities],
    kind: manifest.kind,
  };
  if (manifest.routes !== undefined) boot.routes = [...manifest.routes];
  return boot;
}

/** Injects the synchronous boot global into index.html; replaces a prior injection. */
export function injectBoot(indexHtml, manifest) {
  const json = JSON.stringify(bootData(manifest)).replace(/</g, "\\u003c");
  const script = `<script>window.__VIBE_BOOT__ = ${json};</script>`;
  if (INJECTED_BOOT.test(indexHtml)) return indexHtml.replace(INJECTED_BOOT, script);
  if (HEAD_END.test(indexHtml)) return indexHtml.replace(HEAD_END, `${script}\n</head>`);
  return `${script}\n${indexHtml}`;
}

function collect(dir, prefix, out) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const name = `${prefix}${entry.name}`;
    if (entry.isDirectory()) collect(join(dir, entry.name), `${name}/`, out);
    // Archives from earlier packs are outputs, not plugin sources.
    else if (entry.isFile() && !name.endsWith(".zip")) {
      out.set(name, readFileSync(join(dir, entry.name)));
    }
  }
}

/** Builds, injects boot, checksums and zips a plugin; returns the archive path. */
export async function pack(cwd) {
  const root = resolve(cwd);
  const manifestPath = join(root, "manifest.json");
  const indexPath = join(root, "index.html");
  for (const file of [manifestPath, indexPath]) {
    if (!existsSync(file)) throw new Error(`pack: missing ${file}`);
  }

  const validation = validateManifest(JSON.parse(readFileSync(manifestPath, "utf8")));
  if (!validation.ok) {
    throw new Error(`pack: invalid manifest.json:\n  - ${validation.errors.join("\n  - ")}`);
  }
  const manifest = validation.manifest;

  try {
    execFileSync("npm", ["run", "build"], { cwd: root, stdio: "pipe" });
  } catch (error) {
    const output = `${error.stdout ?? ""}${error.stderr ?? ""}`.trim();
    throw new Error(`pack: npm run build failed in ${root}${output ? `\n${output}` : ""}`);
  }

  const files = new Map();
  files.set("manifest.json", readFileSync(manifestPath));
  files.set("index.html", strToU8(injectBoot(readFileSync(indexPath, "utf8"), manifest)));
  collect(join(root, "dist"), "dist/", files);
  collect(join(root, "assets"), "assets/", files);

  const names = [...files.keys()];
  const unsafe = verifyArchiveNames(names);
  if (unsafe.length > 0) {
    throw new Error(`pack: unsafe archive member names: ${unsafe.join(", ")}`);
  }
  // computeChecksums() writes into a plain object: a member named __proto__
  // would silently vanish from checksums.json. Refuse it instead.
  if (names.includes("__proto__")) {
    throw new Error("pack: member name __proto__ cannot be checksummed");
  }

  const checksums = computeChecksums(files);
  files.set("checksums.json", strToU8(`${JSON.stringify(checksums, null, 2)}\n`));

  const zipPath = join(root, "dist", `${manifest.id}-${manifest.version}.zip`);
  mkdirSync(dirname(zipPath), { recursive: true });
  writeFileSync(zipPath, zipSync(Object.fromEntries(files)));
  return zipPath;
}
