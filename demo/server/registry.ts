/**
 * Demo backend registry: all installed versions plus a backend-authoritative
 * activeVersion per plugin id. The in-memory state mirrors `registry.json` so
 * installations and rollbacks survive a server restart.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { PluginDescriptorDTO, RegistrySnapshot } from "@vibe/plugin-contracts/host-core";
import { checkHostApiGate } from "@vibe/plugin-contracts/manifest";
import { getPolicy } from "@vibe/plugin-contracts/protocol";

const key = (id: string, version: string): string => `${id}\u0000${version}`;

function clone(dto: PluginDescriptorDTO): PluginDescriptorDTO {
  return { ...dto, capabilities: [...dto.capabilities] };
}

function isDescriptor(value: unknown): value is PluginDescriptorDTO {
  if (typeof value !== "object" || value === null) return false;
  const dto = value as Partial<PluginDescriptorDTO>;
  return (
    typeof dto.id === "string" &&
    typeof dto.version === "string" &&
    (dto.kind === "widget" || dto.kind === "app") &&
    typeof dto.title === "string" &&
    typeof dto.icon === "string" &&
    Array.isArray(dto.capabilities) &&
    dto.capabilities.every((cap) => typeof cap === "string") &&
    typeof dto.hostApi === "string" &&
    typeof dto.unsupported === "boolean"
  );
}

export class Registry {
  private readonly versions = new Map<string, PluginDescriptorDTO>();
  private readonly active = new Map<string, string>();

  constructor(private readonly path: string) {
    let snapshot: Partial<RegistrySnapshot>;
    try {
      snapshot = JSON.parse(readFileSync(path, "utf8")) as Partial<RegistrySnapshot>;
    } catch {
      return; // missing or corrupt file: start with an empty registry
    }

    if (Array.isArray(snapshot.versions)) {
      for (const dto of snapshot.versions) {
        if (isDescriptor(dto)) this.versions.set(key(dto.id, dto.version), clone(dto));
      }
    }
    const storedActive = snapshot.activeVersion;
    if (storedActive && typeof storedActive === "object") {
      for (const [id, version] of Object.entries(storedActive)) {
        if (typeof version === "string" && this.versions.has(key(id, version))) {
          this.active.set(id, version);
        }
      }
    }
  }

  /** Installing a version never switches the active one; the first version wins. */
  add(dto: PluginDescriptorDTO): void {
    this.versions.set(key(dto.id, dto.version), clone(dto));
    if (!this.active.has(dto.id)) this.active.set(dto.id, dto.version);
  }

  list(): PluginDescriptorDTO[] {
    return Array.from(this.versions.values(), clone);
  }

  activeVersion(id: string): string {
    const version = this.active.get(id);
    if (version === undefined) throw new Error(`no active version for plugin "${id}"`);
    return version;
  }

  /** Explicit activation (or rollback); gated by the shared compatibility policy. */
  setActive(id: string, version: string): void {
    const dto = this.versions.get(key(id, version));
    if (!dto) throw new Error(`cannot activate "${id}@${version}": version is not installed`);
    const gate = checkHostApiGate(dto.hostApi, getPolicy());
    if (!gate.ok) throw new Error(`cannot activate "${id}@${version}": ${gate.message}`);
    this.active.set(id, version);
  }

  /** Mark a deprecated major as unsupported after sunset (and persist the flag). */
  markUnsupported(id: string, version: string): void {
    const dto = this.versions.get(key(id, version));
    if (!dto) {
      throw new Error(`cannot mark "${id}@${version}" unsupported: version is not installed`);
    }
    dto.unsupported = true;
    this.save();
  }

  /**
   * Uninstalls every version of a plugin. Returns the removed descriptors;
   * the caller decides what to do with the unpacked files.
   */
  delete(id: string): PluginDescriptorDTO[] {
    const removed: PluginDescriptorDTO[] = [];
    for (const [mapKey, dto] of [...this.versions]) {
      if (dto.id !== id) continue;
      removed.push(clone(dto));
      this.versions.delete(mapKey);
    }
    if (removed.length === 0) {
      throw new Error(`cannot delete "${id}": plugin is not installed`);
    }
    this.active.delete(id);
    this.save();
    return removed;
  }

  save(): void {
    const snapshot: RegistrySnapshot = {
      versions: this.list(),
      activeVersion: Object.fromEntries(this.active),
    };
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  }
}
