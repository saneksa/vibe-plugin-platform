import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { strFromU8, unzipSync } from "fflate";
import {
  checkHostApiGate,
  computeChecksums,
  validateManifest,
  verifyArchiveNames,
} from "@vibe/plugin-contracts/manifest";
import { getPolicy } from "@vibe/plugin-contracts/protocol";

function readJson(files, name, errors) {
  if (!Object.prototype.hasOwnProperty.call(files, name)) {
    errors.push(`missing ${name}`);
    return undefined;
  }
  try {
    return JSON.parse(strFromU8(files[name]));
  } catch (error) {
    errors.push(`${name}: invalid JSON (${error.message})`);
    return undefined;
  }
}

/** Validates a plugin archive using the same validator and policy as the backend. */
export async function check(zipPath) {
  const errors = [];
  const path = resolve(zipPath);
  if (!existsSync(path)) return { ok: false, errors: [`archive not found: ${path}`] };

  let bytes;
  try {
    bytes = new Uint8Array(readFileSync(path));
  } catch (error) {
    return { ok: false, errors: [`cannot read archive ${path}: ${error.message}`] };
  }

  const names = [];
  let files;
  try {
    // The filter sees every central-directory name, including keys that would
    // be swallowed by assignment onto a plain object (e.g. "__proto__").
    files = unzipSync(bytes, {
      filter(entry) {
        names.push(entry.name);
        return true;
      },
    });
  } catch (error) {
    return { ok: false, errors: [`cannot unzip ${path}: ${error.message}`] };
  }

  for (const name of verifyArchiveNames(names)) {
    errors.push(`unsafe archive member path: ${name}`);
  }
  if (names.includes("__proto__")) {
    errors.push("unsafe archive member name: __proto__ cannot be checksummed");
  }

  const rawManifest = readJson(files, "manifest.json", errors);
  if (rawManifest !== undefined) {
    const validation = validateManifest(rawManifest);
    if (!validation.ok) {
      for (const error of validation.errors) errors.push(`manifest.json: ${error}`);
    } else {
      const gate = checkHostApiGate(validation.manifest.hostApi, getPolicy());
      if (!gate.ok) errors.push(`manifest.json: ${gate.message}`);
    }
  }

  const checksums = readJson(files, "checksums.json", errors);
  if (checksums !== undefined) {
    if (typeof checksums !== "object" || checksums === null || Array.isArray(checksums)) {
      errors.push("checksums.json: expected an object of sha256 digests");
    } else {
      const members = new Map();
      for (const name of names) {
        if (name !== "checksums.json" && Object.prototype.hasOwnProperty.call(files, name)) {
          members.set(name, files[name]);
        }
      }
      const expected = computeChecksums(members);
      for (const [name, digest] of Object.entries(checksums)) {
        if (!members.has(name)) errors.push(`checksums.json: no such archive member: ${name}`);
        else if (digest !== expected[name]) errors.push(`checksum mismatch: ${name}`);
      }
      for (const name of members.keys()) {
        if (!Object.prototype.hasOwnProperty.call(checksums, name)) {
          errors.push(`checksums.json: missing checksum for ${name}`);
        }
      }
    }
  }

  return { ok: errors.length === 0, errors };
}
