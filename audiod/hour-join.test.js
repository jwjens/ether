// ── The log plays as built; the hour and the show schedule are the boundaries (Jeff, 2026-10-18) ─────────────────────
//
//   "The show schedule is the boundary: a show that ends at 1:30 automates until 1:30. Shows start and end at any
//    minute. The log plays what the programmer built. No built-in fill, no catch-up drops."
//   "but the last song of the hour should always finish no hard stop"
//   Later the same day (replacing "it should be silent after that"):
//   "The log plays in order. When a song crosses the top of the hour, it plays out and the next hour's first row
//    follows. Rows of the old hour that didn't get to air are marked didn't-air, never deleted."
//   "Inside a show, the log never waits for :00. When a row ends, the next row plays: the rest of this hour, then the
//    next hour's first row. 'Never run ahead' only means: never play rows from outside the show schedule, never jump
//    past the show's end, never pull rows from another day."
//   "A row added by hand is NEVER removed by anything automatic."
//
// Drives the REAL loggen.readLogAnchored against an in-memory SQLite with the clock pinned. The engine tells the reader
// which log row is on air (opts.onAirRowId); null = nothing of the log is on air (automation just started).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";

const require_ = createRequire(import.meta.url);
const loggen = require_("./loggen.js");
const SW = require_("./show-window.js");

let db;
const at = (h, m, s = 0) => Math.floor(new Date(2026, 9, 4, h, m, s).getTime() / 1000);
const setNow = (h, m, s = 0) => vi.setSystemTime(new Date(2026, 9, 4, h, m, s));
// opts.hour: the log hour the row belongs to (v66 log_hour_ts — Generate writes it on every row); omitted = NULL, a row
// written before v66, which belongs to the hour of its own time. opts.source 'operator' = added by hand.
function row(id, ts, opts = {}) {
  db.prepare(`INSERT INTO generated_schedule (id,scheduled_at,song_id,title,file_path,station_id,state,played_at,content_class,duration_s,source,log_hour_ts)
              VALUES (?,?,?,?,?,1,?,?,?,?,?,?)`)
    .run(id, ts, opts.cls === "SPOT" ? null : (opts.songId ?? 1), opts.title || ("row " + id), "r" + id + ".mp3",
      opts.state || "pending", opts.playedAt ?? null, opts.cls || "MUSIC", opts.dur ?? 200, opts.source ?? null, opts.hour ?? null);
}
const ids = (r) => r.items.map(i => i.schedId);
const read = (onAirRowId, seam) => loggen.readLogAnchored(db, 1, 20, undefined, { onAirRowId, ...(seam ? { seamTs: seam } : {}) });
function shows(list) {
  db.exec("DELETE FROM shows");
  for (const [id, sh, sm, eh, em] of list)
    db.prepare("INSERT INTO shows (id,station_id,clock_id,is_active,days,start_hour,start_minute,end_hour,end_minute,name) VALUES (?,1,1,1,'0123456',?,?,?,?,?)").run(id, sh, sm, eh, em, "show " + id);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE stations (id INTEGER PRIMARY KEY, scheduler_mode TEXT);
    CREATE TABLE categories (id INTEGER PRIMARY KEY, station_id INTEGER, deleted_at TEXT);
    CREATE TABLE artists (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE songs (id INTEGER PRIMARY KEY, title TEXT, artist_id INTEGER, category_id INTEGER, file_path TEXT,
      file_key TEXT, duration_ms INTEGER, intro_end REAL, outro_start REAL, rotation_status TEXT, content_class TEXT,
      daypart_mask INTEGER, deleted_at TEXT);
    CREATE TABLE clock_slots (id INTEGER PRIMARY KEY, clock_id INTEGER, station_id INTEGER, slot_type TEXT,
      category_id INTEGER, position INTEGER, deleted_at TEXT);
    CREATE TABLE shows (id INTEGER PRIMARY KEY, station_id INTEGER, clock_id INTEGER, is_active INTEGER, days TEXT, name TEXT,
      start_hour INTEGER, end_hour INTEGER, start_minute INTEGER NOT NULL DEFAULT 0, end_minute INTEGER NOT NULL DEFAULT 0, deleted_at TEXT);
    CREATE TABLE generated_schedule (id INTEGER PRIMARY KEY, scheduled_at INTEGER, song_id INTEGER, title TEXT,
      artist TEXT, file_path TEXT, file_key TEXT, duration_s INTEGER, station_id INTEGER, state TEXT DEFAULT 'pending',
      played_at INTEGER, content_class TEXT, category_id INTEGER, deleted_at TEXT, source TEXT, log_hour_ts INTEGER);
    INSERT INTO stations (id, scheduler_mode) VALUES (1, 'clock');
    INSERT INTO categories (id, station_id) VALUES (1, 1);
    INSERT INTO clock_slots (id,clock_id,station_id,slot_type,category_id,position) VALUES (1,1,1,'music',1,0);
    INSERT INTO songs (id,title,category_id,file_path,duration_ms,content_class) VALUES (1,'Song',1,'s.mp3',210000,'MUSIC');
  `);
  shows([[1, 0, 0, 0, 0]]);   // one all-day show unless a test says otherwise
});
afterEach(() => { vi.useRealTimers(); try { db.close(); } catch {} });

// The 12:00 hour's last song is scheduled 12:58 and runs past :00. The 13:00 hour opens with an ID and a spot.
function crossingHour() {
  row(1, at(12, 54), { state: "played", playedAt: at(12, 54) });
  row(2, at(12, 58), { state: "playing", playedAt: at(12, 58), dur: 240 });
  row(10, at(13, 0, 0), { title: "Legal ID" });
  row(11, at(13, 0, 10), { title: "Top spot", cls: "SPOT" });
  row(12, at(13, 0, 40), { title: "First song of 13:00" });
  row(13, at(13, 4, 10), { title: "Second song of 13:00" });
}

describe("the last song of the hour always finishes; the new hour opens with its first row", () => {
  it("the crossing song is on air at 13:02: the new hour's FIRST row is next, then the hour in order", () => {
    crossingHour(); setNow(13, 2, 0);
    const r = read(2);
    expect(ids(r).slice(0, 4)).toEqual([10, 11, 12, 13]);
    expect(r.missedRowIds).toEqual([]);
  });
  it("the hour's last song ends BEFORE :00 (overlays): the next hour's first row plays straight on — no silence", () => {
    crossingHour(); setNow(12, 59, 0);
    const r = read(2, at(12, 59, 20));                     // the song on air ends at 12:59:20
    expect(ids(r).slice(0, 4)).toEqual([10, 11, 12, 13]);
    expect(r.mode).not.toBe("nothing-due");
    expect(r.missedRowIds).toEqual([]);
  });
  it("at the top of the hour the first row of the hour is offered", () => {
    crossingHour(); setNow(13, 0, 0);
    expect(ids(read(2, at(13, 0, 0)))[0]).toBe(10);
  });
});

describe("no catch-up drops: a late hour plays every row in order", () => {
  it("mid-hour, 10 minutes behind: the next row after the one on air, nothing missed", () => {
    row(20, at(13, 20), { state: "playing", playedAt: at(13, 24) });
    row(21, at(13, 24)); row(22, at(13, 27)); row(23, at(13, 40));
    setNow(13, 30, 0);
    const r = read(20);
    expect(ids(r).slice(0, 3)).toEqual([21, 22, 23]);
    expect(r.missedRowIds).toEqual([]);
  });
});

describe("the top of the hour ends the hour: the song playing at :00 is the hour's last", () => {
  it("running late: the 12:56 song is on air at :00 and ends 13:01 — the 12:59 row never starts, the 13:00 head is next", () => {
    row(70, at(12, 56), { state: "playing", playedAt: at(12, 57) });
    row(71, at(12, 59), { title: "old hour, not started by :00" });
    row(80, at(13, 0), { title: "13:00 head" }); row(81, at(13, 3));
    setNow(13, 0, 30);
    const r = read(70, at(13, 1, 0));
    expect(ids(r).slice(0, 2)).toEqual([80, 81]);
    expect(r.missedRowIds).toEqual([71]);
  });
  it("…but a row of the old hour that starts before :00 plays, and finishes", () => {
    row(70, at(12, 56), { state: "playing", playedAt: at(12, 56) });
    row(71, at(12, 59));
    row(80, at(13, 0));
    setNow(12, 59, 0);
    expect(ids(read(70, at(12, 59, 30)))[0]).toBe(71);
  });
});

describe("automation started with nothing of the log on air", () => {
  it("starts at the row for now inside the show that is on; the rows that passed while it was off are retired", () => {
    row(21, at(13, 24)); row(22, at(13, 27)); row(23, at(13, 40));
    setNow(13, 30, 0);
    const r = read(null);
    expect(ids(r)[0]).toBe(22);
    expect(r.missedRowIds).toEqual([21]);
  });
  it("a stale 'playing' row from hours ago is not taken as on air", () => {
    row(30, at(9, 58), { state: "playing", playedAt: at(9, 58) });
    row(31, at(13, 0)); row(32, at(13, 30)); row(33, at(13, 45));
    setNow(13, 40, 0);
    expect(ids(loggen.readLogAnchored(db, 1, 20))[0]).toBe(32);
  });
  it("started before the show: waits for the show's first row", () => {
    shows([[1, 15, 0, 22, 0]]);
    row(40, at(15, 0)); row(41, at(15, 4));
    setNow(12, 25, 0);
    const r = read(null);
    expect(ids(r)).toEqual([]);
    expect(r.inShow).toBe(false);
    expect(r.nextDueTs).toBe(at(15, 0));
  });
});

describe("the show schedule is the boundary — shows start and end at any minute", () => {
  beforeEach(() => shows([[1, 12, 0, 13, 30], [2, 13, 30, 15, 0]]));   // A 12:00–13:30, B 13:30–15:00
  it("A's last song ends at 13:25: silence until 13:30, then B's first row", () => {
    row(50, at(13, 21), { state: "playing", playedAt: at(13, 21) });
    row(60, at(13, 30), { title: "B first" }); row(61, at(13, 34));
    setNow(13, 24, 0);
    const r = read(50, at(13, 25, 0));
    expect(ids(r)).toEqual([]);
    expect(r.nextDueTs).toBe(at(13, 30));
    setNow(13, 30, 0);
    expect(ids(read(50, at(13, 30, 0)))[0]).toBe(60);
  });
  it("A's last song crosses 13:30: it finishes, B's first row is next", () => {
    row(50, at(13, 27), { state: "playing", playedAt: at(13, 27) });
    row(60, at(13, 30), { title: "B first" });
    setNow(13, 29, 0);
    expect(ids(read(50, at(13, 31, 0)))[0]).toBe(60);
  });
  it("started at 13:45 with A's rows still pending: A has ended, so B's row for now — never A after 13:30", () => {
    row(51, at(13, 25)); row(52, at(13, 29));          // A, never aired
    row(60, at(13, 30)); row(61, at(13, 42)); row(62, at(13, 50));
    setNow(13, 45, 0);
    const r = read(null);
    expect(ids(r)[0]).toBe(61);
    expect(ids(r)).not.toContain(51);
    expect(ids(r)).not.toContain(52);
  });
  it("A ends 13:30 with no show after it: once its rows are done nothing is due and no show is on", () => {
    shows([[1, 12, 0, 13, 30]]);
    row(50, at(13, 27), { state: "playing", playedAt: at(13, 27) });
    setNow(13, 31, 0);
    const r = read(50, at(13, 31, 0));
    expect(ids(r)).toEqual([]);
    expect(r.inShow).toBe(false);
  });
});

describe("every clock row is placed: an hour's extra rows past :00 stay in their own hour (v66 log_hour_ts)", () => {
  // The 12:00 hour: a song on air from 12:50, then the clock's extra rows timed past :00 (12:59, 13:02, 13:05), all of
  // the 12:00 hour. The 13:00 hour opens at 13:00 with its own head.
  function extraRows() {
    row(1, at(12, 50), { state: "playing", playedAt: at(12, 50), hour: at(12, 0) });
    row(2, at(12, 54), { hour: at(12, 0), title: "12 · fits" });
    row(3, at(12, 58), { hour: at(12, 0), title: "12 · extra 1" });
    row(4, at(13, 2), { hour: at(12, 0), title: "12 · extra 2" });
    row(5, at(13, 6), { hour: at(12, 0), title: "12 · extra 3" });
    row(10, at(13, 0), { hour: at(13, 0), title: "13 · head" });
    row(11, at(13, 4), { hour: at(13, 0), title: "13 · second" });
  }
  it("Up Next is in LOG order: the 12:00 hour's extra rows (timed 13:02, 13:06) come before the 13:00 head", () => {
    extraRows(); setNow(12, 52, 0);
    expect(ids(read(1, at(12, 54, 0)))).toEqual([2, 3, 4, 5, 10, 11]);
  });
  it("the hour ran short (overlays): an extra row of the SAME hour plays before :00 — the rows the PD built", () => {
    extraRows(); db.prepare("UPDATE generated_schedule SET state='played' WHERE id IN (1)").run();
    db.prepare("UPDATE generated_schedule SET state='playing', played_at=? WHERE id=2").run(at(12, 53));
    setNow(12, 55, 0);
    expect(ids(read(2, at(12, 56, 30)))[0]).toBe(3);        // "12 · extra 1" starts 12:56:30, inside its hour
  });
  it("a song crosses :00: it plays out; the 12:00 hour's rows that did not start are didn't-air; the 13:00 head is next", () => {
    extraRows();
    db.prepare("UPDATE generated_schedule SET state='played' WHERE id IN (1,2)").run();
    db.prepare("UPDATE generated_schedule SET state='playing', played_at=? WHERE id=3").run(at(12, 57));
    setNow(13, 0, 30);
    const r = read(3, at(13, 1, 0));                        // "12 · extra 1" ends 13:01
    expect(ids(r).slice(0, 2)).toEqual([10, 11]);
    expect(r.missedRowIds).toEqual([4, 5]);                 // stamped 'missed' (didn't air) — never deleted
  });
  it("the 12:00 hour's rows run out at 12:57 (every extra row aired): the 13:00 head plays at once, no silence", () => {
    extraRows();
    db.prepare("UPDATE generated_schedule SET state='played' WHERE id IN (1,2,3,4)").run();
    db.prepare("UPDATE generated_schedule SET state='playing', played_at=? WHERE id=5").run(at(12, 54));
    setNow(12, 56, 0);
    const r = read(5, at(12, 57, 0));
    expect(ids(r)[0]).toBe(10);
    expect(r.mode).not.toBe("nothing-due");
  });
});

describe("a row added by hand is never removed by anything automatic", () => {
  it("added after the hour's last row: when the last song crosses :00 the hand-added row still plays, then the 13:00 head", () => {
    row(1, at(12, 56), { state: "playing", playedAt: at(12, 57), hour: at(12, 0) });
    row(2, at(12, 59), { hour: at(12, 0), title: "12 · machine row" });
    row(3, at(12, 59, 1), { hour: at(12, 0), title: "added by hand", source: "operator" });
    row(10, at(13, 0), { hour: at(13, 0), title: "13 · head" });
    setNow(13, 0, 30);
    const r = read(1, at(13, 1, 0));
    expect(ids(r).slice(0, 2)).toEqual([3, 10]);
    expect(r.missedRowIds).toEqual([2]);                    // the machine row did not air; the hand-added row is not 'missed'
  });
  it("is never in the missed sweep, even when automation starts after its time", () => {
    row(21, at(13, 24), { source: "operator", title: "added by hand" }); row(22, at(13, 27)); row(23, at(13, 40));
    setNow(13, 30, 0);
    const r = read(null);
    expect(r.missedRowIds).not.toContain(21);
  });
  it("passes the format gate: a song from a category on no clock still plays when the operator added it", () => {
    db.exec("INSERT INTO songs (id,title,category_id,file_path,duration_ms,content_class) VALUES (2,'Off clock',2,'o.mp3',200000,'MUSIC')");
    row(1, at(12, 50), { state: "playing", playedAt: at(12, 50), hour: at(12, 0) });
    row(2, at(12, 50, 1), { hour: at(12, 0), songId: 2, title: "machine row, off clock" });
    row(3, at(12, 50, 2), { hour: at(12, 0), songId: 2, title: "added by hand, off clock", source: "operator" });
    setNow(12, 52, 0);
    expect(ids(read(1, at(12, 53, 0)))).toEqual([3]);
  });
});

describe("never run ahead = never outside the show schedule, never past the show's end, never another day", () => {
  it("a show's last row ends and nothing plays after the show — not even the last hour's extra rows", () => {
    shows([[1, 12, 0, 13, 0]]);                             // one show, 12:00–13:00, nothing after it
    row(1, at(12, 57), { state: "playing", playedAt: at(12, 57), hour: at(12, 0), dur: 240 });
    row(2, at(13, 1), { hour: at(12, 0), title: "12 · extra row past :00" });
    setNow(13, 0, 30);
    const r = read(1, at(13, 1, 0));                        // the crossing song ends 13:01
    expect(ids(r)).toEqual([]);
    expect(r.mode).toBe("nothing-due");
    expect(r.inShow).toBe(false);                           // → AUTO turns off once the deck is quiet (engine)
  });
  it("the show's rows run out before its end: the next SHOW's row waits for that show's start", () => {
    shows([[1, 12, 0, 13, 0], [2, 13, 0, 14, 0]]);           // two different shows back to back
    row(1, at(12, 53), { state: "playing", playedAt: at(12, 53), hour: at(12, 0) });
    row(10, at(13, 0), { hour: at(13, 0), title: "show 2 head" });
    setNow(12, 56, 0);
    const r = read(1, at(12, 57, 0));
    expect(ids(r)).toEqual([]);
    expect(r.nextDueTs).toBe(at(13, 0));
  });
  it("never pulls rows from another day: the 23:00 hour runs out at 23:57, tomorrow's 00:00 row waits for midnight", () => {
    const tomorrow = (h, m) => Math.floor(new Date(2026, 9, 5, h, m).getTime() / 1000);
    row(1, at(23, 53), { state: "playing", playedAt: at(23, 53), hour: at(23, 0) });
    row(10, tomorrow(0, 0), { hour: tomorrow(0, 0), title: "tomorrow 00:00" });
    setNow(23, 56, 0);
    const r = read(1, at(23, 57, 0));
    expect(ids(r)).toEqual([]);
    expect(r.nextDueTs).toBe(tomorrow(0, 0));
  });
});

describe("show-window: which show owns a minute", () => {
  const S = [{ id: 1, days: "0123456", start_hour: 12, start_minute: 0, end_hour: 13, end_minute: 30 },
             { id: 2, days: "0123456", start_hour: 13, start_minute: 30, end_hour: 0, end_minute: 0 }];
  it("the hour 13:00 is cut at 13:30", () => {
    const segs = SW.hourSegments(S, at(13, 0));
    expect(segs.map(x => [x.fromTs, x.toTs, x.show && x.show.id])).toEqual([[at(13, 0), at(13, 30), 1], [at(13, 30), at(14, 0), 2]]);
  });
  it("a show with no minutes keeps its whole hours (pre-v65 rows)", () => {
    const old = [{ id: 3, days: "0123456", start_hour: 15, end_hour: 22 }];
    expect(SW.showAt(old, at(14, 59))).toBe(null);
    expect(SW.showAt(old, at(15, 0)).id).toBe(3);
    expect(SW.showAt(old, at(21, 59)).id).toBe(3);
    expect(SW.showAt(old, at(22, 0))).toBe(null);
  });
  it("overnight and all-day conventions are Generate's", () => {
    expect(SW.showAt([{ id: 4, days: "0123456", start_hour: 22, end_hour: 2 }], at(1, 0)).id).toBe(4);
    expect(SW.showAt([{ id: 5, days: "0123456", start_hour: 0, end_hour: 0 }], at(9, 0)).id).toBe(5);
  });
});
