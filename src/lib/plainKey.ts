// SINGLE-KEY SHORTCUTS IGNORE CTRL / ALT / META (Jeff, 2026-10-18).
//
// A single-key shortcut is a key pressed on its own: L opens the Library, A toggles automation, 1 fires a cart, Space
// plays. The same key held with Ctrl, Alt or Meta is a DIFFERENT key — Ctrl+S, Ctrl+A, Alt+1 — and must never do what
// the plain key does. Before this, App's handler checked no modifier, so in the code Ctrl+A toggled automation like A
// and Ctrl+L / Ctrl+S / Ctrl+G opened Library / Clocks / Logs (6558e57; runtime unverified — nobody pressed them).
//
// Shift is NOT a modifier here: Shift+/ (the shortcut sheet) and Shift-for-a-bigger-step are deliberate Shift
// combinations and keep working. AltGr on Windows arrives as Ctrl+Alt, so an AltGr character never fires a shortcut.
//
// Every keydown handler in src/ that acts on a single key goes through this — src/lib/plainKey.test.ts checks it.
export function isPlainKey(e: { ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean }): boolean {
  return !e.ctrlKey && !e.altKey && !e.metaKey;
}
