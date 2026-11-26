/**
 * Browser-side registry client. The backend snapshot (`{versions,
 * activeVersion}`) is projected into the two halves the host needs: descriptor
 * lists and the authoritative active-version map. This class structurally
 * satisfies `RegistryTransport` from DemoHostAdapter.
 */

import type { HostMeta, PluginDescriptorDTO } from "@vibe/plugin-contracts/host-core";
import type { RegistryTransport } from "./DemoHostAdapter.js";

export interface UploadResult {
  ok: boolean;
  message?: string;
  /** How the host reports the message; `info` for a success, `error` otherwise. */
  level?: "info" | "error";
}

export interface RegistryClientOptions {
  /** Prefix for API paths; empty in the browser, absolute in tests. */
  baseUrl?: string;
  fetch?: typeof fetch;
}

interface Snapshot {
  versions: PluginDescriptorDTO[];
  activeVersion: Record<string, string>;
}

type JsonBody = Record<string, unknown>;

function parseBody(text: string): JsonBody {
  if (text === "") return {};
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      return value as JsonBody;
    }
  } catch {
    // Non-JSON error bodies still get a status-based message.
  }
  return {};
}

function messageOf(body: JsonBody, res: { status: number; statusText: string }): string {
  const message = body.message;
  if (typeof message === "string" && message !== "") return message;
  return `HTTP ${res.status} ${res.statusText}`.trim();
}

export class RegistryClient implements RegistryTransport {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: RegistryClientOptions = {}) {
    this.baseUrl = opts.baseUrl ?? "";
    this.fetchImpl = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  private url(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await this.fetchImpl(this.url(path), init);
    const body = parseBody(await res.text());
    if (!res.ok) throw new Error(messageOf(body, res));
    return body as unknown as T;
  }

  private snapshot(): Promise<Snapshot> {
    return this.request<Snapshot>("/api/plugins");
  }

  /** The DTO array only — never the enclosing snapshot. */
  async list(): Promise<PluginDescriptorDTO[]> {
    return (await this.snapshot()).versions ?? [];
  }

  /** Backend-owned active versions (the single source of truth). */
  async getActiveVersions(): Promise<Record<string, string>> {
    return (await this.snapshot()).activeVersion ?? {};
  }

  async meta(): Promise<HostMeta> {
    return this.request<HostMeta>("/api/meta");
  }

  private putActive(id: string, version: string): Promise<void> {
    return this.request<void>(`/api/plugins/${encodeURIComponent(id)}/active`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version }),
    });
  }

  async setActive(id: string, version: string): Promise<void> {
    await this.putActive(id, version);
  }

  async setActiveVersion(id: string, version: string): Promise<void> {
    await this.putActive(id, version);
  }

  async upload(file: File): Promise<UploadResult> {
    const form = new FormData();
    form.append("file", file, file.name);
    const res = await this.fetchImpl(this.url("/api/plugins"), { method: "POST", body: form });
    const body = parseBody(await res.text());
    if (!res.ok) return { ok: false, message: messageOf(body, res) };
    const message = body.message;
    return typeof message === "string" && message !== "" ? { ok: true, message } : { ok: true };
  }
}
