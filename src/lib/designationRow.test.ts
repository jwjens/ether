// The Designated generator row shipped in 4.4.193 with a REFRESH NOW button that read successfully,
// changed nothing on screen, and gave no reason. Jeff's report: the button appears broken.
//
// These are the rules that make it legible. They are tested here rather than through the component
// because the component cannot be rendered without a DOM, and because the same class of defect has
// now been fixed three times in this panel by reasoning about state that nothing asserted.
import { describe, it, expect } from "vitest";
import { designationView, effectiveAutoOn, refreshBanner, BLOCKED_NOTE, type DesignationStatus } from "./designationRow";

const NONE: DesignationStatus = { state: "none", level: "grey", text: "none — no machine has auto-generated this station yet" };
const MINE: DesignationStatus = { state: "mine", level: "green", text: "This machine — checked in 2s ago", autoOn: true, lastGenerated: 1000 };

describe("effectiveAutoOn", () => {
  it("trusts the live toggle map over the tick's copy", () => {
    // The operator has just switched AUTO ON; the tick still remembers OFF. Trusting the tick here
    // would disable the button at the one moment it is needed.
    expect(effectiveAutoOn(true, { autoOn: false })).toBe(true);
    expect(effectiveAutoOn(false, { autoOn: true })).toBe(false);
  });

  it("falls back to the tick for a station the toggle map has not read", () => {
    expect(effectiveAutoOn(undefined, { autoOn: true })).toBe(true);
    expect(effectiveAutoOn(undefined, { autoOn: false })).toBe(false);
  });

  it("returns null when neither knows — unreadable is not OFF", () => {
    expect(effectiveAutoOn(undefined, {})).toBe(null);
    expect(effectiveAutoOn(null, null)).toBe(null);
  });
});

describe("designationView — auto-generation OFF", () => {
  const v = designationView(NONE, false, false);

  it("disables the button rather than letting it look inert", () => {
    expect(v.blocked).toBe(true);
    expect(v.buttonDisabled).toBe(true);
  });

  it("says why beside the button, not only in a tooltip", () => {
    expect(v.note).toBe(BLOCKED_NOTE);
    expect(v.buttonTitle).toContain("Auto-gen off");
  });

  it("never leaves a bare 'None' unexplained", () => {
    expect(v.value).toBe("None");
    expect(v.sub).toContain("Auto-generate is off");
    expect(v.sub).toContain("Nothing is wrong");   // this state is correct, not a fault
    expect(v.sub).not.toBe(NONE.text);
  });
});

describe("designationView — auto-generation ON", () => {
  it("leaves the button live and unexplained-by-exception", () => {
    const v = designationView(NONE, true, false);
    expect(v.blocked).toBe(false);
    expect(v.buttonDisabled).toBe(false);
    expect(v.note).toBe(null);
    expect(v.sub).toBe(NONE.text);          // the tick's own words, not ours
  });

  it("flips to 'This machine' and reads green once designated", () => {
    const v = designationView(MINE, true, false);
    expect(v.value).toBe("This machine");
    expect(v.status).toBe("ok");            // green
    expect(v.blocked).toBe(false);
  });
});

describe("designationView — unreadable auto-generation", () => {
  // Guessing OFF here would disable the one control that could reveal what is actually stored.
  it("does NOT block when the flag could not be read", () => {
    const v = designationView(NONE, null, false);
    expect(v.blocked).toBe(false);
    expect(v.buttonDisabled).toBe(false);
    expect(v.note).toBe(null);
  });
});

describe("designationView — the loading state", () => {
  it("spells out REFRESHING… instead of a bare ellipsis", () => {
    const v = designationView(NONE, true, true);
    expect(v.buttonLabel).toBe("REFRESHING…");
    expect(v.buttonDisabled).toBe(true);
    expect(v.buttonTitle).toContain("Re-reading");
  });

  it("returns to REFRESH NOW when idle", () => {
    expect(designationView(NONE, true, false).buttonLabel).toBe("REFRESH NOW");
  });

  it("stays disabled and still says why when busy AND blocked", () => {
    const v = designationView(NONE, false, true);
    expect(v.buttonDisabled).toBe(true);
    expect(v.note).toBe(BLOCKED_NOTE);
    // The blocked reason outranks the busy text: it is the one the operator needs.
    expect(v.buttonTitle).toContain("Auto-gen off");
  });
});

describe("designationView — other machines and the bypass", () => {
  it("names the holder when another machine owns it", () => {
    const v = designationView({ state: "other", level: "green", holderName: "BOOTH-2", text: "BOOTH-2 — checked in 4 min ago" }, true, false);
    expect(v.value).toBe("BOOTH-2");
  });

  it("falls back to 'Another machine' when the holder has no name", () => {
    expect(designationView({ state: "other", level: "yellow" }, true, false).value).toBe("Another machine");
  });

  it("shows the kill switch as Bypassed", () => {
    expect(designationView({ state: "bypassed", level: "yellow" }, true, false).value).toBe("Bypassed");
  });

  it("maps red to error and yellow to warn", () => {
    expect(designationView({ state: "other", level: "red" }, true, false).status).toBe("error");
    expect(designationView({ state: "other", level: "yellow" }, true, false).status).toBe("warn");
  });
});

describe("refreshBanner", () => {
  // The read stamp resets on the 30s poll too, so it never was evidence that the CLICK did
  // anything. These strings are that evidence.
  it("is green and names this machine when we hold it", () => {
    const b = refreshBanner(MINE);
    expect(b.tone).toBe("success");
    expect(b.text).toBe("Designation refreshed – this machine is designated");
  });

  it("is green and names the other machine when it holds it", () => {
    const b = refreshBanner({ state: "other", holderName: "BOOTH-2" });
    expect(b.tone).toBe("success");
    expect(b.text).toBe("Designation refreshed – BOOTH-2 is designated");
  });

  it("falls back to the machine id when the holder has no name", () => {
    expect(refreshBanner({ state: "other", holder: "abc-123" }).text).toContain("abc-123");
  });

  it("is NEUTRAL, not green, when nobody is designated", () => {
    const b = refreshBanner(NONE);
    expect(b.tone).toBe("neutral");
    expect(b.text).toBe("Designation refreshed – no machine is designated");
  });

  it("treats a missing row as 'no machine designated' rather than throwing", () => {
    expect(refreshBanner(undefined).tone).toBe("neutral");
    expect(refreshBanner(null).text).toContain("no machine is designated");
  });

  it("says so when designation is bypassed", () => {
    const b = refreshBanner({ state: "bypassed" });
    expect(b.tone).toBe("neutral");
    expect(b.text).toContain("bypassed");
  });
});

describe("designationView — nothing has ticked yet", () => {
  // `d` undefined is a state to state, not a reason to vanish or to invent a fault.
  it("renders None/ok without throwing on an absent row", () => {
    const v = designationView(undefined, undefined, false);
    expect(v.value).toBe("None");
    expect(v.status).toBe("ok");
    expect(v.blocked).toBe(false);
    expect(v.sub).toContain("no machine has auto-generated");
  });
});
