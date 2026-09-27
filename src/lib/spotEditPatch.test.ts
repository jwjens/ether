// fix 9 (docs/help-audit-2026-09-27.md): Edit Spot had no cart / ISCI fields — they could only come from Import
// Traffic CSV, which writes one value into both. The editor now has a Cart # and an ISCI field of its own, and Save
// writes both (they are in the spots handler's PATCHABLE list, electron/sync/handlers/spots.js).
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { spotEditPatch } from "./spotEditPatch";

describe("Edit Spot saves cart and ISCI separately (audit 9)", () => {
  it("the save patch carries both, each its own value; blank clears to NULL", () => {
    const p = spotEditPatch({ title: "Ad", cart_number: "C-1042", isci_code: "ABCD1234H" } as any);
    expect(p.cart_number).toBe("C-1042");
    expect(p.isci_code).toBe("ABCD1234H");
    const blank = spotEditPatch({ title: "Ad", cart_number: "  ", isci_code: "" } as any);
    expect(blank.cart_number).toBeNull();
    expect(blank.isci_code).toBeNull();
  });
  it("keeps every field the editor already saved", () => {
    const p = spotEditPatch({ title: "Ad", spot_type: "commercial", advertiser: "Acme", start_date: "2026-10-01", end_date: null,
      max_plays_day: 4, is_active: 0, notes: "n", spot_category_id: 3, art_image: null } as any);
    expect(p).toMatchObject({ title: "Ad", spot_type: "commercial", advertiser: "Acme", start_date: "2026-10-01", end_date: null,
      max_plays_day: 4, is_active: 0, notes: "n", spot_category_id: 3, art_image: null });
  });
  it("the editor shows a Cart # and an ISCI field and saves through the patch; the handler accepts both", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "components", "Spots.tsx"), "utf8");
    const editor = src.slice(src.indexOf("{/* Edit panel */}"), src.indexOf("{/* Spot list */}"));
    expect(editor).toMatch(/value=\{editing\.cart_number \|\| ""\}/);
    expect(editor).toMatch(/value=\{editing\.isci_code \|\| ""\}/);
    expect(src).toMatch(/updateById\(editing\.id, spotEditPatch\(editing\)\)/);
    const h = fs.readFileSync(path.join(__dirname, "..", "..", "electron", "sync", "handlers", "spots.js"), "utf8");
    expect(h).toMatch(/PATCHABLE\s*=\s*\[[^\]]*"isci_code"[^\]]*"cart_number"/);
  });
});
