/**
 * Registry DTO/snapshot types only (spec §9). The backend owns `activeVersion`
 * as the single source of truth (`PUT /api/plugins/:id/active`); this module
 * contains no storage implementation or I/O — the registry lives in T13.
 */

export interface PluginDescriptorDTO {
  id: string;
  version: string;
  kind: "widget" | "app";
  title: string;
  icon: string;
  capabilities: string[];
  hostApi: string;
  unsupported: boolean;
}

export interface RegistrySnapshot {
  versions: PluginDescriptorDTO[];
  activeVersion: Record<string, string>;
}
