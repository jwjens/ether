// ── Source contract: there is NO top-of-hour hard cut (Jeff's ruling, 2026-10-04) ───────────────────
//
// "Take out the top-of-hour hard cut." At :00 nothing stops decks A/B/C and nothing clears the queue;
// the song crossing the hour plays to its end and the new hour joins after it (loggen.readLogAnchored,
// pinned behaviourally in audiod/hour-join.test.js and audiod/smoke-hour-rollover.js).
//
// engine.js loads the native addon at require time, so vitest cannot import it. Like the other
// engine contracts, this reads the source and asserts the wiring — a cut re-added by a future refactor
// fails here.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const engine = readFileSync(join(ROOT, "audiod", "engine.js"), "utf8");
const loggen = readFileSync(join(ROOT, "audiod", "loggen.js"), "utf8");
const showClock = readFileSync(join(ROOT, "src", "audio", "showClock.ts"), "utf8");

const pollBody = engine.slice(engine.indexOf("  poll() {"), engine.indexOf("_computeEngineState() {"));

describe("the daemon has no top-of-hour hard cut", () => {
  it("poll() no longer runs an hour-rollover check", () => {
    expect(pollBody.length).toBeGreaterThan(500);
    expect(pollBody).not.toMatch(/_checkTopOfHour/);
  });

  it("the cut and its hour bookkeeping are gone", () => {
    expect(engine).not.toMatch(/_hardCutTopOfHour/);
    expect(engine).not.toMatch(/_checkTopOfHour/);
    expect(engine).not.toMatch(/_lastHourCut/);
    expect(engine).not.toMatch(/HARD CUT/);
  });

  it("nothing emits a top-of-hour queue replacement", () => {
    expect(engine).not.toMatch(/source:\s*"top-of-hour"/);
    expect(engine).not.toMatch(/_advance\("top-of-hour"/);
  });

  it("the hour-boundary re-read that ignored row state is gone from loggen", () => {
    expect(loggen).not.toMatch(/function fillFromHour/);
  });

  it("the anchored reader routes its choice through the hour-join rule", () => {
    const sel = loggen.slice(loggen.indexOf("function selectRowForNow"), loggen.indexOf("function readLogAnchored"));
    expect(sel).toMatch(/hourJoin\.joinWindow\(/);
  });
});

describe("the renderer's dead show-transition cut is gone too", () => {
  it("showClock.ts no longer stops decks or clears the queue", () => {
    expect(showClock).not.toMatch(/watchShowTransitions/);
    expect(showClock).not.toMatch(/clearQueue\(\)/);
    expect(showClock).not.toMatch(/getDeck\("A"\)\?\.stop\(\)/);
  });
});
