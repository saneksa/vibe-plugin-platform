import compatibility from "../../compatibility.json" with { type: "json" };
import { CAPS_CATALOGUE } from "./caps.js";

export interface DeprecatedMajor {
  sunset: string;
  adapter: string;
}

/** The exported `@vibe/plugin-contracts/compatibility.json` artifact. */
export interface CompatibilityPolicy {
  current: number;
  supported: string[];
  deprecated: Record<string, DeprecatedMajor>;
  matrix: Record<string, string>;
}

/** Diagnostic payload for `ready` / `GET /api/meta` / `HostAdapter.getMeta()`. */
export interface HostMeta {
  supportedMajors: string[];
  deprecated: Record<string, DeprecatedMajor>;
  sunset?: string;
  capsCatalogue: string[];
  hostVersion?: string;
}

/** Synchronous: the policy is statically bundled JSON — no filesystem, no network. */
export function getPolicy(): CompatibilityPolicy {
  return compatibility;
}

export function getMeta(policy: CompatibilityPolicy): HostMeta {
  const deprecated = policy.deprecated ?? {};
  const sunset = Object.values(deprecated)[0]?.sunset;
  return {
    supportedMajors: [...policy.supported],
    deprecated,
    ...(sunset === undefined ? {} : { sunset }),
    capsCatalogue: [...CAPS_CATALOGUE],
  };
}
