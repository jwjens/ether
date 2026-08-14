// The card colours and the words on them. Pure, so the mapping that tells an operator "you are
// fine" or "you are about to run out" is testable without rendering.
import { describe, it, expect } from "vitest";
import { toLevel, levelColor, runwayValue, goalsValue, queueLevel, designationValue } from "./healthUtils";

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

  it("is green when every clock matches", () => {
    const g = goalsValue({ declared: 5, mismatches: [] });
    expect(g.value).toBe("On target");
    expect(g.level).toBe("green");
  });

  it("counts CLOCKS off target, and stays amber — an off-target clock is not dead air", () => {
    const g = goalsValue({ declared: 5, mismatches: [{}, {}] });
    expect(g.value).toBe("2 off");
    expect(g.level).toBe("yellow");
    expect(g.sub).toContain("clocks");
  });

  it("uses the singular for one", () => {
    expect(goalsValue({ declared: 3, mismatches: [{}] }).sub).toContain("1 clock do");
  });
});

describe("queueLevel", () => {
  it("an EMPTY queue is red — nothing is behind what is on air", () => {
    expect(queueLevel(0)).toBe("red");
  });

  it("shallow is amber, healthy is green", () => {
    expect(queueLevel(1)).toBe("yellow");
    expect(queueLevel(2)).toBe("yellow");
    expect(queueLevel(3)).toBe("green");
  });

  it("unknown is grey, NOT red — 'the engine did not answer' is not 'the queue is empty'", () => {
    expect(queueLevel(null)).toBe("grey");
    expect(queueLevel(undefined)).toBe("grey");
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
