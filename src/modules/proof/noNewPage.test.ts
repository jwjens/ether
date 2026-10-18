// S5 — NO NEW HARD-CODED PAGE (docs/screen-builder-design-2026-10-18.md §3; Jeff: "NO new hard-coded page. Ever.").
//
// Today's four lists of hard-coded screens are frozen in no-new-page.baseline.json:
//   panels       the dashboard's `type Panel` union (src/App.tsx)
//   popoutCases  the pop-out router's `case "...":` list (src/components/PopoutRenderer.tsx)
//   drawer       the ☰ list anchored at "ONE LIST, AND EVERY ENTRY IS A WINDOW" (parsed as drawerDoors.test.ts does)
//   windows      every `new BrowserWindow(` site in electron/, by enclosing function / ipcMain channel
//
// A RATCHET. The test fails when a list GROWS — a page, pop-out case, ☰ entry or window that is not in the baseline.
// A new screen is a layout of registered modules (src/modules/registry.ts), never a new entry here. It also fails when
// the baseline names something the tree no longer has, so a page that converts is struck from the baseline in the same
// commit and the list can only shrink. Review any diff that ADDS a line to the baseline as a defect.
import { describe, it, expect } from "vitest";
import baseline from "./no-new-page.baseline.json";
import { panelUnion, popoutCases, drawerEntries, windowSites } from "./pageLists";

const LISTS: { name: keyof typeof baseline; label: string; now: () => string[] }[] = [
  { name: "panels", label: "dashboard Panel union (src/App.tsx)", now: panelUnion },
  { name: "popoutCases", label: "pop-out router cases (src/components/PopoutRenderer.tsx)", now: popoutCases },
  { name: "drawer", label: "☰ list (src/App.tsx)", now: drawerEntries },
  { name: "windows", label: "new BrowserWindow( sites (electron/)", now: windowSites },
];

describe("S5 — no new hard-coded page (the lists may only shrink)", () => {
  for (const l of LISTS) {
    const recorded = baseline[l.name] as string[];
    it(`${l.label}: nothing beyond the recorded baseline`, () => {
      const now = l.now();
      expect(now.length, `${l.label} could not be read — has the source moved?`).toBeGreaterThan(0);
      const added = [...new Set(now)].filter(x => !recorded.includes(x));
      expect(added, `NEW HARD-CODED ${l.label}: ${added.join(", ")}. Build it as a layout of registered modules ` +
        `(src/modules/registry.ts), not as a new page.`).toEqual([]);
    });
    it(`${l.label}: the baseline names nothing the tree has dropped (strike converted pages)`, () => {
      const now = new Set(l.now());
      const gone = recorded.filter(x => !now.has(x));
      expect(gone, `${l.label} shrank: remove ${gone.join(", ")} from no-new-page.baseline.json`).toEqual([]);
    });
  }
  it("the baseline has no duplicates", () => {
    for (const l of LISTS) {
      const r = baseline[l.name] as string[];
      expect(new Set(r).size, l.name).toBe(r.length);
    }
  });
});
