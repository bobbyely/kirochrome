export type Theme = "system" | "light" | "dark";

const KEY = "kirochrome.theme";

/**
 * Theme is a per-browser preference, not conversation state, so localStorage is
 * the right home for it — invariant 3 is about the event log, not UI chrome.
 */
export function loadTheme(): Theme {
  try {
    const stored = localStorage.getItem(KEY);
    if (stored === "light" || stored === "dark" || stored === "system") return stored;
  } catch {
    // Private browsing, or site data blocked. Fall through to the default.
  }
  return "system";
}

export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);

  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // Not being able to remember it is not worth failing over.
  }
}
