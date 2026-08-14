// The card colours and the words on them. Pure, so the mapping that tells an operator "you are
// fine" or "you are about to run out" is testable without rendering.
import { describe, it, expect } from "vitest";
import { toLevel, levelColor, runwayValue, goalsValue, queueLevel, designationValue,
         barState, noGoalsDeclared, eventLevel, eventTitle, eventSummary, eventTime,
         type CategoryGoal } from "./healthUtils";

const cat = (o: Partial<CategoryGoal> = {}): CategoryGoal => ({
  categoryId: 1, category: "Gold", target: 4, spins24h: 96, actualSpinsPerHour: 4, ...o,
});

describe("toLevel — unknown reads GREY, never green", () => {
  it("passes the three real levels through", () => {
    expect(toLevel("green")).toBe("green");
    expect(toLevel("yellow")).toBe("yellow");
    expect(toLevel("red")).toBe("red");
  });

  it("maps anything else to grey rather than inventing health", () => {
    // A card that renders green because a field was missing is worse than one that says nothing.
    for (const v of [undefined, null, "", "GREEN", "ok", 1, {}]) expect(toLevel(v)).toBe("grey");
  });

  it("every level resolves to a colour", () => {
    for (const v of ["green", "yellow", "red", "grey", undefined]) expect(levelColor(v)).toMatch(/var\(--/);
  });
});

describe("runwayValue", () => {
  it("distinguishes 'not applicable' from zero — they must never look the same", () => {
    // days is null only when level is grey (no active show). 0 days is real and urgent.
    expect(runwayValue({ days: null }).value).toBe("—");
    expect(runwayValue({ days: null }).sub).toContain("no active show");
    expect(runwayValue(null).value).toBe("—");
  });

  it("shows days when there is real runway", () => {
    expect(runwayValue({ days: 6.2 }).value).toBe("6.2d");
    expect(runwayValue({ days: 6.2 }).sub).toContain("first gap");
  });

  it("switches to HOURS under a day, where the number matters most", () => {
    expect(runwayValue({ days: 0.5 }).value).toBe("12h");
    expect(runwayValue({ days: 0.02 }).value).toBe("0h");
    expect(runwayValue({ days: 0.5 }).sub).toContain("today");
  });

  it("marks a capped runway as 'past the horizon', not as an exact figure", () => {
    // runway.js caps its lookahead at 30 days; reporting "30d" flat would be a false precision.
    expect(runwayValue({ days: 30, capped: true }).value).toBe("30d+");
  });
});

describe("goalsValue", () => {
  it("says None, in grey, when no goals are declared — that is a choice, not a fault", () => {
    const g = goalsValue({ declared: 0 });
    expect(g.value).toBe("None");
    expect(g.level).toBe("grey");
    expect(goalsValue(null).level).toBe("grey");
  });

  it("is green and reads 0 when every clock matches", () => {
    const g = goalsValue({ declared: 5, mismatches: [] });
    expect(g.value).toBe("0");
    expect(g.level).toBe("green");
  });

  it("shows the COUNT of mismatched clocks: yellow at 1–2, red beyond", () => {
    expect(goalsValue({ declared: 5, mismatches: [{}] }).value).toBe("1");
    expect(goalsValue({ declared: 5, mismatches: [{}] }).level).toBe("yellow");
    expect(goalsValue({ declared: 5, mismatches: [{}, {}] }).level).toBe("yellow");
    expect(goalsValue({ declared: 5, mismatches: [{}, {}, {}] }).level).toBe("red");
  });

  it("uses the singular for one", () => {
    expect(goalsValue({ declared: 3, mismatches: [{}] }).sub).toContain("clock off");
  });
});

describe("queueLevel — green >=10, yellow 5-9, red <5", () => {
  it("under five is red — under twenty minutes of cover at ~3.5 min a track", () => {
    expect(queueLevel(0)).toBe("red");
    expect(queueLevel(4)).toBe("red");
  });

  it("five to nine is amber", () => {
    expect(queueLevel(5)).toBe("yellow");
    expect(queueLevel(9)).toBe("yellow");
  });

  it("ten or more is green — about half an hour of cover", () => {
    expect(queueLevel(10)).toBe("green");
    expect(queueLevel(40)).toBe("green");
  });

  it("unknown is grey, NOT red — 'the engine did not answer' is not 'the queue is empty'", () => {
    expect(queueLevel(null)).toBe("grey");
    expect(queueLevel(undefined)).toBe("grey");
  });
});

describe("barState — the rotation bar", () => {
  it("is green at target and above", () => {
    expect(barState(cat({ actualSpinsPerHour: 4 })).level).toBe("green");
    expect(barState(cat({ actualSpinsPerHour: 9 })).level).toBe("green");
  });

  it("is yellow within 2 below, red beyond", () => {
    expect(barState(cat({ actualSpinsPerHour: 3 })).level).toBe("yellow");
    expect(barState(cat({ actualSpinsPerHour: 2 })).level).toBe("yellow");   // target - 2, inclusive
    expect(barState(cat({ actualSpinsPerHour: 1.9 })).level).toBe("red");
    expect(barState(cat({ actualSpinsPerHour: 0 })).level).toBe("red");
  });

  it("CLAMPS the fill at 100% but still flags 'over' — 4.6x must not look like exactly on target", () => {
    // Real reading from halloVeen on 2026-08-13: 18.4/hr against a declared target of 4.
    const b = barState(cat({ actualSpinsPerHour: 18.4 }));
    expect(b.pct).toBe(100);
    expect(b.over).toBe(true);
    expect(barState(cat({ actualSpinsPerHour: 4 })).over).toBe(false);
    expect(b.label).toBe("18.4/4 /hr");     // both numbers, so the overage is legible
  });

  it("NO TARGET is grey and empty, never a zero-percent judgement", () => {
    // Most categories on real stations have no target. Dividing by it would be Infinity/NaN, and
    // colouring it red would accuse a PD of missing a goal they never set.
    const b = barState(cat({ target: null, actualSpinsPerHour: 0.1 }));
    expect(b.hasTarget).toBe(false);
    expect(b.level).toBe("grey");
    expect(b.pct).toBe(0);
    expect(b.label).toContain("no target");
    expect(b.label).toContain("0.1");       // the actual is still stated
  });

  it("treats a target of 0 as 'no target' — 'no goal' and 'a goal of zero' differ", () => {
    expect(barState(cat({ target: 0 })).hasTarget).toBe(false);
    expect(barState(cat({ target: -1 })).hasTarget).toBe(false);
  });

  it("never emits NaN or a negative width from bad input", () => {
    for (const a of [NaN, Infinity, -5, undefined as any]) {
      const b = barState(cat({ actualSpinsPerHour: a }));
      expect(Number.isFinite(b.pct)).toBe(true);
      expect(b.pct).toBeGreaterThanOrEqual(0);
      expect(b.pct).toBeLessThanOrEqual(100);
    }
  });

  it("scales proportionally in between", () => {
    expect(barState(cat({ target: 10, actualSpinsPerHour: 5 })).pct).toBe(50);
    expect(barState(cat({ target: 8, actualSpinsPerHour: 6 })).pct).toBe(75);
  });
});

describe("noGoalsDeclared", () => {
  it("is true when nothing is declared — the muted state", () => {
    expect(noGoalsDeclared([])).toBe(true);
    expect(noGoalsDeclared(null)).toBe(true);
    expect(noGoalsDeclared([cat({ target: null }), cat({ categoryId: 2, target: 0 })])).toBe(true);
  });

  it("is false as soon as ONE category has a target", () => {
    // Station 1 has exactly this shape: 1 of 10 categories with a target.
    expect(noGoalsDeclared([cat({ target: null }), cat({ categoryId: 2, target: 3 })])).toBe(false);
  });
});

describe("eventLevel — severity from the KIND, not from free text", () => {
  it("marks real failures red", () => {
    // These are all kinds this codebase actually emits.
    for (const k of ["auto-extend-failed", "station-designation-write-failed", "sync-misconfigured",
                     "cloud-reconcile-down", "logreader-floor"])
      expect(eventLevel(k), k).toBe("red");
  });

  it("marks degraded-but-running amber", () => {
    for (const k of ["logreader-missed", "fill-starved", "separation-relaxed",
                     "auto-extend-skipped-not-designated", "auto-extend-migrated"])
      expect(eventLevel(k), k).toBe("yellow");
  });

  it("leaves ordinary activity green — a timeline of amber is one nobody reads", () => {
    for (const k of ["auto-extend", "designation-refreshed", "log-edit", "generate-timing",
                     "generate-operator-rows-preserved", "cloud-reconcile-up"])
      expect(eventLevel(k), k).toBe("green");
  });

  it("an unknown or missing kind is grey, never green", () => {
    expect(eventLevel(undefined)).toBe("grey");
    expect(eventLevel("")).toBe("grey");
  });
});

describe("eventTitle / eventTime / eventSummary", () => {
  it("humanises a kebab kind", () => {
    expect(eventTitle("auto-extend-skipped-not-designated")).toBe("Auto extend skipped not designated");
    expect(eventTitle(null)).toBe("event");
  });

  it("returns empty rather than 'Invalid Date' for a bad stamp", () => {
    expect(eventTime("nonsense")).toBe("");
    expect(eventTime(undefined)).toBe("");
    expect(eventTime("2026-08-13T17:31:49.000Z")).not.toBe("");
  });

  it("prefers a real message over dumping the payload", () => {
    expect(eventSummary({ station: "halloVeen", message: "Failed to fetch" }))
      .toBe("halloVeen · Failed to fetch");
    expect(eventSummary({ station: "OV", error: "boom" })).toContain("boom");
  });

  it("falls back to numbers that mean something on their own", () => {
    expect(eventSummary({ station: "OV", rows: 42 })).toBe("OV · 42 rows");
    expect(eventSummary({ from: "A", to: "B" })).toBe("A → B");
    expect(eventSummary({ failures: 124 })).toBe("124 failures");
  });

  it("summarises logreader-missed, which carries ONLY stationId/count/driftSec", () => {
    // Ten of these rendered with a title and a blank line in the first cut — the exact wall of
    // identical rows the dashboard exists to replace.
    const s = eventSummary({ kind: "logreader-missed", stationId: 2, count: 21, driftSec: 4 });
    expect(s).toContain("s2");
    expect(s).toContain("21 rows");
    expect(s).toContain("drift 4s");
  });

  it("uses the singular for one row", () => {
    expect(eventSummary({ stationId: 3, count: 1 })).toContain("1 row");
    expect(eventSummary({ stationId: 3, count: 1 })).not.toContain("1 rows");
  });

  it("collapses a library-health snapshot to the one fact worth a row", () => {
    expect(eventSummary({ kind: "library-health", stations: [{ name: "A", level: "green" }] }))
      .toBe("1 stations · all green");
    expect(eventSummary({ kind: "library-health", stations: [{ name: "A", level: "yellow" }, { name: "B", level: "green" }] }))
      .toContain("A yellow");
  });

  it("NEVER returns a blank line when the event has any scalar at all", () => {
    // The guarantee: a row with a title and empty space is what made the list unreadable.
    expect(eventSummary({ someField: 7 })).toBe("someField 7");
    expect(eventSummary({ a: 1, b: 2, c: 3, d: 4 }).split(" · ").length).toBe(3);   // capped at 3
  });

  it("never throws on junk", () => {
    expect(eventSummary(null)).toBe("");
    expect(eventSummary({} as any)).toBe("");
  });
});

describe("designationValue", () => {
  it("names this machine when it holds it", () => {
    const d = designationValue({ state: "mine", level: "green" });
    expect(d.value).toBe("This machine");
    expect(d.level).toBe("green");
  });

  it("names the other machine, and says this one will not generate", () => {
    const d = designationValue({ state: "other", holderName: "OVEVENTS", level: "green" });
    expect(d.value).toBe("OVEVENTS");
    expect(d.sub).toContain("will not auto-generate");
  });

  it("falls back to the id, then to a generic name", () => {
    expect(designationValue({ state: "other", holder: "8e8f6181" }).value).toBe("8e8f6181");
    expect(designationValue({ state: "other" }).value).toBe("Another machine");
  });

  it("shows the bypass as amber", () => {
    expect(designationValue({ state: "bypassed" }).level).toBe("yellow");
  });

  it("no record is grey — normal on a station nobody has generated", () => {
    expect(designationValue(null).value).toBe("None");
    expect(designationValue(null).level).toBe("grey");
  });

  it("tolerates null holder fields, which is what the IPC actually sends", () => {
    expect(() => designationValue({ state: "other", holder: null, holderName: null })).not.toThrow();
    expect(designationValue({ state: "other", holder: null, holderName: null }).value).toBe("Another machine");
  });
});
