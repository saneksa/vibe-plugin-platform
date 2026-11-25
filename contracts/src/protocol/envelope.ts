/**
 * Wire envelopes (spec §8.2). Every message is JSON and carries `iid`.
 * `api` is the protocol major only; minors are expressed as additive `caps`.
 */
export type Envelope =
  | { type: "hello"; iid: string; api: string; sdk: string; plugin: { id: string; version: string }; wants: string[] }
  | { type: "ready"; iid: string; api: string; caps: string[]; deprecated: string[]; sunset?: string; hostVersion?: string }
  | { type: "rpc"; iid: string; id: number; api: string; method: string; params?: unknown }
  | { type: "rpc.result"; iid: string; id: number; ok: true; value: unknown }
  | { type: "rpc.result"; iid: string; id: number; ok: false; error: { code: string; message: string } }
  | { type: "event"; iid: string; topic: string; value: unknown }
  | { type: "navigate"; iid: string; path: string; replace?: boolean }
  | { type: "route"; iid: string; path: string }
  | { type: "lifecycle"; iid: string; state: "suspend" | "resume" | "destroy" }
  | { type: "error"; iid: string; message: string };

const KNOWN_TYPES = new Set([
  "hello",
  "ready",
  "rpc",
  "rpc.result",
  "event",
  "navigate",
  "route",
  "lifecycle",
  "error",
]);

export function encodeEnvelope(e: Envelope): string {
  return JSON.stringify(e);
}

/**
 * Validation boundary: accepts a wire string or an already-parsed object and
 * throws on anything that is not a well-formed envelope. Unknown `type` and a
 * missing/invalid `iid` are hard errors, not silently tolerated.
 */
export function decodeEnvelope(raw: unknown): Envelope {
  const value: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("envelope must be a JSON object");
  }
  const env = value as Record<string, unknown>;
  if (typeof env.iid !== "string" || env.iid.length === 0) {
    throw new TypeError("envelope is missing iid");
  }
  if (typeof env.type !== "string" || !KNOWN_TYPES.has(env.type)) {
    throw new TypeError(`unknown envelope type: ${String(env.type)}`);
  }
  return env as unknown as Envelope;
}
