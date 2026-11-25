/** Manifest schema version owned by the platform (spec §8.1). */
export const MANIFEST_SCHEMA = 1 as const;

export type ManifestKind = "widget" | "app";

export const MANIFEST_KINDS: readonly ManifestKind[] = ["widget", "app"];

/** Required field rules, shared with `validateManifest`. */
export const REQUIRED_MANIFEST_FIELDS = [
  "schema",
  "id",
  "kind",
  "version",
  "hostApi",
  "sdk",
  "title",
  "icon",
  "entry",
  "capabilities",
  "defaultSize",
  "minSize",
] as const;

export const SIZE_FIELDS = ["w", "h"] as const;

export interface Size {
  w: number;
  h: number;
}

export interface PluginManifest {
  schema: typeof MANIFEST_SCHEMA;
  id: string;
  kind: ManifestKind;
  version: string;
  hostApi: string;
  sdk: string;
  title: string;
  icon: string;
  entry: string;
  capabilities: string[];
  defaultSize: Size;
  minSize: Size;
  /** Required when `kind === "app"`. */
  routes?: string[];
}
