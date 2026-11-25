import type { CompatibilityPolicy } from "./policy.js";

const BARE_MAJOR = /^[0-9]+$/;

/** Wire `api` carries the major only ("2"), never a minor ("2.4"). */
export function majorOf(api: string): string {
  if (typeof api !== "string" || !BARE_MAJOR.test(api)) {
    throw new TypeError(`api must be a bare major, got ${JSON.stringify(api)}`);
  }
  return api;
}

/** Choose the handler for a declared major: current, legacy v1 adapter, or reject. */
export function selectAdapter(api: string, policy: CompatibilityPolicy): "current" | "v1" | "reject" {
  const major = majorOf(api);
  if (!policy.supported.includes(major)) return "reject";
  if (major === String(policy.current)) return "current";
  if (policy.deprecated[major]?.adapter) return "v1";
  return "reject";
}
