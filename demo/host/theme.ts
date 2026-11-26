/**
 * Host theme. The `light` class on `<html>` is the single switch: stylesheets
 * key on it, tests assert it, and `DemoHostAdapter.getTheme` reads it so that
 * plugins see the same theme as the host chrome.
 */

export type Theme = "dark" | "light";

/** Also read by the inline script in index.html, before first paint. */
export const THEME_KEY = "vibe.theme";

export function currentTheme(): Theme {
  return document.documentElement.classList.contains("light") ? "light" : "dark";
}

export function applyStoredTheme(): void {
  try {
    if (localStorage.getItem(THEME_KEY) === "light") setTheme("light");
  } catch {
    // Storage can be disabled; the default theme stays.
  }
}

export function setTheme(theme: Theme): void {
  document.documentElement.classList.toggle("light", theme === "light");
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Not persistable: the choice still applies for this page load.
  }
}

export function toggleTheme(): Theme {
  const next: Theme = currentTheme() === "light" ? "dark" : "light";
  setTheme(next);
  return next;
}
