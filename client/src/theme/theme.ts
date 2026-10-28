export type Theme = "light" | "dark";

// Also read by the inline script in index.html, which applies the theme before first paint.
export const THEME_KEY = "flako:theme";

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

/** The user's saved choice, or null to follow the system. Blocked storage counts as no choice. */
export function readTheme(storage: Storage): Theme | null {
  try {
    const v = storage.getItem(THEME_KEY);
    return v === "light" || v === "dark" ? v : null;
  } catch {
    return null;
  }
}

export function writeTheme(storage: Storage, theme: Theme): void {
  try {
    storage.setItem(THEME_KEY, theme);
  } catch {
    // private mode or blocked site data: the choice lasts until reload, which is fine
  }
}

export function effectiveTheme(stored: Theme | null, systemPrefersDark: boolean): Theme {
  return stored ?? (systemPrefersDark ? "dark" : "light");
}
