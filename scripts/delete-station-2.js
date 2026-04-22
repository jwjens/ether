// scripts/delete-station-2.js — Phase 3c: delete Station 2 (US Phenomenon) from DB
//
// Run with: node_modules/.bin/electron --no-sandbox scripts/delete-station-2.js
// IMPORTANT: Stop the Ether dev server before running.
//
// Safety: aborts if active_station_id != 1. Never deletes the active station.

const path = require("path");
const os   = require("os");
const fs   = require("fs");

const DELETE_STATION_ID = 2;
const EXPECTED_ACTIVE   = 1;

const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
const dbPath  = path.join(appData, "com.ether.radio", "openair.db");

console.log("[delete-station-2] DB path:", dbPath);
console.log("");

if (!fs.existsSync(dbPath)) {
  console.error("[delete-station-2] ERROR: DB not found at", dbPath);
  process.exit(1);
}

const Database = require(path.join(__dirname, "../node_modules/better-sqlite3"));
const db = new Database(dbPath);

// ── Pre-check ─────────────────────────────────────────────────

const kvRow = db.prepare(
  "SELECT value FROM station_config_kv WHERE key = 'active_station_id' AND station_id = 0"
).get();
const activeId = kvRow ? parseInt(kvRow.value, 10) : null;

console.log(`[delete-station-2] active_station_id in station_config_kv: ${activeId}`);

if (activeId !== EXPECTED_ACTIVE) {
  console.error(
    `[delete-station-2] ABORT: active_station_id is ${activeId}, expected ${EXPECTED_ACTIVE}. ` +
    `Never delete the active station.`
  );
  db.close();
  process.exit(1);
}
console.log(`[delete-station-2] ✓ active_station_id = ${activeId} — safe to proceed\n`);

console.log("Stations BEFORE:");
const before = db.prepare("SELECT id, name, is_active FROM stations ORDER BY id").all();
for (const r of before) {
  console.log(`  id=${r.id}  is_active=${r.is_active}  name="${r.name}"`);
}

const targetStation = before.find(s => s.id === DELETE_STATION_ID);
if (!targetStation) {
  console.log(`\n[delete-station-2] Station id=${DELETE_STATION_ID} not found — nothing to do.`);
  db.close();
  process.exit(0);
}
console.log(`\n[delete-station-2] Will delete: id=${targetStation.id} "${targetStation.name}"\n`);

// ── Scoped tables to purge ────────────────────────────────────
// All 25 station-scoped tables + station_config_kv.
// Order chosen to respect FK constraints (dependents before parents where applicable).

const SCOPED_TABLES = [
  "clock_slots",          // references clocks
  "cart_slots",           // references spots
  "operator_notes",       // references operators
  "songs",
  "artists",
  "albums",
  "categories",
  "separation_rules",
  "clocks",
  "shows",
  "play_log",
  "scheduled_log",
  "spots",
  "announcements",
  "voice_tracks",
  "smart_schedule_rules",
  "liner_cards",
  "prep_notes",
  "published_episodes",
  "format_clocks",
  "generated_schedule",
  "operators",
  "deck_configs",
  "macros",
  "rtmp_destinations",
  "station_config_kv",    // KV rows scoped to station 2
];

// ── Atomic transaction ────────────────────────────────────────

console.log("═".repeat(60));
console.log("RUNNING DELETION TRANSACTION");
console.log("═".repeat(60));

const deleteAll = db.transaction(() => {
  const deletedCounts = {};

  // Purge all scoped tables
  for (const table of SCOPED_TABLES) {
    const col = table === "station_config_kv" ? "station_id" : "station_id";
    const result = db.prepare(
      `DELETE FROM ${table} WHERE station_id = ?`
    ).run(DELETE_STATION_ID);
    deletedCounts[table] = result.changes;
    const indicator = result.changes > 0 ? `⚠ ${result.changes} row(s) deleted` : "0 rows (empty, as expected)";
    console.log(`  [delete-station-2] ${table.padEnd(25)} → ${indicator}`);
  }

  // Delete the station row itself
  const stationResult = db.prepare(
    "DELETE FROM stations WHERE id = ?"
  ).run(DELETE_STATION_ID);
  console.log(`  [delete-station-2] ${"stations".padEnd(25)} → ${stationResult.changes} row deleted`);
  deletedCounts["stations"] = stationResult.changes;

  return deletedCounts;
});

let deletedCounts;
try {
  deletedCounts = deleteAll();
  console.log(`\n[delete-station-2] Transaction committed.\n`);
} catch (err) {
  console.error("\n[delete-station-2] ERROR — transaction rolled back:", err.message);
  db.close();
  process.exit(1);
}

// ── Post-check ────────────────────────────────────────────────

console.log("Stations AFTER:");
const after = db.prepare("SELECT id, name, is_active FROM stations ORDER BY id").all();
for (const r of after) {
  console.log(`  id=${r.id}  is_active=${r.is_active}  name="${r.name}"`);
}

if (after.find(s => s.id === DELETE_STATION_ID)) {
  console.error(`\n[delete-station-2] VERIFICATION FAILED: station id=${DELETE_STATION_ID} still exists in stations table.`);
  db.close();
  process.exit(1);
}
console.log(`\n[delete-station-2] ✓ Station id=${DELETE_STATION_ID} no longer in stations table\n`);

// ── Verification: confirm no orphaned rows remain ─────────────

console.log("═".repeat(60));
console.log("VERIFICATION: checking for orphaned rows at station_id=2");
console.log("═".repeat(60));

let anyOrphans = false;
const ALL_CHECK_TABLES = [...SCOPED_TABLES.filter(t => t !== "station_config_kv"), "station_config_kv"];
for (const table of ALL_CHECK_TABLES) {
  const row = db.prepare(`SELECT COUNT(*) as c FROM ${table} WHERE station_id = ?`).get(DELETE_STATION_ID);
  if (row.c > 0) {
    console.error(`  [delete-station-2] ✗ ORPHANS FOUND: ${table} still has ${row.c} row(s) with station_id=${DELETE_STATION_ID}`);
    anyOrphans = true;
  }
}

if (anyOrphans) {
  console.error("\n[delete-station-2] VERIFICATION FAILED — orphaned rows remain. Investigate before proceeding.");
  db.close();
  process.exit(1);
}

console.log(`[delete-station-2] ✓ No orphaned rows found in any table\n`);
console.log("[delete-station-2] Station 2 deleted cleanly. ✓");

db.close();
process.exit(0);
