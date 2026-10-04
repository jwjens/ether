// ── The new hour JOINS after the song that crosses it (top-of-hour hard cut removed, 2026-10-04) ────
//
// Jeff's ruling: take the top-of-hour hard cut out. Decks A/B/C are not stopped and the queue is not
// cleared at :00. A song that crosses the hour keeps playing to its end, and the new hour joins after
// it — its first element plays NEXT, nothing of it is skipped or stamped `missed` because the old
// song ran over.
//
// The hard cut used to be what got the new hour on air: it re-read the log from hourStartTs
// (loggen.fillFromHour, which ignores row state) and so masked a real defect in the time-anchored
// reader. readLogAnchored picks the LATEST pending row whose slot has arrived (now + 60s slack) and
// stamps every earlier pending row of the day `missed`. A 12:58 song that runs to 13:02 therefore
// made the reader skip straight past the 13:00:00 legal ID and the 13:00:10 spot to the 13:00:40
// song — the ID and the spot were stamped `missed` while the old song was still on air.
//
// These tests drive the REAL loggen.readLogAnchored against an in-memory SQLite with the clock pinned.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";

const require_ = createRequire(import.meta.url);
const loggen = require_("./loggen.js");

let db;
// Local wall-clock time today (the reader is local-time, like the station).
const at = (h, m, s = 0) => Math.floor(new Date(2026, 9, 4, h, m, s).getTime() / 1000);
const setNow = (h, m, s = 0) => vi.setSystemTime(new Date(2026, 9, 4, h, m, s));

function row(id, ts, opts = {}) {
  db.prepare(`INSERT INTO generated_schedule (id,scheduled_at,song_id,title,file_path,station_id,state,played_at,content_class)
              VALUES (?,?,?,?,?,1,?,?,?)`)
    .run(id, ts, opts.cls === "SPOT" ? null : 1, opts.title || ("row " + id), "r" + id + ".mp3",
      opts.state || "pending", opts.playedAt ?? null, opts.cls || "MUSIC");
}
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
      daypart_mask INTEGER, deleted_at TEXT);
    CREATE TABLE clock_slots (id INTEGER PRIMARY KEY, clock_id INTEGER, station_id INTEGER, slot_type TEXT,
      category_id INTEGER, position INTEGER, deleted_at TEXT);
    CREATE TABLE shows (id INTEGER PRIMARY KEY, station_id INTEGER, clock_id INTEGER, is_active INTEGER, days TEXT,
      start_hour INTEGER, end_hour INTEGER, deleted_at TEXT);
    CREATE TABLE generated_schedule (id INTEGER PRIMARY KEY, scheduled_at INTEGER, song_id INTEGER, title TEXT,
      artist TEXT, file_path TEXT, file_key TEXT, duration_s INTEGER, station_id INTEGER, state TEXT DEFAULT 'pending',
      played_at INTEGER, content_class TEXT, deleted_at TEXT);
    INSERT INTO stations (id, scheduler_mode) VALUES (1, 'clock');
    INSERT INTO categories (id, station_id) VALUES (1, 1);
    INSERT INTO clock_slots (id,clock_id,station_id,slot_type,category_id,position) VALUES (1,1,1,'music',1,0);
    INSERT INTO shows (id,station_id,clock_id,is_active,days,start_hour,end_hour) VALUES (1,1,1,1,'0123456',0,0);
    INSERT INTO songs (id,title,category_id,file_path,duration_ms,content_class) VALUES (1,'Song',1,'s.mp3',210000,'MUSIC');
  `);
});
afterEach(() => { vi.useRealTimers(); try { db.close(); } catch {} });

// The 12:00 hour's last song is scheduled 12:58 and runs ~4 min — Generate lets the last song of an
// hour overrun :00 (electron/generate-core.js). The 13:00 hour opens with a legal ID and a spot.
function crossingHour() {
  row(1, at(12, 54));                                      // already aired
  db.prepare("UPDATE generated_schedule SET state='played', played_at=? WHERE id=1").run(at(12, 54));
  row(2, at(12, 58), { state: "playing", playedAt: at(12, 58) });   // the song crossing the hour
  row(10, at(13, 0, 0), { title: "Legal ID" });            // the new hour's first element
  row(11, at(13, 0, 10), { title: "Top spot", cls: "SPOT" });
  row(12, at(13, 0, 40), { title: "First song of 13:00" });
  row(13, at(13, 4, 10), { title: "Second song of 13:00" });
}

describe("the new hour joins after the song that crosses :00", () => {
  it("while the crossing song is still on air at 13:02, the new hour's FIRST element is next", () => {
    crossingHour();
    setNow(13, 2, 0);
    const r = loggen.readLogAnchored(db, 1, 20);
    expect(ids(r)[0]).toBe(10);                             // Legal ID plays next, not the 13:00:40 song
    expect(ids(r).slice(0, 4)).toEqual([10, 11, 12, 13]);   // the hour in order
    expect(r.missedRowIds).not.toContain(10);
    expect(r.missedRowIds).not.toContain(11);               // the top-of-hour spot is not dropped
  });

  it("in the last minute before :00 (inside the 60s slack) the head is not skipped either", () => {
    crossingHour();
    setNow(12, 59, 50);                                     // now+slack reaches 13:00:40
    const r = loggen.readLogAnchored(db, 1, 20);
    expect(ids(r)[0]).toBe(10);
    expect(r.missedRowIds).toEqual([]);
  });

  it("once the head has joined late, the rows whose slots passed during the overrun still play in order", () => {
    crossingHour();
    // the crossing song ended 13:02:00, the ID went live then and has finished; the spot is next
    db.prepare("UPDATE generated_schedule SET state='played' WHERE id=2").run();
    db.prepare("UPDATE generated_schedule SET state='played', played_at=? WHERE id=10").run(at(13, 2, 0));
    setNow(13, 2, 9);
    const r = loggen.readLogAnchored(db, 1, 20);
    expect(ids(r)[0]).toBe(11);                             // the spot, not skipped to the song
    expect(r.missedRowIds).toEqual([]);
  });
});

describe("the reader's ordinary catch-up is unchanged", () => {
  it("mid-hour, behind within the same hour: still anchors to the latest arrived row and retires the rest", () => {
    row(20, at(13, 20), { state: "playing", playedAt: at(13, 20) });
    row(21, at(13, 24));
    row(22, at(13, 27));
    row(23, at(13, 40));
    setNow(13, 30, 0);
    const r = loggen.readLogAnchored(db, 1, 20);
    expect(ids(r)[0]).toBe(22);
    expect(r.missedRowIds).toEqual([21]);
  });

  it("a stale 'playing' row from hours ago does not drag the reader back to an old hour top", () => {
    row(30, at(9, 58), { state: "playing", playedAt: at(9, 58) });
    row(31, at(13, 0));
    row(32, at(13, 30));
    row(33, at(13, 45));
    setNow(13, 40, 0);
    const r = loggen.readLogAnchored(db, 1, 20);
    expect(ids(r)[0]).toBe(32);
  });
});
