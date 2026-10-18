// The dashboard's single-key shortcuts (App.tsx handleKey), as a pure mapping so they can be tested without mounting
// the whole app. App.tsx dispatches on what this returns; the shortcut sheet (App.tsx "Keyboard Shortcuts") lists
// the same keys.
//
// Every key here is a PLAIN key (isPlainKey): with Ctrl, Alt or Meta held it is not a shortcut at all — Ctrl+S never
// opens Clocks and Ctrl+A never toggles automation. Shift+/ is a deliberate Shift combination and keeps working.
import { isPlainKey } from "./plainKey";

export type AppShortcut = "library" | "clocks" | "logs" | "toggleAuto" | "toggleShortcuts" | "close" | null;

export function appShortcut(e: { code: string; shiftKey?: boolean; ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean }): AppShortcut {
  if (!isPlainKey(e)) return null;
  switch (e.code) {
    case "KeyL": return "library";
    case "KeyS": return "clocks";
    case "KeyG": return "logs";
    case "KeyA": return "toggleAuto";
    case "Slash": return e.shiftKey ? "toggleShortcuts" : null;
    case "Escape": return "close";
    default: return null;
  }
}
