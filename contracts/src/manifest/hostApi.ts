import type { CompatibilityPolicy } from "../protocol/index.js";

export type HostApiGateResult = { ok: true } | { ok: false; message: string };

/** A caret/tilde/exact range pinned to one major: `^2.0`, `~1.2`, `2`, `1.x`. */
const MAJOR_RANGE = /^(\^|~)?([0-9]+)(?:\.(?:[0-9]+|[xX*]))?(?:\.(?:[0-9]+|[xX*]))?$/;

/** Declared major of a single-major semver range, or null when it is not one. */
export function hostApiMajor(hostApi: unknown): string | null {
  if (typeof hostApi !== "string") return null;
  const match = MAJOR_RANGE.exec(hostApi.trim());
  return match ? match[2] : null;
}

/**
 * Installation gate (spec §9): a plugin may only be installed under the host's current
 * major. Majors in `supported` that carry a `deprecated[maj].sunset` are no longer
 * installable, even though legacy envelopes still reach their adapter at runtime.
 */
export function checkHostApiGate(hostApi: string, policy: CompatibilityPolicy): HostApiGateResult {
  const major = hostApiMajor(hostApi);
  const hostMajor = String(policy.current);

  if (major !== null && policy.supported.includes(major) && !policy.deprecated[major]?.sunset) {
    return { ok: true };
  }

  return {
    ok: false,
    message:
      `плагин собран под hostAPI ${major ?? hostApi}, хост поддерживает ${hostMajor}; ` +
      `соберите с @vibe/plugin-contracts ≥ ${hostMajor}.0`,
  };
}
