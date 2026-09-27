// fix 24 (docs/help-audit-2026-09-27.md): the in-app HelpPanel's Schedule Manager entry still described the first
// version — three panes, "no docking", Rotation Analytics "a link in the header, not an embedded pane". The window now
// has eight dockable panes (layoutStore PANELS; docs/help-schedule-manager.md). The entry names every pane.
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { PANELS } from "../components/schedule/layoutStore";

const src = fs.readFileSync(path.join(__dirname, "..", "components", "HelpPanel.tsx"), "utf8");
const at = src.indexOf('id: "schedule-manager"');
const entry = src.slice(at, src.indexOf('id: "rotation-analytics"', at));

describe("HelpPanel's Schedule Manager entry matches the window (audit 24)", () => {
  it("the entry is found", () => { expect(at).toBeGreaterThan(0); expect(entry.length).toBeGreaterThan(500); });
  it("no first-version claims", () => {
    expect(entry).not.toMatch(/three-pane|no docking|not an embedded pane|all three panes/i);
  });
  it("names every pane the window has", () => {
    for (const p of PANELS) expect(entry, p.title).toContain(p.title);
  });
});
