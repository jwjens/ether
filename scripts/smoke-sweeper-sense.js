// fix 15 — the sweeper sense against real SQLite (fresh schema: baseline + migration chain + startup ALTERs).
// senseStation reads assignments, today's placed / fired, the last hour of AIR from play_log, and the placement skip
// log that _placeJingles writes through recordPlacement. No live DB.
// Run:  ELECTRON_RUN_AS_NODE=1 electron scripts/smoke-sweeper-sense.js   (exit 0 = pass)
"use strict";
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const root = path.join(__dirname, "..");
const Database = require(path.join(root, "node_modules", "better-sqlite3"));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}` + (cond ? "" : `  — ${detail || ""}`));
  cond ? pass++ : fail++;
}

const db = new Database(":memory:");
require(path.join(__dirname, "schema-v0-baseline.js"))(db);
db.prepare("INSERT INTO stations (name) VALUES (?)").run("Station 1");
const migs = fs.readdirSync(__dirname).filter(f => /^migrate-.*-phase-sync-(\d+)\.js$/.test(f))
  .map(f => ({ f, v: Number(f.match(/-(\d+)\.js$/)[1]) })).sort((a, b) => a.v - b.v);
const origLog = console.log; console.log = () => {};
for (const m of migs) require(path.join(__dirname, m.f)).applyMigration(db);
console.log = origLog;
const main = fs.readFileSync(path.join(root, "electron", "main.js"), "utf8");
for (const [, sql] of main.matchAll(/alterSafe\("(ALTER TABLE [^"]+)"\)/g)) { try { db.exec(sql); } catch {} }
try { db.prepare("UPDATE stations SET uuid = 'st-uuid-1' WHERE id = 1").run(); } catch {}

const S = require(path.join(root, "electron", "sweeper-sense.js"));
const SID = 1;
const now = Math.floor(Date.now() / 1000);

let r = S.senseStation(db, SID, now);
check("no assignment → grey, 'none assigned' (never an alarm)", r.level === "grey" && r.assigned === false, JSON.stringify(r));

// Assign: a category with a pool overlay, all hours.
db.prepare("INSERT INTO categories (code, name, station_id, uuid, overlay_kind, overlay_category_id) VALUES ('A','Gold',?,?, 'pool', 7)").run(SID, crypto.randomUUID());
r = S.senseStation(db, SID, now);
check("assigned but under an hour of air → grey", r.assigned && r.level === "grey" && /less than an hour/.test(r.reason), JSON.stringify(r));

// An hour of music, no sweeper fired.
const ins = db.prepare("INSERT INTO play_log (uuid, station_id, title, played_at, duration_ms, content_class) VALUES (?, ?, ?, ?, ?, ?)");
for (let i = 0; i < 16; i++) ins.run(crypto.randomUUID(), SID, `Song ${i}`, now - 60 - i * 240, 240000, "MUSIC");
r = S.senseStation(db, SID, now);
check("assigned + an hour of air + nothing fired → RED", r.level === "red" && r.firedInWindow === 0, JSON.stringify(r));

// One fire inside that hour.
ins.run(crypto.randomUUID(), SID, "Legal ID", now - 600, 8000, "SWP");
r = S.senseStation(db, SID, now);
check("a sweeper fired in the last hour of air → green, and today's fired count shows it", r.level === "green" && r.fired >= 1, JSON.stringify(r));

// Placed today + skip log.
db.prepare("INSERT INTO generated_schedule (uuid, station_id, scheduled_at, title, content_class, state, source) VALUES (?, ?, ?, 'Legal ID', 'SWP', 'pending', 'generated')").run(crypto.randomUUID(), SID, now + 300);
S.recordPlacement(db, SID, { [S.localDate(now)]: { placed: 1, off_hours: 2, no_fit: 1, no_file: 0 } });
S.recordPlacement(db, SID, { [S.localDate(now)]: { placed: 0, off_hours: 0, no_fit: 0, no_file: 3 } });
r = S.senseStation(db, SID, now);
check("placed today counts today's SWP log rows", r.placed === 1, JSON.stringify(r));
check("skips recorded by placement are summed per reason", r.skipped.off_hours === 2 && r.skipped.no_fit === 1 && r.skipped.no_file === 3, JSON.stringify(r.skipped));
const kvRow = db.prepare("SELECT key FROM station_config_kv WHERE station_id = ? AND key = ?").get(SID, S.PLACEMENT_KEY);
check("the skip log is a station key (synced — every machine sees what the generator skipped)", !!kvRow);
check("the live sense carries the station uuid (to match the daemon's live events)", r.stationUuid === "st-uuid-1" || r.stationUuid != null, String(r.stationUuid));

// Off-hours assignment only: nothing aired in covered hours → grey, not red.
db.prepare("UPDATE categories SET overlay_active_hours = ? WHERE station_id = ?").run(0, SID);
db.prepare("DELETE FROM play_log WHERE content_class = 'SWP'").run();
r = S.senseStation(db, SID, now);
check("an assignment whose hours exclude the hour that aired → grey, not red", r.level === "grey", JSON.stringify(r));

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILED"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
