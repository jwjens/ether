// scripts/smoke-plays-here.js — each computer's rotation counts the plays that aired on THAT computer, plus the old plays
// with no computer recorded (Jeff, 2026-10-20; audiod/plays-here.js, design §3.9).
//   npm run test:plays-here
"use strict";
const path = require("path");
const Database = require("better-sqlite3");
const ROOT = path.join(__dirname, "..");
const { playsHere, machineIdOf } = require(path.join(ROOT, "audiod", "plays-here.js"));
const { buildRestMaps } = require(path.join(ROOT, "electron", "separation-enforce.js"));
const { preparePoolCandidates } = require(path.join(ROOT, "electron", "sweeper-pool.js"));

let pass = 0, fail = 0;
const check = (name, ok, extra) => { if (ok) { pass++; console.log(`PASS  ${name}`); } else { fail++; console.log(`FAIL  ${name}${extra ? "  — " + extra : ""}`); } };

const ME = "8e8f6181-b68a-433f-a93d-8005787b641b", OTHER = "041ceb96-3d66-4d39-85c0-e2f5aa6e3b1e";
const db = new Database(":memory:");
db.exec(`
  CREATE TABLE client_identity (client_id TEXT);
  CREATE TABLE artists (id INTEGER PRIMARY KEY, name TEXT);
  CREATE TABLE songs (id INTEGER PRIMARY KEY, uuid TEXT, title TEXT, file_path TEXT, artist_id INTEGER, duration_ms INTEGER, content_class TEXT,
                      rotation_status TEXT, jingle_category_id INTEGER, cue_out REAL, cue_out_ms INTEGER, outro_start REAL, deleted_at TEXT);
  CREATE TABLE play_log (id INTEGER PRIMARY KEY, station_id INTEGER, file_path TEXT, title TEXT, played_at INTEGER, deleted_at TEXT,
                         content_class TEXT, machine_id TEXT);
`);
db.prepare("INSERT INTO client_identity VALUES (?)").run(ME);
db.prepare("INSERT INTO artists VALUES (1, 'A'), (2, 'B'), (3, 'C')").run();
const song = (id, f, a, cc, pool) => db.prepare("INSERT INTO songs (id, uuid, title, file_path, artist_id, duration_ms, content_class, jingle_category_id) VALUES (?, ?, ?, ?, ?, 3000, ?, ?)").run(id, "u" + id, f, f, a, cc, pool ?? null);
song(1, "here.mp3", 1, "MUSIC"); song(2, "there.mp3", 2, "MUSIC"); song(3, "old.mp3", 3, "MUSIC");
song(10, "swp-here.wav", null, "SWP", 7); song(11, "swp-there.wav", null, "SWP", 7); song(12, "swp-never.wav", null, "SWP", 7);
const play = (f, t, m) => db.prepare("INSERT INTO play_log (station_id, file_path, title, played_at, content_class, machine_id) VALUES (2, ?, ?, ?, 'MUSIC', ?)").run(f, f, t, m);
play("here.mp3", 1000, ME); play("there.mp3", 2000, OTHER); play("old.mp3", 500, null);
play("swp-here.wav", 1500, ME); play("swp-there.wav", 2500, OTHER);

check("this computer's id is read from client_identity", machineIdOf(db) === ME);
check("the condition counts this computer's plays and the old unrecorded ones", playsHere(db, "pl") === `(pl.machine_id = '${ME}' OR pl.machine_id IS NULL)`);
check("no database (a caller without one): every play counts, never none", playsHere(null, "pl") === "1=1");

const { restByFile, restByArtist, restByTitle } = buildRestMaps(db, 2);
check("separation: a song aired HERE rests", restByFile.get("here.mp3") === 1000 && restByArtist.get(1) === 1000 && restByTitle.get("here.mp3") === 1000);
check("separation: a song aired on the OTHER computer does not rest here", !restByFile.has("there.mp3") && !restByArtist.has(2) && !restByTitle.has("there.mp3"));
check("separation: an old play with no computer recorded counts here", restByFile.get("old.mp3") === 500);

const order = preparePoolCandidates(db, "legacy").all(7, "SWP", 2).map(r => r.file_path);
check(`sweeper pool: least recently played ON THIS COMPUTER first — the other computer's play does not count (${order.join(", ")})`,
  order[0] === "swp-there.wav" || order[0] === "swp-never.wav" ? order.indexOf("swp-here.wav") === 2 : false, JSON.stringify(order));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
