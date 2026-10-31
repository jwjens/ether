// Item 27: Shift+/ opened two overlays; both listed keys that don't exist; G was labelled Program Log but opens the
// Play Log; A/S/G fired carts AND their app shortcut while the CARTS push-up was open.
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { appShortcut } from "./appShortcuts";
const app = fs.readFileSync(path.join(__dirname, "..", "App.tsx"), "utf8");
const sheet = app.slice(app.indexOf('{ group: "Navigation"'), app.indexOf("].map(({ group, items })"));
describe("one shortcut sheet, and only real keys on it", () => {
  it("the second overlay is not mounted", () => { expect(app).not.toMatch(/<KeyboardHelp \/>/); });
  it("every single-letter key on the sheet is one appShortcut answers", () => {
    for (const m of sheet.matchAll(/key: "([A-Z])"/g)) expect(appShortcut({ code: `Key${m[1]}` }), m[1]).not.toBe(null);
    expect(sheet).not.toMatch(/key: "N"/);
    expect(sheet).toMatch(/key: "G", desc: "Play Log"/);
    expect(app).toMatch(/case "logs": setPanel\("logs"\)/);
  });
  it("an open cart wall's keys fire carts only", () => {
    expect(app).toMatch(/if \(cartWallOwnsKey\(e\.key\)\) return;/);
  });
});
