// Timed announcements: how late a line may still fire is the station's setting (replacing the fixed 120 s), and a
// skipped line shows that it was skipped and why (electron/announce-fire.js; Jeff, 2026-10-26). Plays-in-a-row repeats
// (play_count) are the user's setting and are not touched: they still run from main's _scheduleAnnounceRepeats.
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
const F = require("./announce-fire");

const DATE = "2026-10-17";
const at = (hms) => F.dueEpoch(DATE, hms);
const row = (over = {}) => ({ uuid: "e1", title: "HALLOVEEN 30 MIN", last_played_at: null, skipped_at: null, ...over });
const base = (over = {}) => ({ row: row(), dateStr: DATE, due: "16:02:00", nowSec: at("16:02:00"), lateLimit: null, startedSec: at("12:00:00"), ...over });

describe("how late a line may still fire is the station's setting", () => {
  it("the control: the old rule (exact second) dropped a line whose tick came 2 s late, silently", () => {
    const oldFires = (nowSec) => new Date(nowSec * 1000).toTimeString().slice(0, 8) === "16:02:00";
    expect(oldFires(at("16:02:02"))).toBe(false);
  });

  it("not set: only inside its own second, as Ether always did", () => {
    expect(F.decide(base({ nowSec: at("16:01:59") })).action).toBe("none");
    expect(F.decide(base({ nowSec: at("16:02:00") }))).toEqual({ action: "fire", lateSec: 0 });
    const s = F.decide(base({ nowSec: at("16:02:02") }));
    expect(s.action).toBe("skip");
    expect(s.why).toMatch(/checked 2 s after its time/);
    expect(s.why).toMatch(/late limit is not set/);
  });

  it("set: fires up to that many seconds late; past it, skipped with the limit named", () => {
    expect(F.decide(base({ nowSec: at("16:02:02"), lateLimit: 5 }))).toEqual({ action: "fire", lateSec: 2 });
    expect(F.decide(base({ nowSec: at("16:02:05"), lateLimit: 5 }))).toEqual({ action: "fire", lateSec: 5 });
    const s = F.decide(base({ nowSec: at("16:02:06"), lateLimit: 5 }));
    expect(s).toMatchObject({ action: "skip", lateSec: 6 });
    expect(s.why).toMatch(/the late limit is 5 s/);
  });

  it("a limit longer than the old 120 s still works: a line that fired is not fired again inside its window", () => {
    expect(F.decide(base({ row: row({ last_played_at: at("16:02:00") }), nowSec: at("16:05:00"), lateLimit: 600 })).action).toBe("none");
    // a play from an EARLIER time (another day) is not this time's play
    expect(F.decide(base({ row: row({ last_played_at: at("16:02:00") - 86400 }), lateLimit: 600 })).action).toBe("fire");
  });

  it("a fire the engine refused is tried again while its window is open, as it was inside its second before", async () => {
    const state = F.createTickState(at("12:00:00")); let fires = 0;
    for (let s = 0; s <= 3; s++) await F.processRows({ rows: [row()], dateStr: DATE, judge: true, dueOf: () => "16:02:00", nowSec: at("16:02:00") + s,
      lateLimit: 3, state, fire: async () => { fires++; }, skip: () => {} });
    expect(fires).toBe(4);
  });

  it("a late limit across midnight: yesterday's 23:59:50 line still fires at 00:00:05", () => {
    const d = F.decide({ row: row(), dateStr: "2026-10-17", due: "23:59:50", nowSec: F.dueEpoch("2026-10-18", "00:00:05"), lateLimit: 30, startedSec: at("12:00:00") });
    expect(d).toEqual({ action: "fire", lateSec: 15 });
  });

  it("the stored value: whole seconds 0–3600, anything else is not set (never a guess)", () => {
    expect(F.parseLateLimit("30")).toBe(30);
    expect(F.parseLateLimit("0")).toBe(0);
    for (const v of [null, undefined, "", "abc", "-1", "3601"]) expect(F.parseLateLimit(v)).toBeNull();
    expect(F.LATE_LIMIT_KEY).toBe("announce_late_limit_sec");
  });
});

describe("a skip shows that it was skipped, and why", () => {
  it("Ether was not running yet", () => {
    const s = F.decide(base({ nowSec: at("17:00:00"), startedSec: at("16:30:00"), lateLimit: 10 }));
    expect(s.why).toMatch(/Ether started at 16:30:00, after its time 16:02:00/);
  });
  it("the closing time moved the line into the past", () => {
    const s = F.decide(base({ due: "16:00:00", prevDue: "16:30:00", nowSec: at("16:05:00"), lateLimit: 10 }));
    expect(s.why).toMatch(/closing time moved its time from 16:30:00 to 16:00:00/);
  });
  it("the line reached today's schedule after its time", () => {
    const s = F.decide(base({ nowSec: at("16:10:00"), seenSec: at("16:09:00"), lateLimit: 10 }));
    expect(s.why).toMatch(/reached today's schedule at 16:09:00/);
  });
  it("said once across many ticks, not again once recorded, and yesterday's lines are never re-judged", async () => {
    const state = F.createTickState(at("12:00:00")); const skips = [];
    for (let i = 0; i < 10; i++) await F.processRows({ rows: [row()], dateStr: DATE, judge: true, dueOf: () => "16:02:00", nowSec: at("16:05:00") + i,
      lateLimit: 10, state, fire: async () => { throw new Error("no fire"); }, skip: (_r, due, why) => skips.push(why) });
    expect(skips.length).toBe(1);
    expect(F.decide(base({ row: row({ skipped_at: at("16:05:00") }), nowSec: at("16:06:00"), lateLimit: 10 })).action).toBe("none");
    const y = F.createTickState(at("12:00:00")); const ySkips = [];
    await F.processRows({ rows: [row({ uuid: "y" })], dateStr: DATE, judge: false, dueOf: () => "16:02:00", nowSec: at("16:05:00"),
      lateLimit: 10, state: y, fire: async () => {}, skip: () => ySkips.push(1) });
    expect(ySkips.length).toBe(0);
  });
});

describe("main's tick runs this loop; repeats are untouched; the skip is recorded everywhere", () => {
  const main = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");
  const tick = main.slice(main.indexOf("async function announceTick()"), main.indexOf("// ── PLAYS IN A ROW"));
  it("the tick calls processRows with the station's late limit; the exact-second match and the fixed 120 s are gone", () => {
    expect(tick).toMatch(/AnnounceFire\.processRows\(/);
    expect(tick).toMatch(/lateLimitFor\(stationId\)/);
    expect(tick).not.toMatch(/due !== hhmmss/);
    expect(tick).not.toMatch(/< 120\)/);
  });
  it("plays-in-a-row: a scheduled fire still cancels pending repeats first and schedules the line's repeats after", () => {
    const c = tick.indexOf("_cancelAnnounceRepeats(stationId)"), f = tick.indexOf("await fireAnnouncement("), r = tick.indexOf("_scheduleAnnounceRepeats(stationId, row)");
    expect(c).toBeGreaterThan(0); expect(f).toBeGreaterThan(c); expect(r).toBeGreaterThan(f);
    const rep = main.slice(main.indexOf("function _scheduleAnnounceRepeats"), main.indexOf("function startAnnouncementScheduler"));
    expect(rep).toMatch(/clampPlayCount\(row\.play_count\)/);
    expect(rep).toMatch(/repeatStartsMs\(durSec, count\)/);
  });
  it("a skip goes to ether-startup.log, the health log and the line (skipped_at + the reason on screen)", () => {
    const f = main.slice(main.indexOf("function _noteAnnounceSkipped"), main.indexOf("\n}", main.indexOf("function _noteAnnounceSkipped")));
    expect(f).toMatch(/markSkipped\?\.run\(nowSec, row\.uuid\)/);
    expect(f).toMatch(/_healthEvent\('announcement-skipped'/);
    expect(f).toMatch(/logStartup\('\[announce\] SKIPPED/);
    expect(main).toMatch(/skipped,\n\s+lateLimitSec: lateLimitFor\(sid\)/);
    const ui = fs.readFileSync(path.join(__dirname, "..", "src", "components", "Announcements.tsx"), "utf8");
    expect(ui).toMatch(/st\.skipped\[e\.uuid\]\.reason/);
    expect(ui).toMatch(/"announce_late_limit_sec"/);
    expect(ui).not.toMatch(/> 120\) status/);
  });
  it("saving the late limit takes effect on the next tick", () => {
    const kv = fs.readFileSync(path.join(__dirname, "sync", "handlers", "station_config_kv.js"), "utf8");
    expect(kv).toMatch(/key === 'closing_time' \|\| key === 'announce_late_limit_sec'/);
  });
});
