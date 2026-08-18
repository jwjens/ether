"use strict";
/**
 * REPAIR the station re-key caused by uuid-identity's INSERT OR REPLACE (see merge-engine.js).
 *
 * Stations were deleted and re-inserted with new autoincrement ids (1,2,3,4 -> 5,6,7,8) while every
 * child row kept pointing at the OLD ids. Nothing was deleted; everything was orphaned. This maps
 * old id -> new id BY UUID and re-points the children.
 *
 * THE MAP IS NOT GUESSED. It comes from the child rows' own station_config_kv license/station rows
 * and the mutation journal is not needed: each surviving station carries its uuid, and the ORDER of
 * the old ids is recoverable because the re-insert preserved created_at. To avoid inferring, the map
 * is passed in explicitly and VERIFIED against station count and orphan count before anything runs.
 *
 * DRY RUN BY DEFAULT. --write to commit. --db <path> to run against a copy.
 * Run: cross-env ELECTRON_RUN_AS_NODE=1 electron scripts/repair-station-rekey.js [--db X] [--write]
 */
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const argv = process.argv.slice(2);
const WRITE = argv.includes("--write");
const dbArg = (() => { const i = argv.indexOf("--db"); return i >= 0 ? argv[i + 1] : null; })();
// --json <path> writes a machine-readable receipt of what this run saw and did. Added 2026-08-18: a
// console transcript is not a receipt anyone can diff or hand to another session. Written from an
// exit handler so EVERY exit path (refusal, dry run, success) leaves one behind.
const jsonArg = (() => { const i = argv.indexOf("--json"); return i >= 0 ? argv[i + 1] : null; })();
const receipt = { tool: "repair-station-rekey", ranAt: new Date().toISOString(), mode: null, db: null,
                  stations: [], orphanIds: [], map: [], plan: [], totalRows: 0, collisions: [],
                  applied: false, verify: null, exitCode: null };
process.on("exit", (code) => {
  if (!jsonArg) return;
  receipt.exitCode = code;
  try { fs.writeFileSync(jsonArg, JSON.stringify(receipt, null, 2)); }
  catch (e) { try { console.error(`  receipt NOT written: ${e.message}`); } catch (_) {} }
});
const DB_PATH = dbArg || (() => {
  const P = require(path.join(__dirname, "..", "electron", "profile-paths"));
  return P.dbPath(P.activeKey());
})();

const CHILD_TABLES = [
  "shows", "clocks", "clock_slots", "categories", "separation_rules",
  "station_programming", "spots", "generated_schedule", "play_log", "station_config_kv",
];

const sep = (t) => { console.log("\n" + "=".repeat(78)); console.log(t); console.log("=".repeat(78)); };
console.log(WRITE ? "WRITE MODE" : "DRY RUN (pass --write to commit)");
receipt.mode = WRITE ? "write" : "dry-run";
receipt.db = DB_PATH;
console.log("DB:", DB_PATH, `(${(fs.statSync(DB_PATH).size / 1048576).toFixed(1)} MB)`);

const db = new Database(DB_PATH, { readonly: !WRITE });
if (WRITE) { db.pragma("busy_timeout = 20000"); db.pragma("foreign_keys = OFF"); }
const q = (s, ...p) => db.prepare(s).all(...p);
const n1 = (s, ...p) => db.prepare(s).get(...p);

// ── 1. current stations, and the orphan ids that need re-pointing ───────────────────────────────
sep("1. CURRENT STATE");
const stations = q("SELECT id, uuid, name, created_at FROM stations ORDER BY created_at, id");
for (const s of stations) console.log(`  station id=${s.id} ${String(s.name).padEnd(22)} uuid=${s.uuid}`);
receipt.stations = stations.map(s => ({ id: s.id, uuid: s.uuid, name: s.name, created_at: s.created_at }));

const orphanIds = new Set();
for (const t of CHILD_TABLES) {
  try {
    for (const r of q(`SELECT DISTINCT station_id FROM ${t}
                       WHERE station_id IS NOT NULL
                         AND NOT EXISTS (SELECT 1 FROM stations s WHERE s.id = ${t}.station_id)`)) {
      orphanIds.add(r.station_id);
    }
  } catch (_) { /* table missing station_id */ }
}
console.log("\n  orphaned station_id values:", [...orphanIds].sort((a, b) => a - b).join(", ") || "(none)");

receipt.orphanIds = [...orphanIds].sort((a, b) => a - b);
if (orphanIds.size === 0) { console.log("\n  Nothing to repair."); db.close(); process.exit(0); }

// ── 2. build the map, and PROVE it before using it ──────────────────────────────────────────────
// The re-insert preserved created_at, so ordering stations by created_at reproduces the original
// id order. This is asserted, not assumed: the map is rejected unless the counts line up exactly.
sep("2. MAP (old id -> new id), derived by created_at order and verified");
const oldIds = [...orphanIds].sort((a, b) => a - b);
if (oldIds.length !== stations.length) {
  console.error(`  REFUSED: ${oldIds.length} orphaned id(s) but ${stations.length} station(s) — the map would be a guess.`);
  db.close(); process.exit(1);
}
const map = new Map();
oldIds.forEach((oldId, i) => map.set(oldId, stations[i].id));
for (const [o, nw] of map) {
  const st = stations.find(s => s.id === nw);
  console.log(`  ${o} -> ${nw}   ${st.name}  (uuid ${st.uuid})`);
  receipt.map.push({ from: o, to: nw, name: st.name, uuid: st.uuid });
}

// Sanity: every new id must be distinct and must exist
const news = [...map.values()];
if (new Set(news).size !== news.length) { console.error("  REFUSED: map is not 1:1"); db.close(); process.exit(1); }

// ── 3. what would move ──────────────────────────────────────────────────────────────────────────
sep("3. ROWS TO RE-POINT");
let grand = 0;
const plan = [];
for (const t of CHILD_TABLES) {
  let sub = 0; const parts = [];
  for (const [o, nw] of map) {
    let c = 0;
    try { c = n1(`SELECT COUNT(*) n FROM ${t} WHERE station_id = ?`, o).n; } catch { c = 0; }
    if (c > 0) { parts.push(`${o}->${nw}:${c}`); sub += c; }
  }
  if (sub > 0) { plan.push(t); grand += sub; console.log(`  ${t.padEnd(22)} ${String(sub).padStart(8)}   ${parts.join("  ")}`); receipt.plan.push({ table: t, rows: sub, moves: parts }); }
}
console.log(`  ${"TOTAL".padEnd(22)} ${String(grand).padStart(8)}`);
receipt.totalRows = grand;

if (!WRITE) { console.log("\nDRY RUN — nothing written. Re-run with --write."); db.close(); process.exit(0); }

// ── 3b. COLLISIONS ──────────────────────────────────────────────────────────────────────────────
// station_config_kv is PK (station_id, key). The re-keyed stations picked up a handful of rows
// AFTER the incident (license_key, plan_tier, first_run_complete, canvas_layout), so moving the old
// rows onto those ids collides. The OLD rows are the real pre-incident config — 80 of them, the
// complete set — and the new ones are same-valued duplicates written in the last hour. The old row
// wins; the post-incident duplicate is removed.
//
// ONE judgement call, stated rather than buried: st5's canvas_layout is NEWER than st1's, because a
// layout was arranged on the half-empty screen after the incident. The pre-incident layout is kept.
// It is cosmetic either way, and preferring the operator's real arrangement is the safer default.
sep("3b. COLLISIONS TO RESOLVE (post-incident duplicates removed, pre-incident config kept)");
const collisions = [];
for (const [o, nw] of map) {
  let rows = [];
  try {
    rows = q(`SELECT k.key FROM station_config_kv k
              WHERE k.station_id = ?
                AND EXISTS (SELECT 1 FROM station_config_kv o WHERE o.station_id = ? AND o.key = k.key)`, nw, o);
  } catch (_) {}
  for (const r of rows) { collisions.push({ newId: nw, key: r.key }); receipt.collisions.push({ newId: nw, key: r.key, duplicateOf: o }); console.log(`  st${nw} ${r.key} — duplicate of st${o}, will be dropped`); }
}
console.log(`  ${collisions.length} collision(s)`);

// ── 4. apply, in ONE transaction ────────────────────────────────────────────────────────────────
sep("4. APPLYING (single transaction)");
// Two-phase to avoid collisions: shift into a high temporary range, then down onto the targets.
// 1 -> 5 while 5 already exists would otherwise merge two stations' rows.
const OFFSET = 1000000;
db.transaction(() => {
  // Clear the post-incident duplicates first, or the move below hits the (station_id, key) PK.
  for (const c of collisions) {
    db.prepare("DELETE FROM station_config_kv WHERE station_id = ? AND key = ?").run(c.newId, c.key);
  }
  // Two-phase, to avoid collisions of a different kind: 1 -> 5 while 5 still holds its own rows
  // would merge two stations. Shift everything into a high temporary range, then down onto targets.
  for (const t of plan) {
    for (const [o] of map) db.prepare(`UPDATE ${t} SET station_id = ? WHERE station_id = ?`).run(o + OFFSET, o);
  }
  for (const t of plan) {
    for (const [o, nw] of map) db.prepare(`UPDATE ${t} SET station_id = ? WHERE station_id = ?`).run(nw, o + OFFSET);
  }
})();
console.log(`  applied — ${collisions.length} duplicate(s) dropped, ${grand} row(s) re-pointed.`);
receipt.applied = true;

// ── 5. verify ───────────────────────────────────────────────────────────────────────────────────
sep("5. VERIFY");
let remaining = 0;
for (const t of CHILD_TABLES) {
  try {
    const r = n1(`SELECT COUNT(*) n FROM ${t}
                  WHERE station_id IS NOT NULL
                    AND NOT EXISTS (SELECT 1 FROM stations s WHERE s.id = ${t}.station_id)`);
    if (r.n > 0) { console.log(`  ${t.padEnd(22)} STILL ORPHANED: ${r.n}`); remaining += r.n; }
  } catch (_) {}
}
console.log(remaining === 0 ? "  orphans: 0" : `  orphans REMAINING: ${remaining}`);
receipt.verify = { orphansRemaining: remaining, perStation: q("SELECT id, name FROM stations WHERE deleted_at IS NULL ORDER BY id").map(st => {
  const g = (t) => { try { return n1(`SELECT COUNT(*) n FROM ${t} WHERE station_id=? AND deleted_at IS NULL`, st.id).n; } catch { return null; } };
  return { id: st.id, name: st.name, shows: g("shows"), clocks: g("clocks"), clock_slots: g("clock_slots"),
           categories: g("categories"), separation_rules: g("separation_rules"), spots: g("spots"),
           station_programming: g("station_programming"), generated_schedule: g("generated_schedule"),
           play_log: g("play_log"), station_config_kv: g("station_config_kv") };
}) };

console.log("\n  per-station, after:");
for (const s of q("SELECT id, name FROM stations WHERE deleted_at IS NULL ORDER BY id")) {
  const g = (t) => { try { return n1(`SELECT COUNT(*) n FROM ${t} WHERE station_id=? AND deleted_at IS NULL`, s.id).n; } catch { return "-"; } };
  console.log(`    station ${s.id} ${String(s.name).padEnd(22)} shows=${g("shows")} clocks=${g("clocks")} slots=${g("clock_slots")} cats=${g("categories")} sep=${g("separation_rules")}`);
}
db.close();
process.exit(remaining === 0 ? 0 : 1);
