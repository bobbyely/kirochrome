import { useEffect } from "react";

export interface Shortcuts {
  onNewChat: () => void;
  onFocusSearch: () => void;
  onNextSession: (delta: number) => void;
  onEscape: () => void;
}

/** True when the user is typing, so shortcuts do not steal their keystrokes. */
function isEditing(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return (
    el.tagName === "INPUT" ||
    el.tagName === "TEXTAREA" ||
    el.tagName === "SELECT" ||
    el.isContentEditable
  );
}

/**
 * Global shortcuts.
 *
 * Deliberately few, and none that collide with the browser's own: no Cmd+N,
 * no Cmd+W, no single letters while typing.
 */
export function useShortcuts(shortcuts: Shortcuts): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;

      if (e.key === "Escape") {
        shortcuts.onEscape();
        return;
      }

      // Cmd/Ctrl+K — focus search. Works even while typing, like most apps.
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        shortcuts.onFocusSearch();
        return;
      }

      // Cmd/Ctrl+Shift+O — new chat. Shift avoids the browser's Cmd+O.
      if (mod && e.shiftKey && e.key.toLowerCase() === "o") {
        e.preventDefault();
        shortcuts.onNewChat();
        return;
      }

      if (isEditing(e.target)) return;

      // Alt+Up / Alt+Down — move through conversations.
      if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
        e.preventDefault();
        shortcuts.onNextSession(e.key === "ArrowDown" ? 1 : -1);
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shortcuts]);
}
