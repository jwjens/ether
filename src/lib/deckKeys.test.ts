// fix 2 (docs/help-audit-2026-09-27.md): Space and B played / paused / resumed decks straight from the keyboard —
// outside the board's ON button and the daemon's serialized path. Jeff's ruling: the board is the sole gate; the keys
// go through ON or are removed. They are removed; no key may start, pause or resume a deck.
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const app = fs.readFileSync(path.join(__dirname, "..", "App.tsx"), "utf8");
// The global keyboard handler: from `const handleKey` to its addEventListener.
const start = app.indexOf("const handleKey = (e: KeyboardEvent)");
const handler = app.slice(start, app.indexOf('window.addEventListener("keydown", handleKey)', start));

describe("no keyboard shortcut starts, pauses or resumes a deck (audit 2)", () => {
  it("the handler is found", () => { expect(start).toBeGreaterThan(0); expect(handler.length).toBeGreaterThan(100); });
  it("Space and B have no case", () => {
    expect(handler).not.toMatch(/case "Space"/);
    expect(handler).not.toMatch(/case "KeyB"/);
  });
  it("the handler calls no deck transport", () => {
    expect(handler).not.toMatch(/\.(play|pause|resume|stop)\(\)/);
  });
  it("the shortcut lists no longer offer Space / B for decks", () => {
    const kh = fs.readFileSync(path.join(__dirname, "..", "components", "KeyboardHelp.tsx"), "utf8");
    expect(kh).not.toMatch(/Play \/ Pause Deck/);
    expect(app).not.toMatch(/Play \/ Pause Deck/);
  });
});
