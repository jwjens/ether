// Bench for the HOUR ROLLOVER (2026-10-04). Exercises the REAL DaemonEngine.poll() — no audio device,
// no live DB, no pipe — so it is safe to run anytime.
//   ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe audiod/smoke-hour-rollover.js
//   (exit 0 = pass)
//
// Jeff's ruling: TAKE OUT the top-of-hour hard cut. At :00 decks A/B/C are NOT stopped and the queue is
// NOT cleared. A song that crosses the hour keeps playing to its end; the new hour joins after it.
//
// The rig: automation engaged, deck A mid-song, B cued, a queue of three, and a new-hour schedule in
// the log (the condition under which the old cut fired). The engine is told the last hour it acted on
// was the PREVIOUS hour — exactly the state at 13:00:00.250 — and one real poll() tick is run with
// every actuator tripwired. Any stop, load, play, advance or queue wipe is a FAIL.
"use strict";
const path = require("path");
const Database = require(path.join(__dirname, "..", "node_modules", "better-sqlite3"));
const { DaemonEngine } = require(path.join(__dirname, "engine.js"));

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}` + (ok ? "" : `\n        got=${JSON.stringify(got)} want=${JSON.stringify(want)}`));
  ok ? pass++ : fail++;
}

const db = new Database(":memory:");
db.exec(`
  CREATE TABLE stations (id INTEGER PRIMARY KEY, uuid TEXT, name TEXT, scheduler_mode TEXT, deleted_at TEXT);
  CREATE TABLE categories (id INTEGER PRIMARY KEY, station_id INTEGER, name TEXT, deleted_at TEXT);
  CREATE TABLE artists (id INTEGER PRIMARY KEY, name TEXT);
  CREATE TABLE songs (id INTEGER PRIMARY KEY, title TEXT, artist_id INTEGER, category_id INTEGER, file_path TEXT, file_key TEXT, duration_ms INTEGER, intro_end INTEGER, outro_start INTEGER, rotation_status TEXT, content_class TEXT, daypart_mask INTEGER, last_played_at INTEGER, deleted_at TEXT);
  CREATE TABLE clock_slots (id INTEGER PRIMARY KEY, clock_id INTEGER, station_id INTEGER, slot_type TEXT, category_id INTEGER, position INTEGER, deleted_at TEXT);
  CREATE TABLE shows (id INTEGER PRIMARY KEY, station_id INTEGER, clock_id INTEGER, is_active INTEGER, days TEXT, start_hour INTEGER, end_hour INTEGER, deleted_at TEXT);
  CREATE TABLE generated_schedule (id INTEGER PRIMARY KEY, scheduled_at INTEGER, song_id INTEGER, title TEXT, artist TEXT, file_path TEXT, file_key TEXT, duration_s INTEGER, station_id INTEGER, state TEXT DEFAULT 'pending', played_at INTEGER, content_class TEXT, deleted_at TEXT);
  CREATE TABLE station_config_kv (station_id INTEGER, key TEXT, value TEXT, uuid TEXT, deleted_at TEXT, PRIMARY KEY(station_id,key));
  INSERT INTO stations (id,uuid,name) VALUES (1,'u1','Test');
  INSERT INTO categories (id,station_id,name) VALUES (1,1,'Format');
  INSERT INTO clock_slots (id,clock_id,station_id,slot_type,category_id,position) VALUES (1,1,1,'music',1,0);
  INSERT INTO shows (id,station_id,clock_id,is_active,days,start_hour,end_hour) VALUES (1,1,1,1,'0123456',0,0);
`);
db.prepare("INSERT INTO songs (id,title,category_id,file_path,duration_ms,content_class) VALUES (1,'Song',1,?,210000,'MUSIC')").run(__filename);
// A new-hour schedule in the log: the condition under which the old cut fired.
const hs = new Date(); hs.setMinutes(0, 0, 0);
const hourStart = Math.floor(hs.getTime() / 1000);
const ins = db.prepare("INSERT INTO generated_schedule (id,scheduled_at,song_id,title,file_path,station_id,content_class) VALUES (?,?,1,?,?,1,'MUSIC')");
ins.run(100, hourStart, "New hour — first element", __filename);
ins.run(101, hourStart + 180, "New hour — second", __filename);

const acted = [];
const e = new DaemonEngine(1, db, () => {});
// Tripwire every actuator that could take the crossing song off air or touch the queue.
e._log = (...a) => { if (process.env.DBG) console.log("[log]", ...a); };
e._stop = (d) => acted.push(["STOP", d]);
e._play = (d) => acted.push(["PLAY", d]);
e._load = (d) => acted.push(["LOAD", d]);
e.loadToDeck = (d) => { acted.push(["LOAD", d]); return true; };
e.handleRotate = (f, t) => acted.push(["ROTATE", f, t]);
e.preload = (d) => { acted.push(["PRELOAD", d]); return Promise.resolve(); };
e.refillIfNeeded = () => Promise.resolve();
// Runs the op body synchronously up to its first await, so a stop/clear inside it is recorded.
e._advance = (w, fn) => {
  acted.push(["ADVANCE", w]);
  try { const p = fn && fn(); if (p && p.catch) p.catch(() => {}); } catch { /* recorded above */ }
  return Promise.resolve();
};
const _clear = e.clearQueue.bind(e);
e.clearQueue = () => { acted.push(["CLEAR"]); return _clear(); };
e._resolveLocal = (p) => p || null;   // every scheduled file "exists" here: the rig has no library
// Everything in poll() that would reach the native addon or the KV store is inert here.
for (const m of ["_readLevels", "_mixHeartbeat", "_applyProcessingFromKv", "_applyChannelRacksFromKv",
  "_applyMicInputsFromKv", "_applySegueOverlapFromKv", "_applyPflDimFromKv", "_applyCueDeviceFromKv",
  "_liveDeckObserverTick", "_retireTick", "_maybeEmitDeck", "_jingleTick", "_segueTick", "_emitEngineState"]) {
  if (typeof e[m] === "function") e[m] = () => null;
}
// Deck A is mid-song (30s of 210s), B is cued, C idle — as the native state reports it.
const deck = (status, fp) => ({ status, file_path: fp, title: "t", artist: "", position_sec: 30, volume: 1 });
e._state = () => ({ deckA: deck("playing", "a.mp3"), deckB: deck("loaded", "b.mp3"), deckC: deck("idle", "") });
e._started = true;
e.continuous = true;
e.stateA = { status: "playing", title: "Crossing song", filePath: "a.mp3", positionSec: 30, durationSec: 210 };
e.stateB = { status: "loaded", title: "Cued", filePath: "b.mp3", positionSec: 0, durationSec: 200 };
e.stateC = { status: "idle", title: "", filePath: "", positionSec: 0, durationSec: 0 };
e.deckReady.add("B"); e.deckReady.add("C");
e.queue = [
  { qid: "q1", title: "next 1", filePath: "n1.mp3", durationMs: 180000 },
  { qid: "q2", title: "next 2", filePath: "n2.mp3", durationMs: 180000 },
  { qid: "q3", title: "next 3", filePath: "n3.mp3", durationMs: 180000 },
];
const queueBefore = e.queue.map(q => q.qid);
// The moment of rollover: the engine last acted in the PREVIOUS hour. (The old cut keyed on this field;
// with the cut gone the field no longer exists and setting it is harmless.)
e._lastHourCut = (new Date().getHours() + 23) % 24;

console.log("── a · one poll() tick across the hour boundary, a song on A, a new-hour schedule present ──");
e.poll();
check("a · no deck is stopped", acted.filter(a => a[0] === "STOP"), []);
check("a · nothing is loaded or played over the crossing song", acted.filter(a => a[0] === "LOAD" || a[0] === "PLAY"), []);
check("a · no advance is started (no top-of-hour op)", acted.filter(a => a[0] === "ADVANCE"), []);
check("a · the queue is NOT cleared", acted.filter(a => a[0] === "CLEAR"), []);
check("a · the queue is unchanged", e.queue.map(q => q.qid), queueBefore);
check("a · deck A is still playing", e.stateA.status, "playing");
check("a · the engine has no top-of-hour cut to call", typeof e._hardCutTopOfHour, "undefined");

db.close();
console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ " + fail + " FAILED"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
