/**
 * Widget dev loop (catalog "Разработка" section): which plugin ids mount
 * their frames from a `vite dev` origin instead of the installed archives.
 * Persisted in localStorage so the choice survives page reloads; the host
 * holds the same array by reference, so updates apply to live mounts too.
 */

export interface DevPlugin {
  id: string;
  origin: string;
}

const KEY = "vibe.devPlugins";
export const DEFAULT_DEV_ORIGIN = "http://localhost:5173";

function normalizeOrigin(raw: string): string | null {
  const origin = raw.trim().replace(/\/+$/, "");
  return /^https?:\/\/.+/.test(origin) ? origin : null;
}

export function normalizeId(raw: string): string | null {
  const id = raw.trim();
  return id !== "" ? id : null;
}

export function loadDevPlugins(): DevPlugin[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const list: DevPlugin[] = [];
    for (const entry of parsed) {
      const id = typeof (entry as DevPlugin)?.id === "string" ? normalizeId((entry as DevPlugin).id) : null;
      const origin = typeof (entry as DevPlugin)?.origin === "string" ? normalizeOrigin((entry as DevPlugin).origin) : null;
      if (id === null || origin === null || seen.has(id)) continue;
      seen.add(id);
      list.push({ id, origin });
    }
    return list;
  } catch {
    return [];
  }
}

export function saveDevPlugins(list: DevPlugin[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // Storage can be disabled; the choice still applies for this page load.
  }
}

export function addDevPlugin(list: DevPlugin[], id: string, origin: string): { ok: boolean; error?: string } {
  const cleanId = normalizeId(id);
  if (cleanId === null) return { ok: false, error: "Укажите id плагина" };
  const cleanOrigin = normalizeOrigin(origin === "" ? DEFAULT_DEV_ORIGIN : origin);
  if (cleanOrigin === null) return { ok: false, error: "Origin должен начинаться с http:// или https://" };
  if (list.some((entry) => entry.id === cleanId)) {
    return { ok: false, error: `«${cleanId}» уже в разработке` };
  }
  list.push({ id: cleanId, origin: cleanOrigin });
  saveDevPlugins(list);
  return { ok: true };
}

export function removeDevPlugin(list: DevPlugin[], id: string): void {
  const index = list.findIndex((entry) => entry.id === id);
  if (index !== -1) {
    list.splice(index, 1);
    saveDevPlugins(list);
  }
}
