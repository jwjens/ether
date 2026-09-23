// Program Log slice 3 — the docked layout contract, checked on the rendered markup.
//
// There is no DOM environment in this test suite (no jsdom), so this does not measure pixels. It
// renders <ProgramLog embedded /> and <ProgramLog /> with react-dom/server and asserts the layout
// RULES that keep the panel usable at dock height / panel width: the root fills its box, the sidebar
// is a fixed 220px column that SCROLLS as a whole when embedded (so Fill Day / Clear Day / exports
// below the fold stay reachable), the main rundown scrolls independently, no fixed min-width wider
// than a phone, and the operator's controls are all present in both modes. Pixels are Jeff's receipt.
import { describe, it, expect, beforeAll } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ProgramLog, { PROGRAMLOG_DATE_KEY, readSharedDate, writeSharedDate, CHANGED_DEBOUNCE_MS } from "./ProgramLog";

beforeAll(() => {
  // The component reads window.ether / localStorage only inside effects and guarded helpers; SSR runs
  // no effects. Give it a minimal window so the module-level helpers see the shapes they expect.
  (globalThis as any).window = (globalThis as any).window || {};
});

function render(embedded: boolean): string {
  return renderToStaticMarkup(React.createElement(ProgramLog, { embedded, onClose: () => {} }));
}
/** The inline style of the first element whose style contains `needle`. */
function styleOf(html: string, needle: string): string {
  const m = html.match(new RegExp(`style="([^"]*${needle}[^"]*)"`));
  return m ? m[1] : "";
}

describe("ProgramLog docked (embedded) layout contract", () => {
  it("renders in both modes without throwing", () => {
    expect(render(true).length).toBeGreaterThan(1000);
    expect(render(false).length).toBeGreaterThan(1000);
  });
  it("root fills its box (height:100%, flex row) so the dock's height, not the content, sets the size", () => {
    const root = styleOf(render(true), "height:100%");
    expect(root).toMatch(/display:flex/);
  });
  it("sidebar is a fixed 220px column; embedded it scrolls as a whole, standalone it does not", () => {
    const emb = styleOf(render(true), "width:220px");
    const win = styleOf(render(false), "width:220px");
    expect(emb).toMatch(/flex-shrink:0/);
    expect(emb).toMatch(/overflow-y:auto/);
    expect(emb).toMatch(/min-height:0/);
    expect(win).toMatch(/overflow-y:hidden/);
  });
  it("embedded, TODAY'S SHOWS stops claiming all the height (flex 0 0 auto, capped) so the buttons stay in reach", () => {
    const html = render(true);
    const showsIdx = html.indexOf("TODAY&#x27;S SHOWS");
    expect(showsIdx).toBeGreaterThan(0);
    const before = html.slice(Math.max(0, showsIdx - 400), showsIdx);
    expect(before).toMatch(/flex:0 0 auto/);
    expect(before).toMatch(/max-height:180px/);
    const winBefore = render(false).slice(0, 1_000_000);
    const i2 = winBefore.indexOf("TODAY&#x27;S SHOWS");
    expect(winBefore.slice(Math.max(0, i2 - 400), i2)).toMatch(/flex:1/);
  });
  it("the rundown column scrolls on its own (flex:1 + overflow-y:auto)", () => {
    const html = render(true);
    expect(html).toMatch(/style="flex:1;overflow-y:auto;display:flex;flex-direction:column"/);
  });
  it("nothing Jeff uses is hidden when docked: Fill Day, Fill Week, Clear Day, CSV, Print, PDF, the mini month, Shows & Dayparts", () => {
    const html = render(true);
    for (const label of ["Fill Day", "Fill Week", "Clear Day", "CSV", "Print", "PDF Report", "Shows &amp; Dayparts", "Expand All", "Collapse All"]) {
      expect(html, label).toContain(label);
    }
    // seven weekday headers = the mini month is there
    for (const d of ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"]) expect(html).toContain(`>${d}<`);
  });
  it("Fill Week is a door in BOTH trees — docked and pop-out render the same button", () => {
    for (const html of [render(true), render(false)]) {
      expect(html).toContain("Fill Week");
      expect(html).toContain("Fill Day");
    }
  });
  it("no element forces a min-width wider than a narrow panel", () => {
    const widths = [...render(true).matchAll(/min-width:(\d+)px/g)].map(m => Number(m[1]));
    expect(widths.every(w => w <= 320)).toBe(true);
  });
});

describe("shared selected-day key + debounce constants (slice 3)", () => {
  it("the key is per station", () => {
    expect(PROGRAMLOG_DATE_KEY(2)).toBe("ether_programlog_date_2");
    expect(PROGRAMLOG_DATE_KEY(7)).not.toBe(PROGRAMLOG_DATE_KEY(2));
  });
  it("readSharedDate tolerates a missing/throwing localStorage and rejects garbage", () => {
    const g = globalThis as any;
    const saved = g.localStorage;
    delete g.localStorage;
    expect(readSharedDate(2)).toBeNull();          // absent → null, no throw
    writeSharedDate(2, "2026-09-20");               // absent → no throw
    g.localStorage = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    expect(readSharedDate(2)).toBeNull();          // throwing → null
    writeSharedDate(2, "2026-09-20");               // throwing → swallowed
    const store: Record<string, string> = {};
    g.localStorage = { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; } };
    writeSharedDate(2, "2026-09-20");
    expect(readSharedDate(2)).toBe("2026-09-20");
    expect(readSharedDate(3)).toBeNull();          // per station
    store[PROGRAMLOG_DATE_KEY(2)] = "not-a-date";
    expect(readSharedDate(2)).toBeNull();          // garbage → today wins
    if (saved) g.localStorage = saved; else delete g.localStorage;
  });
  it("a burst of schedule:changed events is coalesced into one re-read (400 ms)", () => {
    expect(CHANGED_DEBOUNCE_MS).toBe(400);
  });
});
