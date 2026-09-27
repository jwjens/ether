// fix 8 (docs/help-audit-2026-09-27.md): a renamed song kept its old title in Program Log rows already filled —
// generated_schedule rows carry their own title, schedule:get returns g.title, and no rename path wrote it.
// The rename now reaches the song's FUTURE rows (state 'pending') through the one song writer (songsUpdate), by the
// same rule as the delete contract: played / missed / playing rows are the record and are never rewritten.
// The Program Log re-reads on schedule:changed, so the writer reports the stations it touched and main.js fires it.
//
// Real handler, real SQLite: fresh schema (baseline + migration chain + startup ALTERs), no live DB.
// Run:  ELECTRON_RUN_AS_NODE=1 electron scripts/smoke-rename-log.js   (exit 0 = pass)
"use strict";
const path = require("path");
const fs = require("fs");
const root = path.join(__dirname, "..");
const Database = require(path.join(root, "node_modules", "better-sqlite3"));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}` + (cond ? "" : `  — ${detail || ""}`));
  cond ? pass++ : fail++;
}

const db = new Database(":memory:");
db.pragma("foreign_keys = ON");
require(path.join(__dirname, "schema-v0-baseline.js"))(db);
db.prepare("INSERT INTO stations (name) VALUES (?)").run("Station 1");
db.prepare("INSERT INTO stations (name) VALUES (?)").run("Station 2");
const migs = fs.readdirSync(__dirname).filter(f => /^migrate-.*-phase-sync-(\d+)\.js$/.test(f))
  .map(f => ({ f, v: Number(f.match(/-(\d+)\.js$/)[1]) })).sort((a, b) => a.v - b.v);
const origLog = console.log; console.log = () => {};
for (const m of migs) require(path.join(__dirname, m.f)).applyMigration(db);
console.log = origLog;
const main = fs.readFileSync(path.join(root, "electron", "main.js"), "utf8");
for (const [, sql] of main.matchAll(/alterSafe\("(ALTER TABLE [^"]+)"\)/g)) { try { db.exec(sql); } catch {} }

const songs = require(path.join(root, "electron", "sync", "handlers", "songs.js"));
const created = songs.songsCreate(db, { title: "Old Name", file_path: "C:/m/old.mp3" });
const other = songs.songsCreate(db, { title: "Someone Else", file_path: "C:/m/else.mp3" });
check("fixture songs created", created && created.id && other && other.id);

const ins = db.prepare(`INSERT INTO generated_schedule (uuid, station_id, scheduled_at, song_id, title, artist, state, source)
                        VALUES (?, ?, ?, ?, ?, '', ?, 'generated')`);
let t = 1_800_000_000;
const rows = [
  ["p1", 1, created.id, "Old Name", "pending"],
  ["p2", 2, created.id, "Old Name", "pending"],   // the same song filled into another station's log
  ["pl", 1, created.id, "Old Name", "played"],
  ["on", 1, created.id, "Old Name", "playing"],
  ["mi", 1, created.id, "Old Name", "missed"],
  ["ot", 1, other.id,   "Someone Else", "pending"],
];
for (const [u, sid, songId, title, state] of rows) ins.run(u, sid, t++, songId, title, state);
const title = u => db.prepare("SELECT title FROM generated_schedule WHERE uuid = ?").get(u).title;

let told = null;
if (typeof songs.onLogRetitled === "function") songs.onLogRetitled(sids => { told = sids; });
songs.songsUpdateById(db, created.id, { title: "New Name" });

check("pending rows in THIS station's log take the new title", title("p1") === "New Name", title("p1"));
check("pending rows in ANOTHER station's log take it too (same song)", title("p2") === "New Name", title("p2"));
check("a PLAYED row keeps the title it aired under", title("pl") === "Old Name", title("pl"));
check("the PLAYING row is not touched", title("on") === "Old Name", title("on"));
check("a MISSED row keeps its title", title("mi") === "Old Name", title("mi"));
check("another song's row is not touched", title("ot") === "Someone Else", title("ot"));
check("the writer reports the stations whose log changed (for schedule:changed)", Array.isArray(told) && told.slice().sort().join(",") === "1,2", JSON.stringify(told));

told = null;
songs.songsUpdateById(db, created.id, { genre: "Rock" });
check("a patch without a title touches no log row and reports nothing", told === null && title("p1") === "New Name", JSON.stringify(told));
told = null;
songs.songsUpdateById(db, created.id, { title: "New Name" });
check("re-saving the same title reports nothing", told === null, JSON.stringify(told));

check("main.js fires schedule:changed for every station the rename touched",
  /onLogRetitled\(\s*sids\s*=>\s*\{?\s*for \(const s of sids\) _scheduleChanged\(s, ["']song-renamed["']\)/.test(main));

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILED"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
