/**
 * Deprecated-major (v1) envelope adapter (spec §8/§9). This is the
 * envelope-level helper: it shapes a legacy wire envelope into the current
 * `Envelope` shape but never rewrites the declared major — `api: "1"` comes
 * back as `"1"`, so `compatibility.json` stays the single source of truth.
 * The dispatcher-shaped `adaptV1` seam in `MessageRouter` is a different
 * artifact and is intentionally not wired here.
 */

import type { Envelope } from "../../protocol/index.js";

export function adaptV1Envelope(e: Envelope): Envelope {
  switch (e.type) {
    case "rpc":
      return {
        type: "rpc",
        iid: e.iid,
        id: e.id,
        api: e.api,
        method: e.method,
        ...(e.params === undefined ? {} : { params: e.params }),
      };
    default:
      return { ...e };
  }
}
