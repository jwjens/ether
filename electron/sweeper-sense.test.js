// fix 15 (docs/held-items-proposals-2026-09-27.md; Jeff's GO 2026-09-27): no sweeper sense in the Health Monitor.
// Now a SWEEPERS row per station — placed / fired / skipped today (with reasons) and the live state — and a level:
// RED ONLY when sweepers are assigned and none fired in the last hour of AIR (not wall time: the last 3,600 s of the
// station's own audio in play_log, however long ago that stretch began). The overlay sweepers themselves are not air
// time — they play on top of music.
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
const S = require("./sweeper-sense");

const ALWAYS = 16777215;
// A local hour → a unix time on a fixed local day, so hour masks can be checked.
const at = (h, m = 0) => Math.floor(new Date(2026, 8, 27, h, m, 0).getTime() / 1000);
const play = (t, sec, cls = "MUSIC") => ({ played_at: t, duration_ms: sec * 1000, content_class: cls });

describe("the last hour of AIR (audit 15)", () => {
  it("sums the station's own audio backwards until an hour is reached — wall time is irrelevant", () => {
    // 20 songs of 4 min, newest first, with an 8-hour gap in the middle (station off overnight)
    const plays = [];
    for (let i = 0; i < 10; i++) plays.push(play(at(9, 40) - i * 240, 240));
    for (let i = 0; i < 10; i++) plays.push(play(at(0, 40) - i * 240, 240));
    const w = S.airWindow(plays);
    expect(w.airSec).toBeGreaterThanOrEqual(3600);
    expect(w.start).toBe(at(0, 40) - 4 * 240);       // 15 songs × 4 min = the hour — reached back across the gap
    expect(w.hours.sort()).toEqual([0, 9]);
  });
  it("overlay sweepers are not air time; less than an hour aired → no window", () => {
    expect(S.airWindow([play(at(9), 3000), play(at(9, 1), 30, "SWP"), play(at(9, 2), 30, "JIN")])).toBeNull();
  });
});

describe("the level (audit 15)", () => {
  const w = { start: at(8), airSec: 3700, hours: [8, 9] };
  it("RED only when assigned for the aired hours, an hour has aired, and none fired in it", () => {
    expect(S.senseLevel({ assignedMask: ALWAYS, window: w, firedInWindow: 0 }).level).toBe("red");
    expect(S.senseLevel({ assignedMask: ALWAYS, window: w, firedInWindow: 2 }).level).toBe("green");
  });
  it("grey — not red — with nothing assigned, under an hour of air, or no assignment covering the hours that aired", () => {
    expect(S.senseLevel({ assignedMask: 0, window: w, firedInWindow: 0 }).level).toBe("grey");
    expect(S.senseLevel({ assignedMask: ALWAYS, window: null, firedInWindow: 0 }).level).toBe("grey");
    const nightsOnly = (1 << 0) | (1 << 1) | (1 << 2);
    expect(S.senseLevel({ assignedMask: nightsOnly, window: w, firedInWindow: 0 }).level).toBe("grey");
  });
});

describe("placement skips are counted, per day, never silently (audit 15)", () => {
  it("tallies merge per date and keep only the last 7 days", () => {
    let log = {};
    log = S.mergePlacementLog(log, { "2026-09-27": { placed: 10, off_hours: 2, no_fit: 1, no_file: 0 } });
    log = S.mergePlacementLog(log, { "2026-09-27": { placed: 3, off_hours: 0, no_fit: 0, no_file: 1 } });
    expect(log["2026-09-27"]).toEqual({ placed: 13, off_hours: 2, no_fit: 1, no_file: 1 });
    for (let d = 10; d < 20; d++) log = S.mergePlacementLog(log, { [`2026-10-${d}`]: { placed: 1, off_hours: 0, no_fit: 0, no_file: 0 } });
    expect(Object.keys(log).length).toBe(7);
  });
});

describe("the wiring (audit 15)", () => {
  const main = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");
  const lh = fs.readFileSync(path.join(__dirname, "library-health.js"), "utf8");
  it("placement records its skips instead of dropping them", () => {
    const start = main.indexOf("function _placeJingles(");
    const place = main.slice(start, main.indexOf("\n}\n", start));
    for (const why of ["off_hours", "no_fit", "no_file"]) expect(place, why).toMatch(new RegExp(`skip\\('${why}'`));
    expect(place).toMatch(/recordPlacement\(db, stationId,/);
  });
  it("every station's health record carries the sense, and its colour counts toward the station's", () => {
    expect(lh).toMatch(/sweepers: sweepers/);
    expect(lh).toMatch(/sweepers\.level/);
    expect(lh).toMatch(/'sweepers-not-firing'/);
  });
  it("the Health Monitor shows a Sweepers row beside Runway", () => {
    const hm = fs.readFileSync(path.join(__dirname, "..", "src", "components", "HealthMonitor.tsx"), "utf8");
    expect(hm).toMatch(/label="Sweepers"/);
  });
});
