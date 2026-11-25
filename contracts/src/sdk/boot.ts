/**
 * Boot data injected by `pack` into the plugin's index.html from manifest.json
 * (spec §8.4). The SDK reads it synchronously — no network, no fetch.
 */
export interface Boot {
  id: string;
  version: string;
  hostApiMajor: string;
  sdk: string;
  capabilities: string[];
  kind: "widget" | "app";
  routes?: string[];
}

declare global {
  interface Window {
    __VIBE_BOOT__?: unknown;
  }
}

function invalid(detail: string): never {
  throw new TypeError(`__VIBE_BOOT__: ${detail}`);
}

function stringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    invalid(`invalid ${field}`);
  }
  return [...(value as string[])];
}

/** Reads and validates the injected boot global; throws a descriptive error if absent/malformed. */
export function readBoot(): Boot {
  const raw = window.__VIBE_BOOT__;
  if (raw === undefined || raw === null) invalid("missing injected boot data");
  if (typeof raw !== "object" || Array.isArray(raw)) invalid("expected an object");

  const data = raw as Record<string, unknown>;
  if (typeof data.id !== "string" || data.id === "") invalid("invalid id");
  if (typeof data.version !== "string" || data.version === "") invalid("invalid version");
  if (typeof data.hostApiMajor !== "string" || data.hostApiMajor === "") invalid("invalid hostApiMajor");
  if (typeof data.sdk !== "string" || data.sdk === "") invalid("invalid sdk");
  if (data.kind !== "widget" && data.kind !== "app") invalid("invalid kind");

  const boot: Boot = {
    id: data.id,
    version: data.version,
    hostApiMajor: data.hostApiMajor,
    sdk: data.sdk,
    capabilities: stringList(data.capabilities, "capabilities"),
    kind: data.kind,
  };
  if (data.routes !== undefined) boot.routes = stringList(data.routes, "routes");
  return boot;
}
