/**
 * Instance registry (§8.7). Every widget tile and every full-screen app gets
 * one `iid` that lives for the whole instance lifetime and also acts as the
 * `storage` key (keyed by pluginId + iid, never by version).
 *
 * `version` here is the version seen when the record was created or last
 * reconciled. The backend `activeVersion` stays the source of truth; apps have
 * no BSP leaf, so without this field `reconcile()` could not detect that an
 * open app needs a fresh frame.
 */

export type InstanceKind = "widget" | "app";

export type InstanceRecord = {
  iid: string;
  pluginId: string;
  version: string;
  kind: InstanceKind;
  route?: string; // app only: current path for deep-links
};

export type InstanceRegistry = Record<string, InstanceRecord>; // host.instances.v1

/** Allocates a fresh iid; callers never generate or choose one. */
export function createInstanceRecord(
  pluginId: string,
  version: string,
  kind: InstanceKind,
  route?: string,
): InstanceRecord {
  const record: InstanceRecord = {
    iid: crypto.randomUUID(),
    pluginId,
    version,
    kind,
  };
  if (route !== undefined) record.route = route;
  return record;
}
