import { describe, it, expect, afterEach } from "vitest";
import {
  allTypes, typeDef, normalizeType, isKnownType, typesWhere, placeholders,
  rotationEligibleTypes, musicCountingTypes, separationTypes, tabTypes, commercialTypes,
  passesTypeFilter, registerAssetType, unregisterAssetType, FALLBACK_TYPE,
  type AssetTypeDef,
} from "./assetTypes";

const CODES = ["SONG", "SPOT", "PROMO", "SWEEPER", "ANNOUNCEMENT", "VOICE_TRACK", "BED", "SFX"];

describe("the eight built-in types", () => {
  it("are all present", () => {
    for (const c of CODES) expect(isKnownType(c)).toBe(true);
    expect(allTypes()).toHaveLength(8);
  });

  it("have unique codes and unique sort orders", () => {
    const codes = allTypes().map(t => t.code);
    expect(new Set(codes).size).toBe(codes.length);
    const orders = allTypes().map(t => t.defaults.sortOrder);
    expect(new Set(orders).size).toBe(orders.length);
  });

  it("come back in sortOrder", () => {
    const orders = allTypes().map(t => t.defaults.sortOrder);
    expect([...orders].sort((a, b) => a - b)).toEqual(orders);
  });

  it("carry NO duck flags — duck is a channel function, not a type behaviour", () => {
    // Jeff, 2026-08-26: the duck belongs to the CHANNEL/DECK and is available to anything loaded on
    // it, including a live mic. A duck flag here would be a control that does nothing at playout,
    // sitting beside a ducker that works — the defect slice 4 already deleted once.
    for (const t of allTypes()) {
      expect(t).not.toHaveProperty("ducks");
      expect(t).not.toHaveProperty("duckable");
      expect(t.defaults).not.toHaveProperty("ducks");
      expect(t.defaults).not.toHaveProperty("duckable");
    }
  });
});

describe("structural vs configurable", () => {
  it("only SONG is rotation-eligible by default", () => {
    expect(rotationEligibleTypes()).toEqual(["SONG"]);
  });

  it("only SONG counts as music by default", () => {
    expect(musicCountingTypes()).toEqual(["SONG"]);
  });

  it("only SPOT is commercial — a promo is station-owned", () => {
    // Structural, not a setting: what an advertiser affidavit attests is not a per-station
    // preference. If a station SELLS its promos, those assets are typed SPOT.
    expect(commercialTypes()).toEqual(["SPOT"]);
  });

  it("SPOT and PROMO share the traffic meta table; most types need none", () => {
    expect(typeDef("SPOT").metaTable).toBe("asset_spot_meta");
    expect(typeDef("PROMO").metaTable).toBe("asset_spot_meta");
    expect(typeDef("ANNOUNCEMENT").metaTable).toBeNull();
    expect(typeDef("BED").metaTable).toBeNull();
  });

  it("SONG renders no badge — a badge on almost every row is noise", () => {
    expect(typeDef("SONG").badge).toBe("");
    for (const c of CODES.filter(x => x !== "SONG")) expect(typeDef(c).badge).not.toBe("");
  });

  it("keeps the audited colours: SPOT amber, SWEEPER indigo", () => {
    expect(typeDef("SPOT").color).toBe("#f59e0b");
    expect(typeDef("SWEEPER").color).toBe("#4f46e5");
  });

  it("names sweepers SWEEPERS, never jingles", () => {
    // The naming is the defect the convergence fixes. 'Jingle' is spelled into a table, a class, a
    // panel and a bottom-bar button; it does not get spelled into the new registry too.
    expect(typeDef("SWEEPER").defaults.label).toBe("Sweepers");
    expect(typeDef("SWEEPER").badge).toBe("SWP");
    const blob = JSON.stringify(allTypes()).toLowerCase();
    expect(blob).not.toContain("jingle");
  });
});

describe("normalizeType — unknown degrades, never vanishes", () => {
  it("null, undefined and empty become the fallback", () => {
    for (const v of [null, undefined, "", "   "]) expect(normalizeType(v as any)).toBe(FALLBACK_TYPE);
  });

  it("is case-insensitive", () => {
    expect(normalizeType("spot")).toBe("SPOT");
    expect(normalizeType("Voice_Track")).toBe("VOICE_TRACK");
  });

  it("an unknown code degrades to the fallback rather than disappearing", () => {
    // A newer build may write a type this one has never seen. That asset must still be listed,
    // badged and reportable — dropping it is the worst outcome for an as-run record.
    expect(normalizeType("PODCAST")).toBe(FALLBACK_TYPE);
    expect(isKnownType("PODCAST")).toBe(false);
    expect(typeDef("PODCAST").code).toBe(FALLBACK_TYPE);
  });
});

describe("capability queries — no caller ever spells a type literal", () => {
  it("typesWhere selects on behaviour", () => {
    expect(typesWhere(b => b.bus === "source-channel").sort())
      .toEqual(["ANNOUNCEMENT", "BED", "SFX"]);
    expect(typesWhere(b => b.scheduler === "traffic-break").sort())
      .toEqual(["PROMO", "SPOT"]);
  });

  it("placeholders builds an IN-clause of the right width", () => {
    expect(placeholders(rotationEligibleTypes())).toBe("?");
    expect(placeholders(["A", "B", "C"])).toBe("?, ?, ?");
    expect(placeholders([])).toBe("");
  });
});

describe("passesTypeFilter — complete by default", () => {
  it("an EMPTY selection shows everything, never nothing", () => {
    const none = new Set<string>();
    for (const c of [...CODES, null, "WHATEVER"]) expect(passesTypeFilter(c as any, none)).toBe(true);
  });

  it("a selection shows exactly what was chosen", () => {
    const sel = new Set(["SPOT"]);
    expect(passesTypeFilter("SPOT", sel)).toBe(true);
    expect(passesTypeFilter("BED", sel)).toBe(false);
  });

  it("an unknown type filters as the fallback, matching how it displays", () => {
    expect(passesTypeFilter("PODCAST", new Set(["SONG"]))).toBe(true);
    expect(passesTypeFilter("PODCAST", new Set(["SPOT"]))).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// THE OPENNESS TEST — this IS the acceptance criterion for the whole arc.
//
// Jeff: "show me how I'd add a ninth type later — that's the test that it's actually open."
//
// Adding a type must be a diff of ONE OBJECT. If this test ever needs a second edit somewhere else
// to pass, the type system has stopped being open and the build is not finished.
// ══════════════════════════════════════════════════════════════════════════════════════════════
describe("THE OPENNESS TEST — a ninth type is one object", () => {
  const NEWS: AssetTypeDef = {
    code: "NEWS", badge: "NEWS",
    color: "#38bdf8", bg: "rgba(56,189,248,0.14)", border: "rgba(56,189,248,0.45)",
    commercial: false, metaTable: null,
    defaults: {
      label: "News", labelOne: "Newscast",
      rotationEligible: false, scheduler: "log-element", bus: "rotation-deck",
      honorsSeparation: false, countsAsMusic: false, showAsTab: true, sortOrder: 80,
    },
  };

  afterEach(() => unregisterAssetType("NEWS"));

  it("ONE registration is the entire change", () => {
    expect(isKnownType("NEWS")).toBe(false);
    registerAssetType(NEWS);              // ← the whole diff
    expect(isKnownType("NEWS")).toBe(true);
    expect(allTypes()).toHaveLength(9);
  });

  it("rotation excludes it — with no edit to rotation", () => {
    registerAssetType(NEWS);
    expect(rotationEligibleTypes()).not.toContain("NEWS");
    expect(rotationEligibleTypes()).toEqual(["SONG"]);
  });

  it("separation and music metrics exclude it — with no edit to either", () => {
    registerAssetType(NEWS);
    expect(separationTypes()).not.toContain("NEWS");
    expect(musicCountingTypes()).not.toContain("NEWS");
  });

  it("the affidavit excludes it — with no edit to reporting", () => {
    registerAssetType(NEWS);
    expect(commercialTypes()).not.toContain("NEWS");
  });

  it("it gets a Library tab — with no edit to the tab list", () => {
    registerAssetType(NEWS);
    expect(tabTypes().map(t => t.code)).toContain("NEWS");
  });

  it("it gets a filter button that actually filters — with no edit to the filter", () => {
    registerAssetType(NEWS);
    expect(passesTypeFilter("NEWS", new Set(["NEWS"]))).toBe(true);
    expect(passesTypeFilter("NEWS", new Set(["SONG"]))).toBe(false);
    expect(passesTypeFilter("NEWS", new Set())).toBe(true);
  });

  it("it badges and labels itself — with no edit to any renderer", () => {
    registerAssetType(NEWS);
    expect(typeDef("NEWS").badge).toBe("NEWS");
    expect(typeDef("NEWS").defaults.label).toBe("News");
    expect(typeDef("news").color).toBe("#38bdf8");
  });

  it("its log class IS its code — so no mapping table is needed", () => {
    registerAssetType(NEWS);
    expect(normalizeType("NEWS")).toBe("NEWS");
  });

  it("it sorts into place — with no edit to any ordering", () => {
    registerAssetType(NEWS);
    const orders = allTypes().map(t => t.defaults.sortOrder);
    expect([...orders].sort((a, b) => a - b)).toEqual(orders);
    expect(allTypes()[allTypes().length - 1].code).toBe("NEWS");
  });

  it("and the eight are untouched when it is gone", () => {
    registerAssetType(NEWS);
    unregisterAssetType("NEWS");
    expect(allTypes()).toHaveLength(8);
    expect(isKnownType("NEWS")).toBe(false);
  });
});
