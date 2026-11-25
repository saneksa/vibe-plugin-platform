/** Segments of a path, ignoring leading/trailing slashes and any query/hash. */
function segments(path: string): string[] {
  return path
    .split(/[?#]/, 1)[0]
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .filter((part) => part !== "");
}

/**
 * Matches a host-supplied path against the plugin's route table and calls the
 * first matching handler. `:param` segments become entries in `params`.
 * Unmatched paths are a no-op.
 */
export function routeMatcher(
  routes: Record<string, (params: Record<string, string>) => void>,
  path: string,
): void {
  const parts = segments(path);
  for (const [pattern, handler] of Object.entries(routes)) {
    const expected = segments(pattern);
    if (expected.length !== parts.length) continue;

    const params: Record<string, string> = {};
    let matched = true;
    for (let i = 0; i < expected.length; i++) {
      const segment = expected[i];
      if (segment.startsWith(":")) {
        params[segment.slice(1)] = decodeURIComponent(parts[i]);
      } else if (segment !== parts[i]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      handler(params);
      return;
    }
  }
}
