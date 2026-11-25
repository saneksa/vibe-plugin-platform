/**
 * Validated plugin archive upload. Every check runs before a single byte is
 * written to disk; only a fully verified archive is extracted and registered.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import {
  checkHostApiGate,
  computeChecksums,
  validateManifest,
  verifyArchiveNames,
  type PluginManifest,
} from "@vibe/plugin-contracts/manifest";
import type { PluginDescriptorDTO } from "@vibe/plugin-contracts/host-core";
import { getPolicy } from "@vibe/plugin-contracts/protocol";
import { unzipSync, strFromU8 } from "fflate";
import type { Registry } from "./registry.js";

/** Maximum accepted size of the uploaded zip, in bytes. */
export const MAX_ARCHIVE_BYTES = 10 * 1024 * 1024;

export type UploadResult = {
  status: number;
  body: { code?: string; message?: string; descriptor?: PluginDescriptorDTO };
};

const fail = (status: number, code: string, message: string): UploadResult => ({
  status,
  body: { code, message },
});

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Member names that would be swallowed by `computeChecksums`' plain `{}` map. */
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function checkChecksums(
  files: Record<string, Uint8Array>,
  names: string[],
): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(files, "checksums.json")) {
    return "missing checksums.json";
  }
  let checksums: unknown;
  try {
    checksums = JSON.parse(strFromU8(files["checksums.json"]!));
  } catch (error) {
    return `checksums.json: invalid JSON (${messageOf(error)})`;
  }
  if (typeof checksums !== "object" || checksums === null || Array.isArray(checksums)) {
    return "checksums.json: expected an object of sha256 digests";
  }
  const declared = checksums as Record<string, unknown>;

  const members = new Map<string, Uint8Array>();
  for (const name of names) {
    if (name !== "checksums.json" && Object.prototype.hasOwnProperty.call(files, name)) {
      members.set(name, files[name]!);
    }
  }
  const expected = computeChecksums(members);

  for (const [name, digest] of Object.entries(declared)) {
    if (!members.has(name)) return `checksums.json: no such archive member: ${name}`;
    if (digest !== expected[name]) return `checksum mismatch: ${name}`;
  }
  for (const name of members.keys()) {
    if (!Object.prototype.hasOwnProperty.call(declared, name)) {
      return `checksums.json: missing checksum for ${name}`;
    }
  }
  return undefined;
}

/** Checks manifest fields whose meaning depends on the archive contents. */
function checkContents(manifest: PluginManifest, names: string[]): string | undefined {
  if (!names.includes(manifest.entry)) {
    return `manifest.json: entry is not in the archive: ${manifest.entry}`;
  }
  if (manifest.kind === "app") {
    const routes = manifest.routes;
    if (!Array.isArray(routes) || !routes.every((route) => typeof route === "string")) {
      return "manifest.json: routes are required for kind app";
    }
  }
  return undefined;
}

export async function handleUpload(
  zip: Uint8Array,
  registry: Registry,
  destDir: string,
): Promise<UploadResult> {
  // 1. Size limit — before any parsing or extraction.
  if (zip.byteLength > MAX_ARCHIVE_BYTES) {
    return fail(413, "ARCHIVE_TOO_LARGE", `archive exceeds ${MAX_ARCHIVE_BYTES} bytes`);
  }

  // 2. Unzip in memory, collecting *all* central-directory names. The filter
  //    sees unsafe keys that would otherwise vanish from the plain result map.
  const names: string[] = [];
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(zip, {
      filter(entry) {
        names.push(entry.name);
        return true;
      },
    });
  } catch (error) {
    return fail(400, "INVALID_ARCHIVE", `cannot unzip archive: ${messageOf(error)}`);
  }

  // 3. zip-slip and checksum-map poisoning — before the manifest is trusted.
  const unsafe = verifyArchiveNames(names);
  if (unsafe.length > 0) {
    return fail(400, "UNSAFE_ARCHIVE_MEMBER", `unsafe archive member path: ${unsafe.join(", ")}`);
  }
  const unsafeKeys = names.filter((name) => UNSAFE_KEYS.has(name));
  if (unsafeKeys.length > 0) {
    return fail(
      400,
      "UNSAFE_ARCHIVE_MEMBER",
      `unsafe archive member name: ${unsafeKeys.join(", ")} cannot be checksummed`,
    );
  }

  // 4. Manifest schema/semver and by-kind entry/routes checks.
  if (!Object.prototype.hasOwnProperty.call(files, "manifest.json")) {
    return fail(400, "INVALID_MANIFEST", "missing manifest.json");
  }
  let rawManifest: unknown;
  try {
    rawManifest = JSON.parse(strFromU8(files["manifest.json"]!));
  } catch (error) {
    return fail(400, "INVALID_MANIFEST", `manifest.json: invalid JSON (${messageOf(error)})`);
  }
  const validation = validateManifest(rawManifest);
  if (!validation.ok) {
    return fail(400, "INVALID_MANIFEST", `manifest.json: ${validation.errors.join("; ")}`);
  }
  const manifest = validation.manifest;
  const contentsError = checkContents(manifest, names);
  if (contentsError !== undefined) return fail(400, "INVALID_MANIFEST", contentsError);

  // 5. Installation gate. A rejected archive is never extracted or registered.
  const gate = checkHostApiGate(manifest.hostApi, getPolicy());
  if (!gate.ok) return fail(409, "HOST_API_UNSUPPORTED", gate.message);

  // 6. Checksums — the last check before anything touches the filesystem.
  const checksumError = checkChecksums(files, names);
  if (checksumError !== undefined) return fail(400, "CHECKSUM_MISMATCH", checksumError);

  // 7. Only now extract, register and persist. The validator already enforces
  //    safe id/version segments; this containment assertion is the last line of
  //    defence before anything touches the filesystem.
  const destRoot = resolve(destDir);
  const target = resolve(destDir, manifest.id, manifest.version);
  if (target !== destRoot && !target.startsWith(destRoot + sep)) {
    return fail(400, "UNSAFE_PLUGIN_PATH", `plugin path escapes the destination: ${target}`);
  }
  mkdirSync(target, { recursive: true });
  for (const [name, bytes] of Object.entries(files)) {
    if (name === "checksums.json") continue;
    // Real archives carry `dist/` and `assets/` members; create their parents.
    const file = join(target, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, bytes);
  }

  const descriptor: PluginDescriptorDTO = {
    id: manifest.id,
    version: manifest.version,
    kind: manifest.kind,
    title: manifest.title,
    icon: manifest.icon,
    capabilities: [...manifest.capabilities],
    hostApi: manifest.hostApi,
    unsupported: false,
  };
  registry.add(descriptor);
  registry.save();
  return { status: 201, body: { descriptor } };
}
