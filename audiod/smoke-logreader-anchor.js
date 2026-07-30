// Off-air harness for the Log-Reader Flip read-through (activation). Exercises the REAL
// loggen.readLogAnchored (§2.7 anchor + rider A) and DaemonEngine._logReaderOn (per-station flag) against
// an in-memory SQLite — NO audio device, NO live DB, NO pipe — so it is safe to run anytime.
// Run:  ELECTRON_RUN_AS_NODE=1 electron.exe audiod/smoke-logreader-anchor.js   (exit 0 = pass)
// NOTE: plain `node` CRASHES here with ERR_DLOPEN_FAILED — better-sqlite3 is built for Electron's ABI,
// not system node's. That is the environment, NOT a regression; run it the way the line above says.
"use strict";
const path = require("path");
const Database = require(path.join(__dirname, "..", "node_modules", "better-sqlite3"));
const loggen = require(path.join(__dirname, "loggen.js"));
const { DaemonEngine } = require(path.join(__dirname, "engine.js"));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}` + (cond ? "" : `  — ${detail || ""}`));
  cond ? pass++ : fail++;
}

const db = new Database(":memory:");
db.exec(`
  CREATE TABLE stations (id INTEGER PRIMARY KEY, uuid TEXT, name TEXT, deleted_at TEXT);
  CREATE TABLE categories (id INTEGER PRIMARY KEY, station_id INTEGER, name TEXT, deleted_at TEXT);
  CREATE TABLE artists (id INTEGER PRIMARY KEY, name TEXT);
  CREATE TABLE songs (id INTEGER PRIMARY KEY, title TEXT, artist_id INTEGER, category_id INTEGER, file_path TEXT, file_key TEXT, duration_ms INTEGER, intro_end INTEGER, outro_start INTEGER, rotation_status TEXT, content_class TEXT, daypart_mask INTEGER, last_played_at INTEGER, deleted_at TEXT);
  CREATE TABLE clocks (id INTEGER PRIMARY KEY, station_id INTEGER, name TEXT, deleted_at TEXT);
  CREATE TABLE clock_slots (id INTEGER PRIMARY KEY, clock_id INTEGER, station_id INTEGER, slot_type TEXT, category_id INTEGER, position INTEGER, deleted_at TEXT);
  CREATE TABLE shows (id INTEGER PRIMARY KEY, station_id INTEGER, clock_id INTEGER, is_active INTEGER, days TEXT, start_hour INTEGER, end_hour INTEGER, deleted_at TEXT);
  CREATE TABLE separation_rules (id INTEGER PRIMARY KEY, station_id INTEGER, rule_type TEXT, value INTEGER, is_active INTEGER);
  CREATE TABLE generated_schedule (id INTEGER PRIMARY KEY, scheduled_at INTEGER, song_id INTEGER, title TEXT, artist TEXT, file_path TEXT, file_key TEXT, duration_s INTEGER, category_id INTEGER, clock_id INTEGER, station_id INTEGER, uuid TEXT, state TEXT DEFAULT 'pending', played_at INTEGER, seq REAL, source TEXT, content_class TEXT, created_at TEXT, updated_at TEXT, deleted_at TEXT);
  CREATE TABLE station_config_kv (station_id INTEGER, key TEXT, value TEXT, uuid TEXT, deleted_at TEXT, PRIMARY KEY(station_id,key));
  INSERT INTO stations (id,uuid,name) VALUES (1,'u1','Test');
  INSERT INTO categories (id,station_id,name) VALUES (1,1,'Format');
  INSERT INTO clocks (id,station_id,name) VALUES (1,1,'Clock');
  INSERT INTO clock_slots (id,clock_id,station_id,slot_type,category_id,position) VALUES (1,1,1,'music',1,0);
  INSERT INTO shows (id,station_id,clock_id,is_active,days,start_hour,end_hour) VALUES (1,1,1,1,'0123456',0,0);
`);
// songs in the format category (file_path truthy — readLogAnchored filters on truthiness, not disk)
const insSong = db.prepare("INSERT INTO songs (id,title,category_id,file_path,duration_ms,rotation_status,content_class) VALUES (?,?,1,?,180000,'active','MUSIC')");
for (let i = 1; i <= 8; i++) insSong.run(i, "Song " + i, "s" + i + ".mp3");

const now = Math.floor(Date.now() / 1000);
const insRow = db.prepare("INSERT INTO generated_schedule (id,scheduled_at,song_id,title,file_path,station_id,state,category_id,content_class) VALUES (?,?,?,?,?,1,?,1,'MUSIC')");
const reset = (rows) => { db.prepare("DELETE FROM generated_schedule").run(); for (const r of rows) insRow.run(r.id, r.at, (r.id % 8) + 1, "Song " + r.id, "g" + r.id + ".mp3", r.state || "pending"); };
const dayStartTs = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return Math.floor(d.getTime() / 1000); })();

console.log("── (1) BEHIND: legacy ran ahead → anchor to the now-slot, stamp earlier-today rows missed ──");
reset([
  { id: 10, at: dayStartTs - 3600 },   // YESTERDAY (before day start) → must NOT be missed (day-bounded)
  { id: 11, at: now - 7200 },          // 2h ago today → missed
  { id: 12, at: now - 3600 },          // 1h ago today → missed
  { id: 13, at: now - 300 },           // the current slot (latest pending <= now) → anchor
  { id: 14, at: now + 600 },           // future → queued after the anchor
]);
{
  const r = loggen.readLogAnchored(db, 1, 20);
  check("mode = behind", r.mode === "behind", r.mode);
  check("anchor = the now-slot row (13)", r.items[0] && r.items[0].schedId === 13, JSON.stringify(r.items.map(i => i.schedId)));
  check("missed = the two earlier-TODAY rows (11,12)", JSON.stringify(r.missedRowIds.sort()) === "[11,12]", JSON.stringify(r.missedRowIds));
  check("day-bounded: yesterday's row (10) NOT missed", !r.missedRowIds.includes(10), JSON.stringify(r.missedRowIds));
  check("items non-empty, start at anchor forward", r.items.length === 2 && r.items[1].schedId === 14, r.items.length);
}

console.log("\n── (2) AHEAD (rider A): all rows future → play the earliest EARLY, never empty, no missed ──");
reset([{ id: 20, at: now + 600 }, { id: 21, at: now + 1200 }]);
{
  const r = loggen.readLogAnchored(db, 1, 20);
  check("mode = ahead", r.mode === "ahead", r.mode);
  check("items NON-EMPTY (never wait/dead-air)", r.items.length === 2, r.items.length);
  check("earliest future row is first (plays early)", r.items[0] && r.items[0].schedId === 20, JSON.stringify(r.items.map(i => i.schedId)));
  check("nothing stamped missed when ahead", r.missedRowIds.length === 0, JSON.stringify(r.missedRowIds));
  check("aheadBySec ~ 600 (>0)", r.aheadBySec > 300 && r.aheadBySec < 900, r.aheadBySec);
}

console.log("\n── (3) ON-TIME: a row within slack of now → on-time, no missed ──");
reset([{ id: 30, at: now + 20 }, { id: 31, at: now + 600 }]);
{
  const r = loggen.readLogAnchored(db, 1, 20);
  check("mode = on-time", r.mode === "on-time", r.mode);
  check("no missed", r.missedRowIds.length === 0, JSON.stringify(r.missedRowIds));
  check("anchor is the near row (30)", r.items[0] && r.items[0].schedId === 30, JSON.stringify(r.items.map(i => i.schedId)));
}

console.log("\n── (4) EXHAUSTED: no pending music rows → empty items → engine floor ──");
reset([{ id: 40, at: now - 300, state: "played" }, { id: 41, at: now + 600, state: "played" }]);
{
  const r = loggen.readLogAnchored(db, 1, 20);
  check("mode = exhausted", r.mode === "exhausted", r.mode);
  check("items empty (engine falls to the emergency floor)", r.items.length === 0, r.items.length);
}

console.log("\n── (5) The per-station flag gate — OFF-path guarantee (rider B storage) ──");
{
  const eOff = new DaemonEngine(1, db, () => {});
  check("flag OFF by default → _logReaderOn() false (legacy playout)", eOff._logReaderOn() === false, String(eOff._logReaderOn()));
  db.prepare("INSERT INTO station_config_kv (station_id,key,value) VALUES (1,'log_reader_flip','1')").run();
  const eOn = new DaemonEngine(1, db, () => {});   // fresh instance → reads the flag fresh (no cache)
  check("flag = '1' → _logReaderOn() true (flip active for THIS station)", eOn._logReaderOn() === true, String(eOn._logReaderOn()));
  const eOther = new DaemonEngine(2, db, () => {});
  check("a DIFFERENT station stays OFF (per-station)", eOther._logReaderOn() === false, String(eOther._logReaderOn()));
}

db.close();
console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ " + fail + " FAILED"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
