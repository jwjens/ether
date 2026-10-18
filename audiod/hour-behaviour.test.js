// ── What an hour does is the PD's setting (late_hour_mode / short_hour_mode, 2026-10-18) ─────────────────────────────
// Drives the REAL loggen.readLogAnchored / fillShortHour against an in-memory SQLite with the clock pinned. Test rows
// only. UNSET must behave exactly as before (catch_up / fill).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";

const require_ = createRequire(import.meta.url);
const loggen = require_("./loggen.js");

let db;
const at = (h, m, s = 0) => Math.floor(new Date(2026, 10, 2, h, m, s).getTime() / 1000);
const setNow = (h, m, s = 0) => vi.setSystemTime(new Date(2026, 10, 2, h, m, s));
function row(id, ts, opts = {}) {
  db.prepare(`INSERT INTO generated_schedule (id,scheduled_at,song_id,title,file_path,station_id,state,played_at,content_class)
              VALUES (?,?,?,?,?,1,?,?,?)`)
    .run(id, ts, opts.cls === "SPOT" ? null : 1, opts.title || ("row " + id), "r" + id + ".mp3", opts.state || "pending", opts.playedAt ?? null, opts.cls || "MUSIC");
}
const set = (k, v) => db.prepare("INSERT INTO station_config_kv (station_id, key, value) VALUES (1, ?, ?)").run(k, v);
const ids = (r) => r.items.map(i => i.schedId);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE stations (id INTEGER PRIMARY KEY, scheduler_mode TEXT);
    CREATE TABLE categories (id INTEGER PRIMARY KEY, station_id INTEGER, deleted_at TEXT);
    CREATE TABLE artists (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE songs (id INTEGER PRIMARY KEY, title TEXT, artist_id INTEGER, category_id INTEGER, file_path TEXT,
      file_key TEXT, duration_ms INTEGER, intro_end REAL, outro_start REAL, rotation_status TEXT, content_class TEXT,
      daypart_mask INTEGER, no_repeat_hours REAL, deleted_at TEXT);
    CREATE TABLE clock_slots (id INTEGER PRIMARY KEY, clock_id INTEGER, station_id INTEGER, slot_type TEXT,
      category_id INTEGER, position INTEGER, deleted_at TEXT);
    CREATE TABLE shows (id INTEGER PRIMARY KEY, station_id INTEGER, clock_id INTEGER, is_active INTEGER, days TEXT,
      start_hour INTEGER, end_hour INTEGER, deleted_at TEXT);
    CREATE TABLE station_config_kv (id INTEGER PRIMARY KEY, station_id INTEGER, key TEXT, value TEXT, deleted_at TEXT);
    CREATE TABLE separation_rules (id INTEGER PRIMARY KEY, station_id INTEGER, rule_type TEXT, value INTEGER, is_active INTEGER, deleted_at TEXT);
    CREATE TABLE play_log (id INTEGER PRIMARY KEY, station_id INTEGER, file_path TEXT, title TEXT, artist TEXT, played_at INTEGER, content_class TEXT, deleted_at TEXT);
    CREATE TABLE generated_schedule (id INTEGER PRIMARY KEY, scheduled_at INTEGER, song_id INTEGER, title TEXT,
      artist TEXT, file_path TEXT, file_key TEXT, duration_s INTEGER, station_id INTEGER, state TEXT DEFAULT 'pending',
      played_at INTEGER, content_class TEXT, category_id INTEGER, clock_id INTEGER, uuid TEXT, source TEXT, pick_reason TEXT,
      created_at TEXT, updated_at TEXT, generated_at INTEGER, deleted_at TEXT);
    INSERT INTO stations (id, scheduler_mode) VALUES (1, 'clock');
    INSERT INTO categories (id, station_id) VALUES (1, 1);
    INSERT INTO clock_slots (id,clock_id,station_id,slot_type,category_id,position) VALUES (1,1,1,'music',1,0);
    INSERT INTO shows (id,station_id,clock_id,is_active,days,start_hour,end_hour) VALUES (1,1,1,1,'0123456',0,0);
    INSERT INTO songs (id,title,category_id,file_path,duration_ms,content_class,daypart_mask) VALUES (1,'Song',1,'s.mp3',210000,'MUSIC',16777215);
  `);
});
afterEach(() => { vi.useRealTimers(); try { db.close(); } catch {} });

// Mid-hour, 4 minutes late: 2:00 aired on time, the 2:20 song went live at 2:24; it is now 2:28:30 — a song at 2:24,
// a spot at 2:26, songs at 2:27 and 2:31.
function lateHour() {
  row(9, at(2, 0), { state: "played", playedAt: at(2, 0) });
  row(10, at(2, 20), { state: "playing", playedAt: at(2, 24) });
  row(11, at(2, 24), { title: "song 2:24" });
  row(12, at(2, 26), { title: "spot 2:26", cls: "SPOT" });
  row(13, at(2, 27), { title: "song 2:27" });
  row(14, at(2, 31), { title: "song 2:31" });
  setNow(2, 28, 30);
}

describe("late_hour_mode", () => {
  it("UNSET = catch_up, as before: the passed rows are missed and the log jumps to the row for now", () => {
    lateHour();
    const r = loggen.readLogAnchored(db, 1, 20);
    expect(ids(r)[0]).toBe(13);
    expect(r.missedRowIds).toEqual([11, 12]);
    expect(loggen.hourBehaviour(db, 1)).toMatchObject({ late: null, lateEffective: "catch_up" });
  });
  it("catch_up set explicitly is the same", () => {
    lateHour(); set("late_hour_mode", "catch_up");
    const r = loggen.readLogAnchored(db, 1, 20);
    expect(ids(r)[0]).toBe(13); expect(r.missedRowIds).toEqual([11, 12]);
  });
  it("keep_spots: the passed song is missed, the passed SPOT still plays first, then the row for now", () => {
    lateHour(); set("late_hour_mode", "keep_spots");
    const r = loggen.readLogAnchored(db, 1, 20);
    expect(ids(r).slice(0, 3)).toEqual([12, 13, 14]);
    expect(r.missedRowIds).toEqual([11]);
  });
  it("keep_spots never replays a spot from before the last row that aired", () => {
    row(5, at(2, 10), { title: "old spot", cls: "SPOT" });   // pending, before the 2:20 row which aired
    lateHour(); set("late_hour_mode", "keep_spots");
    const r = loggen.readLogAnchored(db, 1, 20);
    expect(ids(r)).not.toContain(5);
    expect(r.missedRowIds).toContain(5);
  });
  it("play_all: nothing is passed over — every row plays in order after the last one that aired", () => {
    lateHour(); set("late_hour_mode", "play_all");
    const r = loggen.readLogAnchored(db, 1, 20);
    expect(ids(r).slice(0, 4)).toEqual([11, 12, 13, 14]);
    expect(r.missedRowIds).toEqual([]);
  });
  it("play_all before anything aired today (automation started late): the row for now, as before", () => {
    row(21, at(2, 0)); row(22, at(2, 4)); row(23, at(2, 7));
    setNow(2, 8, 0); set("late_hour_mode", "play_all");
    const r = loggen.readLogAnchored(db, 1, 20);
    expect(ids(r)[0]).toBe(23);
  });
  it("an unknown value is ignored (unset)", () => {
    lateHour(); set("late_hour_mode", "whatever");
    expect(loggen.hourBehaviour(db, 1).late).toBe(null);
    expect(ids(loggen.readLogAnchored(db, 1, 20))[0]).toBe(13);
  });
});

describe("short_hour_mode", () => {
  // Nothing of the 2 AM hour is left at 2:59:20.
  it("UNSET = fill, as before: a song from the hour's own clock is written to the log", () => {
    const f = loggen.fillShortHour(db, 1, at(2, 59, 20));
    expect(f.rowId).toBeTruthy();
    expect(db.prepare("SELECT source FROM generated_schedule WHERE id=?").get(f.rowId).source).toBe("fill");
    expect(loggen.hourBehaviour(db, 1)).toMatchObject({ short: null, shortEffective: "fill" });
  });
  it("silence: nothing is added to the log; the station waits for the next row", () => {
    set("short_hour_mode", "silence");
    const f = loggen.fillShortHour(db, 1, at(2, 59, 20));
    expect(f).toMatchObject({ rowId: null, reason: "silence-by-setting", retryAt: at(3, 0) });
    expect(db.prepare("SELECT count(*) n FROM generated_schedule").get().n).toBe(0);
  });
  it("silence does not stop a refused slot's own re-pick", () => {
    set("short_hour_mode", "silence");
    const f = loggen.fillShortHour(db, 1, at(2, 30), { categoryId: 1 });
    expect(f.rowId).toBeTruthy();
  });
});
