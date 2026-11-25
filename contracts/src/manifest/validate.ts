import { createHash } from "node:crypto";
import { CAPS_CATALOGUE } from "../protocol/index.js";
import { hostApiMajor } from "./hostApi.js";
import {
  MANIFEST_KINDS,
  MANIFEST_SCHEMA,
  REQUIRED_MANIFEST_FIELDS,
  SIZE_FIELDS,
  type ManifestKind,
  type PluginManifest,
} from "./schema.js";

export type ValidationResult =
  | { ok: true; manifest: PluginManifest }
  | { ok: false; errors: string[] };

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const WINDOWS_DRIVE = /^[A-Za-z]:/;
const PARENT_SEGMENT = /(^|\/)\.\.(\/|$)/;
/** Plugin ids become a directory name below storage/plugins: keep them single-segment. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const CONTROL_CHAR = /[\u0000-\u001f\u007f]/;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Containment rule shared by every manifest field used inside an extraction path. */
function isContainedSegment(value: unknown): value is string {
  return (
    isNonEmptyString(value) &&
    !value.includes("/") &&
    !value.includes("\\") &&
    !value.includes("..") &&
    !WINDOWS_DRIVE.test(value) &&
    !CONTROL_CHAR.test(value)
  );
}

function isSafeId(value: unknown): value is string {
  return isContainedSegment(value) && SAFE_ID.test(value);
}

function isSize(value: unknown): boolean {
  if (!isObject(value)) return false;
  return SIZE_FIELDS.every((field) => {
    const number = value[field];
    return typeof number === "number" && Number.isFinite(number) && number > 0;
  });
}

function isRoutes(value: unknown): boolean {
  return Array.isArray(value) && value.every((route) => typeof route === "string");
}

/** Structural validation of `manifest.json` against the field rules of spec §8.1. */
export function validateManifest(input: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isObject(input)) return { ok: false, errors: ["manifest must be an object"] };

  for (const field of REQUIRED_MANIFEST_FIELDS) {
    if (input[field] === undefined || input[field] === null) {
      errors.push(`missing required field: ${field}`);
    }
  }

  if (input.schema !== MANIFEST_SCHEMA) errors.push(`schema must be ${MANIFEST_SCHEMA}`);
  if (!isSafeId(input.id)) {
    errors.push("id must be a safe single-segment identifier (letters, digits, '.', '_', '-'; no '..')");
  }
  if (typeof input.kind !== "string" || !MANIFEST_KINDS.includes(input.kind as ManifestKind)) {
    errors.push("kind must be widget or app");
  }
  for (const field of ["version", "sdk"] as const) {
    const value = input[field];
    if (typeof value !== "string" || !SEMVER.test(value)) {
      errors.push(`${field} must be a semver version`);
    }
  }
  // `version` is also a directory component of the extraction target.
  if (!isContainedSegment(input.version)) {
    errors.push("version must be a safe single-segment path component");
  }
  if (hostApiMajor(input.hostApi) === null) {
    errors.push("hostApi must be a single-major semver range");
  }
  for (const field of ["title", "icon", "entry"] as const) {
    if (!isNonEmptyString(input[field])) errors.push(`${field} must be a non-empty string`);
  }
  if (
    !Array.isArray(input.capabilities) ||
    !input.capabilities.every((cap) => typeof cap === "string" && CAPS_CATALOGUE.includes(cap))
  ) {
    errors.push("capabilities must be a subset of the capability catalogue");
  }
  for (const field of ["defaultSize", "minSize"] as const) {
    if (!isSize(input[field])) errors.push(`${field} must have positive numeric w and h`);
  }
  if (input.routes !== undefined && !isRoutes(input.routes)) {
    errors.push("routes must be an array of strings");
  }
  if (input.kind === "app" && !isRoutes(input.routes)) {
    errors.push("routes are required for kind app");
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, manifest: input as unknown as PluginManifest };
}

/** sha256 of each archive member, keyed by member name; never writes files. */
export function computeChecksums(files: Map<string, Uint8Array>): Record<string, string> {
  const checksums: Record<string, string> = {};
  for (const [name, bytes] of files) {
    checksums[name] = createHash("sha256").update(bytes).digest("hex");
  }
  return checksums;
}

/** Returns the archive member names that could escape the extraction directory (zip-slip). */
export function verifyArchiveNames(names: string[]): string[] {
  return names.filter(
    (name) =>
      name.includes("\\") ||
      name.startsWith("/") ||
      WINDOWS_DRIVE.test(name) ||
      PARENT_SEGMENT.test(name),
  );
}
