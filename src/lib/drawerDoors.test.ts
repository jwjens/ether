// fix 23 (docs/help-audit-2026-09-27.md): the ☰ menu — the canonical navigation (DOORS BEFORE ROOMS) — had no Health
// Monitor and no Announcements entry; both were reachable only from the native menus. Both are now ☰ entries on the
// same pop-out path as every other entry, and every entry's panel is one the pop-out router knows.
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const app = fs.readFileSync(path.join(__dirname, "..", "App.tsx"), "utf8");
const router = fs.readFileSync(path.join(__dirname, "..", "components", "PopoutRenderer.tsx"), "utf8");
const list = app.slice(app.indexOf("ONE LIST, AND EVERY ENTRY IS A WINDOW"), app.indexOf("] as const).map(item =>", app.indexOf("ONE LIST, AND EVERY ENTRY IS A WINDOW")));
const entries = [...list.matchAll(/\{ key: "([^"]+)",\s*emoji: "[^"]*",\s*label: "([^"]+)",\s*panel: "([^"]+)" \}/g)].map(m => ({ key: m[1], label: m[2], panel: m[3] }));

describe("the ☰ menu is a door to Health Monitor and Announcements (audit 23)", () => {
  it("the list is found", () => { expect(entries.length).toBeGreaterThan(10); });
  it("Health Monitor and Announcements are entries", () => {
    expect(entries.find(e => e.label === "Health Monitor")?.panel).toBe("health");
    expect(entries.find(e => e.label === "Announcements")?.panel).toBe("announce");
  });
  it("every entry opens a pop-out the router renders", () => {
    for (const e of entries) expect(router, e.panel).toMatch(new RegExp(`case "${e.panel}":|panel === "${e.panel}"`));
  });
});
