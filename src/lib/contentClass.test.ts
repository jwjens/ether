import { describe, it, expect } from "vitest";
import { normalizeClass, classMeta, passesClassFilter, CLASS_ORDER } from "./contentClass";

describe("normalizeClass", () => {
  it("treats NULL and empty as MUSIC — every pre-v29 row has no class", () => {
    expect(normalizeClass(null)).toBe("MUSIC");
    expect(normalizeClass(undefined)).toBe("MUSIC");
    expect(normalizeClass("")).toBe("MUSIC");
    expect(normalizeClass("   ")).toBe("MUSIC");
  });

  it("recognises every class the schema writes", () => {
    for (const c of ["MUSIC", "JIN", "SWP", "SPOT", "ANN"]) expect(normalizeClass(c)).toBe(c);
  });

  it("is case-insensitive", () => {
    expect(normalizeClass("ann")).toBe("ANN");
    expect(normalizeClass("Spot")).toBe("SPOT");
  });

  it("falls back to MUSIC for an unknown class rather than dropping the row", () => {
    // A row that aired must always be shown, even if a future build wrote a class this one has never
    // heard of. Vanishing would be the worst outcome for a log.
    expect(normalizeClass("PODCAST")).toBe("MUSIC");
    expect(normalizeClass("¯\\_(ツ)_/¯")).toBe("MUSIC");
  });
});

describe("classMeta", () => {
  it("gives MUSIC no badge colour, so most rows stay unbadged", () => {
    expect(classMeta(null).code).toBe("MUSIC");
    expect(classMeta(null).bg).toBe("transparent");
  });

  it("keeps the audited tokens: JIN teal, SWP indigo, SPOT amber", () => {
    expect(classMeta("JIN").fg).toBe("#14e0c8");
    expect(classMeta("SWP").fg).toBe("#4f46e5");
    expect(classMeta("SPOT").fg).toBe("#f59e0b");
  });

  it("labels each class the way an operator says it", () => {
    expect(classMeta("ANN").label).toBe("Announcements");
    expect(classMeta("SPOT").label).toBe("Spots");
    expect(classMeta("JIN").label).toBe("Jingles");
  });
});

describe("passesClassFilter — the default must be COMPLETE", () => {
  it("an empty selection shows EVERYTHING — never nothing", () => {
    // The whole ruling: complete by default. An empty filter meaning "hide all" would silently
    // empty the log the first time someone cleared it.
    const none = new Set<string>();
    for (const c of [null, "MUSIC", "SPOT", "JIN", "SWP", "ANN"]) {
      expect(passesClassFilter(c, none)).toBe(true);
    }
  });

  it("a selection shows exactly what was selected", () => {
    const sel = new Set(["SPOT"]);
    expect(passesClassFilter("SPOT", sel)).toBe(true);
    expect(passesClassFilter("ANN", sel)).toBe(false);
    expect(passesClassFilter(null, sel)).toBe(false);
  });

  it("selecting MUSIC also matches untyped rows", () => {
    const sel = new Set(["MUSIC"]);
    expect(passesClassFilter(null, sel)).toBe(true);
    expect(passesClassFilter("", sel)).toBe(true);
    expect(passesClassFilter("MUSIC", sel)).toBe(true);
  });

  it("multiple classes can be selected together", () => {
    const sel = new Set(["SPOT", "ANN"]);
    expect(passesClassFilter("SPOT", sel)).toBe(true);
    expect(passesClassFilter("ANN", sel)).toBe(true);
    expect(passesClassFilter("JIN", sel)).toBe(false);
  });

  it("an unknown class is filtered as MUSIC, matching how it is displayed", () => {
    expect(passesClassFilter("PODCAST", new Set(["MUSIC"]))).toBe(true);
    expect(passesClassFilter("PODCAST", new Set(["ANN"]))).toBe(false);
  });
});

describe("CLASS_ORDER", () => {
  it("offers every class exactly once", () => {
    expect(new Set(CLASS_ORDER).size).toBe(CLASS_ORDER.length);
    expect(CLASS_ORDER).toContain("MUSIC");
    expect(CLASS_ORDER).toContain("ANN");
  });
});
