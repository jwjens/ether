// fix 3 (docs/help-audit-2026-09-27.md): both shortcut lists offered "X — Crossfade" (the key was removed 2026-09-07)
// and "Esc — Stop all decks" (Esc never kills audio; it closes the overlay and the drawer). Every row a list shows must
// be a key the handler actually has.
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const app = fs.readFileSync(path.join(__dirname, "..", "App.tsx"), "utf8");
const kh = fs.readFileSync(path.join(__dirname, "..", "components", "KeyboardHelp.tsx"), "utf8");

describe("the shortcut lists offer no key the app doesn't have (audit 3)", () => {
  it("no Crossfade row, no 'Stop all decks' row", () => {
    for (const src of [app, kh]) {
      expect(src).not.toMatch(/key: "X", (desc|action): "Crossfade/);
      expect(src).not.toMatch(/Stop all decks/);
    }
  });
  it("the handler still has no X case and Esc still only closes things", () => {
    const start = app.indexOf("const handleKey = (e: KeyboardEvent)");
    const handler = app.slice(start, app.indexOf('window.addEventListener("keydown", handleKey)', start));
    // The key → action mapping lives in src/lib/appShortcuts.ts since 2026-10-18 (plain keys only); App dispatches on it.
    const map = fs.readFileSync(path.join(__dirname, "appShortcuts.ts"), "utf8");
    expect(handler).not.toMatch(/case "KeyX"/);
    expect(map).not.toMatch(/case "KeyX"/);
    expect(map).toMatch(/case "Escape": return "close";/);
    expect(handler).toMatch(/case "close": setShowShortcuts\(false\); setDrawerOpen\(false\); break;/);
  });
});
