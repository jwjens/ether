// The stale-layout fallback. Phase 2 changes the pane set, which fires this path on every install
// that has ever opened the workspace — so it is tested rather than reasoned about.
import { describe, it, expect } from "vitest";
import { parseSavedLayout, serializeLayout, LAYOUT_VERSION, PANELS, PRESETS, DEFAULT_PRESET_ID } from "./layoutStore";

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

  it("REJECTS a v2 layout — the Phase 3 case, everyone who ran 4.4.176", () => {
    // Five panes, no Rotation Analytics. Each bump strands the version before it, so every
    // superseded version stays tested rather than only the newest one.
    const v2 = JSON.stringify({ v: 2, layout: { panels: { shows: {}, clocks: {}, categories: {}, spots: {}, jingles: {} } } });
    expect(parseSavedLayout(v2)).toBeNull();
  });

  it("rejects EVERY superseded version, not just the last one", () => {
    for (let v = 1; v < LAYOUT_VERSION; v++) {
      expect(parseSavedLayout(JSON.stringify({ v, layout: { panels: {} } }))).toBeNull();
    }
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

describe("layout presets", () => {
  const ids = PANELS.map(p => p.id) as string[];

  it("every preset names only real panes", () => {
    for (const preset of PRESETS) {
      for (const col of preset.columns) {
        for (const id of col) {
          expect(ids, `preset "${preset.id}" names unknown pane "${id}"`).toContain(id);
        }
      }
    }
  });

  it("NO pane is unreachable — every pane appears in at least one preset", () => {
    // A pane that exists but appears in no preset is only findable by someone who already knows it
    // is there, which is the "doors before rooms" failure. The Panels menu is the other door; this
    // asserts the presets do not quietly drop one.
    const used = new Set(PRESETS.flatMap(p => p.columns.flat()));
    for (const id of ids) expect(used, `pane "${id}" is in no preset`).toContain(id);
  });

  it("no preset opens the same pane twice", () => {
    // dockview keys panels by id; adding one twice would throw or silently no-op.
    for (const preset of PRESETS) {
      const flat = preset.columns.flat();
      expect(new Set(flat).size, `preset "${preset.id}" repeats a pane`).toBe(flat.length);
    }
  });

  it("preset ids are unique and each has a title and a description", () => {
    expect(new Set(PRESETS.map(p => p.id)).size).toBe(PRESETS.length);
    for (const p of PRESETS) {
      expect(p.title.length).toBeGreaterThan(0);
      expect(p.description.length).toBeGreaterThan(0);
    }
  });

  it("the default preset exists — a fresh workspace must have something to open", () => {
    expect(PRESETS.find(p => p.id === DEFAULT_PRESET_ID)).toBeDefined();
  });

  it("every preset fits three columns, so no pane opens below the 220px floor", () => {
    // MIN_PANE_PX is 220; six columns would need 1,320px before any pane is usable.
    for (const p of PRESETS) expect(p.columns.length).toBeLessThanOrEqual(3);
  });

  it("presets do NOT change the stored payload shape — LAYOUT_VERSION stays 3", () => {
    // Recording an "active preset" would add a field and invalidate every saved layout for the
    // third build running. Presets are arrangements applied in place; nothing about them is stored.
    expect(LAYOUT_VERSION).toBe(3);
    expect(Object.keys(JSON.parse(serializeLayout({ a: 1 }))).sort()).toEqual(["layout", "v"]);
  });
});
