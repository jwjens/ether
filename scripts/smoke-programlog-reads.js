// Program Log slice 1 — the two SQL reads, against an in-memory SQLite. No live DB, no audio.
// Run:  ELECTRON_RUN_AS_NODE=1 electron scripts/smoke-programlog-reads.js   (exit 0 = pass)
// (plain `node` fails with ERR_DLOPEN_FAILED — better-sqlite3 is built for Electron's ABI.)
//
// 1. the mini-month query (BroadcastCalendar.tsx:204-207's shape) runs WITH its [stationId] binding
//    and fails the way the filed bug fails WITHOUT it ("Too few parameter values");
// 2. the schedule:get SELECT — read out of electron/main.js so this tests the shipped string, not a
//    copy — returns played_at, windows by station + [from, to), and gives [] for a station with no log.
"use strict";
const path = require("path");
const fs = require("fs");
const Database = require(path.join(__dirname, "..", "node_modules", "better-sqlite3"));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}` + (cond ? "" : `  — ${detail || ""}`));
  cond ? pass++ : fail++;
}

const db = new Database(":memory:");
db.exec(`
  CREATE TABLE generated_schedule (
    id INTEGER PRIMARY KEY, uuid TEXT, station_id INTEGER, scheduled_at INTEGER NOT NULL,
    song_id INTEGER, title TEXT, artist TEXT, file_key TEXT, file_path TEXT, duration_s REAL,
    category_id INTEGER, source TEXT, state TEXT DEFAULT 'pending', played_at INTEGER,
    content_class TEXT, channel TEXT, deleted_at INTEGER
  );
  CREATE TABLE songs (id INTEGER PRIMARY KEY, category_id INTEGER);
  CREATE TABLE categories (id INTEGER PRIMARY KEY, station_id INTEGER);
`);
// station 2 has a log on two days; station 3 has none; one row is deleted; one played.
const day = Math.floor(new Date(2026, 8, 17).getTime() / 1000); // local midnight 2026-09-17
const ins = db.prepare(`INSERT INTO generated_schedule (uuid, station_id, scheduled_at, song_id, title, artist, duration_s, state, played_at, content_class, deleted_at)
                        VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
ins.run("u1", 2, day + 60, 1, "one", "a", 180, "played", day + 63, "MUSIC", null);
ins.run("u2", 2, day + 3600 * 5, 2, "two", "a", 200, "pending", null, "MUSIC", null);
ins.run("u3", 2, day + 86_400 + 10, 3, "tomorrow", "a", 200, "pending", null, "MUSIC", null);
ins.run("u4", 2, day + 100, 4, "deleted", "a", 200, "pending", null, "MUSIC", 1);
ins.run("u5", 1, day + 100, 5, "other station", "a", 200, "pending", null, "MUSIC", null);

// ── 1. mini-month dots ────────────────────────────────────────────────────────────────────────
const DOTS = "SELECT DISTINCT date(scheduled_at,'unixepoch','localtime') d FROM generated_schedule WHERE station_id = ? AND deleted_at IS NULL";
let dots, err = null;
try { dots = db.prepare(DOTS).all(2).map(r => r.d); } catch (e) { err = e.message; }
check("mini-month query runs with its [stationId] binding", err === null, err);
check("dots = the station's days (deleted row and other station excluded)", JSON.stringify(dots) === JSON.stringify(["2026-09-17", "2026-09-18"]), JSON.stringify(dots));
let unboundErr = null;
try { db.prepare(DOTS).all(); } catch (e) { unboundErr = e.message; }
check("the same query WITHOUT the binding is the filed bug: 'Too few parameter values'", /Too few parameter values/.test(unboundErr || ""), unboundErr);
check("a station with no log → no dots, no error", db.prepare(DOTS).all(3).length === 0);

// ── 2. schedule:get — the SELECT as shipped in main.js ────────────────────────────────────────
const main = fs.readFileSync(path.join(__dirname, "..", "electron", "main.js"), "utf8");
const m = main.match(/ipcMain\.handle\('schedule:get'[\s\S]*?db\.prepare\(\s*(?:\/\/[^\n]*\n\s*)*`([\s\S]*?)`\s*\)\.all\(sid, fromTs \?\? 0, toTs \?\? 9999999999\)/);
check("schedule:get SELECT located in electron/main.js", !!m, "regex did not match");
const SQL = m ? m[1] : "";
check("schedule:get selects g.played_at", /g\.played_at/.test(SQL));
const get = (sid, from, to) => db.prepare(SQL).all(sid, from, to);
const today = get(2, day, day + 86_400);
check("today for station 2 = the two live rows in the window (deleted + tomorrow + other station excluded)",
  today.map(r => r.uuid).join(",") === "u1,u2", today.map(r => r.uuid).join(","));
check("played_at comes back on the played row and null on the pending one",
  today[0].played_at === day + 63 && today[1].played_at === null, JSON.stringify(today.map(r => r.played_at)));
check("every column the Program Log maps is present",
  ["id", "uuid", "scheduled_at", "song_id", "title", "artist", "duration_s", "category_id", "source", "state", "content_class", "channel", "played_at"].every(k => k in today[0]),
  Object.keys(today[0]).join(","));
check("a station with no log for the day → [] (no error)", get(3, day, day + 86_400).length === 0);
check("the window is half-open: a row at dayEnd + 10 s is tomorrow's", get(2, day + 86_400, day + 2 * 86_400).map(r => r.uuid).join(",") === "u3");

console.log(`=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
