// fix 11 (docs/help-audit-2026-09-27.md; Jeff's ruling 2026-09-27): AUTO-POST could not be switched on from the
// app — placement read categories.overlay_chain_type and nothing wrote it, so the behaviour had no switch. Ruling:
// "build it as a station setting in the Sweepers panel … A behaviour with no switch is a hidden number."
// The one switch is now the station key `overlay_auto_post` (station_config_kv, synced with the station — it is a
// decision about the station's sound). Unset / anything but "1" = off = the LEAD path, byte for byte as before.
//
// Real SQLite, fresh schema. Run:  ELECTRON_RUN_AS_NODE=1 electron scripts/smoke-autopost-switch.js
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
require(path.join(__dirname, "schema-v0-baseline.js"))(db);
db.prepare("INSERT INTO stations (name) VALUES (?)").run("Station 1");
db.prepare("INSERT INTO stations (name) VALUES (?)").run("Station 2");
const migs = fs.readdirSync(__dirname).filter(f => /^migrate-.*-phase-sync-(\d+)\.js$/.test(f))
  .map(f => ({ f, v: Number(f.match(/-(\d+)\.js$/)[1]) })).sort((a, b) => a.v - b.v);
const origLog = console.log; console.log = () => {};
for (const m of migs) require(path.join(__dirname, m.f)).applyMigration(db);
console.log = origLog;

let mod = null;
try { mod = require(path.join(root, "electron", "auto-post-switch.js")); } catch (e) { check("electron/auto-post-switch.js exists", false, e.message); }
if (mod) {
  const { readAutoPost, AUTO_POST_KEY } = mod;
  check("the key is overlay_auto_post", AUTO_POST_KEY === "overlay_auto_post", AUTO_POST_KEY);
  check("unset → off (today's LEAD path)", readAutoPost(db, 1) === false);
  const put = (sid, v) => db.prepare(`INSERT INTO station_config_kv (station_id, key, value, uuid, updated_at) VALUES (?, 'overlay_auto_post', ?, ?, datetime('now'))`)
    .run(sid, v, `u-${sid}-${v}-${Math.random()}`);
  put(1, "1");
  check("\"1\" → on for that station", readAutoPost(db, 1) === true);
  check("…and only that station", readAutoPost(db, 2) === false);
  db.prepare("UPDATE station_config_kv SET value = '0' WHERE station_id = 1 AND key = 'overlay_auto_post'").run();
  check("\"0\" → off", readAutoPost(db, 1) === false);
  db.prepare("UPDATE station_config_kv SET value = '1', deleted_at = datetime('now') WHERE station_id = 1 AND key = 'overlay_auto_post'").run();
  check("a deleted row → off", readAutoPost(db, 1) === false);
  check("a DB without the table → off, never throws", readAutoPost(new Database(":memory:"), 1) === false);
}

const main = fs.readFileSync(path.join(root, "electron", "main.js"), "utf8");
const place = main.slice(main.indexOf("function _placeJingles("), main.indexOf("function _placeJingles(") + 12000);
check("placement takes AUTO-POST from the station switch", /const wantsAutoPost = stationAutoPost;/.test(place) && /readAutoPost\(db, stationId\)/.test(place));
check("placement no longer takes it from the category column (no second, unswitchable source)", !/overlay_chain_type === 'auto_post'/.test(place));

const panel = fs.readFileSync(path.join(root, "src", "components", "SweepersPanel.tsx"), "utf8");
check("the Sweepers panel writes the station key", /upsertByKey\(stationId, "overlay_auto_post"/.test(panel));
check("the Sweepers panel reads it back", /x\.key === "overlay_auto_post"/.test(panel));

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILED"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
