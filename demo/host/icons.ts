/**
 * Inline SVG icons: the host stays dependency-free, so every glyph is a small
 * string rendered with `currentColor`. Names are the host's own; manifest
 * `icon` values are mapped onto them by `pluginGlyph`.
 */

const PATHS = {
  logo: '<path d="M12 2.5 21.5 12 12 21.5 2.5 12z"/><path d="M12 7.5 16.5 12 12 16.5 7.5 12z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  upload: '<path d="M12 16V4M6 10l6-6 6 6M4 20h16"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  "arrow-left": '<path d="M19 12H5M12 19l-7-7 7-7"/>',
  "arrow-up": '<path d="M12 19V5M5 12l7-7 7 7"/>',
  undo: '<path d="M9 14 4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3"/>',
  play: '<path d="M7 4.5v15l12-7.5z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  note: '<path d="M15 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M15 3v5h5M9 13h6M9 17h6"/>',
  tasks: '<path d="m3 7 2 2 3.5-3.5"/><path d="m3 17 2 2 3.5-3.5"/><path d="M12 8h9M12 18h9"/>',
  warning: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
  puzzle: '<path d="M10 3.5a2 2 0 1 1 4 0V5h3a2 2 0 0 1 2 2v3h-1.5a2 2 0 1 0 0 4H19v3a2 2 0 0 1-2 2h-3v-1.5a2 2 0 1 0-4 0V19H7a2 2 0 0 1-2-2v-3h1.5a2 2 0 1 0 0-4H5V7a2 2 0 0 1 2-2h3z"/>',
  box: '<path d="M21 8v8a2 2 0 0 1-1 1.7l-7 4a2 2 0 0 1-2 0l-7-4A2 2 0 0 1 3 16V8a2 2 0 0 1 1-1.7l7-4a2 2 0 0 1 2 0l7 4A2 2 0 0 1 21 8z"/><path d="M3.3 7 12 12l8.7-5M12 22V12"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/>',
  alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"/>',
  tiles: '<rect x="3" y="3" width="8" height="8" rx="2"/><rect x="13" y="3" width="8" height="12" rx="2"/><rect x="3" y="13" width="8" height="8" rx="2"/><rect x="13" y="17" width="8" height="4" rx="2"/>',
} as const;

export type IconName = keyof typeof PATHS;

export function icon(name: IconName, size = 16): string {
  return (
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
    `stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">` +
    `${PATHS[name]}</svg>`
  );
}

/** Manifest `icon` values are free-form names; match the known ones by word. */
export function pluginGlyph(name: string | undefined): IconName {
  const value = (name ?? "").toLowerCase();
  if (value.includes("clock")) return "clock";
  if (value.includes("note")) return "note";
  if (value.includes("task")) return "tasks";
  if (value.includes("warn")) return "warning";
  if (value.includes("puzzle")) return "puzzle";
  return "box";
}
