// The stale-layout fallback. Phase 2 changes the pane set, which fires this path on every install
// that has ever opened the workspace — so it is tested rather than reasoned about.
import { describe, it, expect } from "vitest";
import { parseSavedLayout, serializeLayout, LAYOUT_VERSION } from "./layoutStore";

describe("parseSavedLayout", () => {
  it("restores a current-version layout", () => {
    const layout = { grid: { root: { type: "branch" } }, panels: { shows: {} } };
    expect(parseSavedLayout(serializeLayout(layout))).toEqual(layout);
  });

  it("REJECTS a v1 layout — the Phase 2 case, every existing operator", () => {
    // Exactly what 4.4.174 wrote: three panes, no Spots, no Jingles. Restoring it would leave the
    // two new panes absent with no indication they exist.
    const v1 = JSON.stringify({ v: 1, layout: { panels: { shows: {}, clocks: {}, categories: {} } } });
    expect(parseSavedLayout(v1)).toBeNull();
  });

  it("rejects a FUTURE version — a downgrade must not eat a newer layout", () => {
    expect(parseSavedLayout(JSON.stringify({ v: LAYOUT_VERSION + 1, layout: {} }))).toBeNull();
  });

  it("returns null for every unusable payload instead of throwing", () => {
    for (const raw of [null, undefined, "", "   ", "{", "not json", "[]", "null", "42", '"a string"',
                       JSON.stringify({ layout: {} }),            // no version
                       JSON.stringify({ v: LAYOUT_VERSION })]) {  // version but no layout
      expect(parseSavedLayout(raw as any)).toBeNull();
    }
  });

  it("round-trips: serialize always stamps the current version", () => {
    expect(JSON.parse(serializeLayout({ a: 1 })).v).toBe(LAYOUT_VERSION);
    expect(parseSavedLayout(serializeLayout({ a: 1 }))).toEqual({ a: 1 });
  });

  it("treats a cleared slot as absent — this is what Reset Layout writes", () => {
    expect(parseSavedLayout("")).toBeNull();
  });
});
