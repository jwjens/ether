// scripts/backfill-uuids.js — backfill NULL uuid values across all 27 target tables
//
// Run with: node_modules/.bin/electron --no-sandbox scripts/backfill-uuids.js
// IMPORTANT: Stop the Ether dev server before running.
//
// Pre-condition: uuid columns already exist on all 27 tables (added by migrate-uuids-phase-sync-1.js).
// This script ONLY writes UUIDs to rows where uuid IS NULL.
// It does NOT ALTER tables, create indexes, or touch schema_version.

const path   = require("path");
const os     = require("os");
const fs     = require("fs");
const crypto = require("crypto");

// ── Table definitions ─────────────────────────────────────────
// pk:      column name(s) to use in WHERE clause — never rowid
// pkCols:  array for composite PKs, single-element for simple PKs

const TABLES = [
  { name: "albums",               pkCols: ["id"] },
  { name: "announcements",        pkCols: ["id"] },
  { name: "artists",              pkCols: ["id"] },
  { name: "cart_slots",           pkCols: ["id"] },
  { name: "categories",           pkCols: ["id"] },
  { name: "clock_slots",          pkCols: ["id"] },
  { name: "clocks",               pkCols: ["id"] },
  { name: "deck_configs",         pkCols: ["slot"] },           // PK is slot, not id
  { name: "format_clocks",        pkCols: ["id"] },
  { name: "generated_schedule",   pkCols: ["id"] },
  { name: "liner_cards",          pkCols: ["id"] },
  { name: "macros",               pkCols: ["id"] },
  { name: "operator_notes",       pkCols: ["id"] },
  { name: "operators",            pkCols: ["id"] },
  { name: "play_log",             pkCols: ["id"] },
  { name: "prep_notes",           pkCols: ["id"] },
  { name: "published_episodes",   pkCols: ["id"] },
  { name: "rtmp_destinations",    pkCols: ["id"] },
  { name: "scheduled_log",        pkCols: ["id"] },
  { name: "separation_rules",     pkCols: ["id"] },
  { name: "shows",                pkCols: ["id"] },
  { name: "smart_schedule_rules", pkCols: ["id"] },
  { name: "songs",                pkCols: ["id"] },
  { name: "spots",                pkCols: ["id"] },
  { name: "station_config_kv",    pkCols: ["station_id", "key"] }, // composite PK
  { name: "voice_tracks",         pkCols: ["id"] },
  { name: "stations",             pkCols: ["id"] },
];

// ── DB path ───────────────────────────────────────────────────

const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
const dbPath  = path.join(appData, "com.ether.radio", "openair.db");

console.log("[backfill-uuids] DB path:", dbPath);
console.log("");

if (!fs.existsSync(dbPath)) {
  console.error("[backfill-uuids] ERROR: DB not found at", dbPath);
  process.exit(1);
}

const Database = require(path.join(__dirname, "../node_modules/better-sqlite3"));
const db = new Database(dbPath);

// ── Helpers ───────────────────────────────────────────────────

function getNullCount(tableName) {
  return db.prepare(`SELECT COUNT(*) AS c FROM "${tableName}" WHERE uuid IS NULL`).get().c;
}

function abort(msg) {
  console.error(`\n[backfill-uuids] ABORT: ${msg}`);
  db.close();
  process.exit(1);
}

// ── Atomic backfill transaction ───────────────────────────────

console.log("═".repeat(60));
console.log("BACKFILL UUIDs");
console.log("═".repeat(60));
console.log("");

const backfill = db.transaction(() => {
  for (const { name, pkCols } of TABLES) {

    // Build SELECT: fetch PK column(s) for rows with NULL uuid
    const selectSql = `SELECT ${pkCols.map(c => `"${c}"`).join(", ")} FROM "${name}" WHERE uuid IS NULL`;
    const rows = db.prepare(selectSql).all();

    if (rows.length === 0) {
      console.log(`[backfill-uuids] SKIP   "${name}" — 0 NULL uuids, nothing to do`);
      continue;
    }

    // Build UPDATE: SET uuid = ? WHERE pk1 = ? [AND pk2 = ?]
    const whereParts = pkCols.map(c => `"${c}" = ?`).join(" AND ");
    const updateStmt = db.prepare(`UPDATE "${name}" SET uuid = ? WHERE ${whereParts}`);

    let updated = 0;
    for (const row of rows) {
      const uuid    = crypto.randomUUID();
      const pkVals  = pkCols.map(c => row[c]);
      const result  = updateStmt.run(uuid, ...pkVals);
      updated += result.changes;
    }

    console.log(`[backfill-uuids] FILL   "${name}" — ${updated} row(s) updated`);
  }
});

try {
  backfill();
  console.log("");
  console.log("[backfill-uuids] Transaction committed.");
} catch (err) {
  console.error("\n[backfill-uuids] ERROR — transaction rolled back:", err.message);
  db.close();
  process.exit(1);
}

// ── Verification ──────────────────────────────────────────────

console.log("");
console.log("═".repeat(60));
console.log("VERIFICATION");
console.log("═".repeat(60));
console.log("");

let allOk = true;

for (const { name } of TABLES) {
  const remaining = getNullCount(name);
  if (remaining > 0) {
    console.error(`[backfill-uuids] ✗ "${name}" — ${remaining} NULL uuid(s) still present`);
    allOk = false;
  } else {
    console.log(`[backfill-uuids] ✓ "${name}" — 0 NULL uuids`);
  }
}

console.log("");

if (!allOk) {
  abort("one or more tables still have NULL uuid values after backfill.");
}

console.log("[backfill-uuids] All 27 tables fully backfilled. ✓");
db.close();
process.exit(0);
