// scripts/migrate-uuids-phase-sync-1.js — Phase Sync-1: add UUID columns to all station-scoped tables
//
// Run with: node_modules/.bin/electron --no-sandbox scripts/migrate-uuids-phase-sync-1.js
// IMPORTANT: Stop the Ether dev server before running.
//
// What it does (single atomic transaction):
//   1. Writes scripts/pre-uuid-snapshot.txt  — column lists + row counts for all 27 targets
//   2. Checks schema_version: if version=1 already exists, ABORTs (idempotent)
//   3. Transaction:
//        a. ALTER TABLE … ADD COLUMN uuid TEXT  (nullable) on each of 27 tables
//        b. Backfills every existing row with crypto.randomUUID()
//        c. CREATE UNIQUE INDEX idx_{table}_uuid on each table
//        d. INSERT version=1 into schema_version
//   4. Writes scripts/post-uuid-snapshot.txt
//   5. Verifies: uuid column present, no NULLs, no duplicates, schema_version=1, row counts unchanged

const path   = require("path");
const os     = require("os");
const fs     = require("fs");
const crypto = require("crypto");

// ── Target tables ─────────────────────────────────────────────
// 26 station-scoped + 1 parent (stations)

const SCOPED_TABLES = [
  "albums",
  "announcements",
  "artists",
  "cart_slots",
  "categories",
  "clock_slots",
  "clocks",
  "deck_configs",
  "format_clocks",
  "generated_schedule",
  "liner_cards",
  "macros",
  "operator_notes",
  "operators",
  "play_log",
  "prep_notes",
  "published_episodes",
  "rtmp_destinations",
  "scheduled_log",
  "separation_rules",
  "shows",
  "smart_schedule_rules",
  "songs",
  "spots",
  "station_config_kv",
  "voice_tracks",
];

const PARENT_TABLES = [
  "stations",
];

const ALL_TABLES = [...SCOPED_TABLES, ...PARENT_TABLES];

// ── DB path (mirrors electron/main.js getDbPath) ─────────────

const appData    = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
const dbPath     = path.join(appData, "com.ether.radio", "openair.db");
const scriptDir  = path.join(__dirname);

// ── Helpers ───────────────────────────────────────────────────

function getTableCols(db, tableName) {
  return db.prepare(`PRAGMA table_info("${tableName}")`).all().map(c => c.name);
}

function getRowCount(db, tableName) {
  try {
    return db.prepare(`SELECT COUNT(*) AS c FROM "${tableName}"`).get().c;
  } catch {
    return -1;
  }
}

function buildSnapshot(db, label) {
  const lines = [
    `UUID migration snapshot — ${label}`,
    `Generated: ${new Date().toISOString()}`,
    `Tables: ${ALL_TABLES.length}`,
    "",
    "table_name                     | row_count | columns",
    "-".repeat(100),
  ];

  for (const table of ALL_TABLES) {
    const cols  = getTableCols(db, table);
    const count = getRowCount(db, table);
    lines.push(`${table.padEnd(30)} | ${String(count).padEnd(9)} | ${cols.join(", ")}`);
  }

  return lines.join("\n") + "\n";
}

function abort(msg) {
  console.error(`\n[migrate-uuids] ABORT: ${msg}`);
  process.exit(1);
}

module.exports = {
  payloadTransformer: function payloadTransformer(payload, fromVersion) {
    return payload;
  },
};

if (require.main === module) {

// ── Startup ───────────────────────────────────────────────────

console.log("[migrate-uuids] DB path:", dbPath);
console.log("");

if (!fs.existsSync(dbPath)) {
  abort("DB not found at " + dbPath);
}

const Database = require(path.join(__dirname, "../node_modules/better-sqlite3"));
const db = new Database(dbPath);

// ── Pre-migration snapshot ────────────────────────────────────

console.log("═".repeat(60));
console.log("PRE-MIGRATION SNAPSHOT");
console.log("═".repeat(60));

const preText = buildSnapshot(db, "PRE-MIGRATION");
const preFile = path.join(scriptDir, "pre-uuid-snapshot.txt");
fs.writeFileSync(preFile, preText, "utf8");
console.log(preText);
console.log(`[migrate-uuids] Pre-migration snapshot written to ${preFile}`);

// Capture row counts now for post-migration comparison
const preRowCounts = {};
for (const table of ALL_TABLES) {
  preRowCounts[table] = getRowCount(db, table);
}

// ── Idempotency check ─────────────────────────────────────────

console.log("");
console.log("═".repeat(60));
console.log("IDEMPOTENCY CHECK");
console.log("═".repeat(60));

const schemaVersionRow = db.prepare(
  "SELECT version FROM schema_version WHERE version = 1"
).get();

if (schemaVersionRow) {
  console.error("[migrate-uuids] ABORT: migration already applied — schema_version contains version=1.");
  db.close();
  process.exit(1);
}

console.log("[migrate-uuids] schema_version: version=1 not present — safe to proceed.");

// ── Atomic migration transaction ──────────────────────────────

console.log("");
console.log("═".repeat(60));
console.log("RUNNING MIGRATION");
console.log("═".repeat(60));
console.log("");

const migrate = db.transaction(() => {

  // ── Step A: ADD COLUMN uuid TEXT ────────────────────────────
  console.log("─── Step A: ADD COLUMN uuid TEXT ───");
  for (const table of ALL_TABLES) {
    const cols = getTableCols(db, table);
    if (cols.includes("uuid")) {
      console.log(`[migrate-uuids] ALTER  "${table}" — uuid column already exists, skipping ADD`);
    } else {
      db.prepare(`ALTER TABLE "${table}" ADD COLUMN uuid TEXT`).run();
      console.log(`[migrate-uuids] ALTER  "${table}" — uuid column added`);
    }
  }

  console.log("");

  // ── Step B: Backfill UUIDs ──────────────────────────────────
  console.log("─── Step B: Backfill UUIDs ───");
  for (const table of ALL_TABLES) {
    // Fetch all row ids that need a UUID (uuid IS NULL)
    const rows = db.prepare(`SELECT rowid FROM "${table}" WHERE uuid IS NULL`).all();

    if (rows.length === 0) {
      console.log(`[migrate-uuids] FILL   "${table}" — 0 rows to backfill`);
      continue;
    }

    const stmtUpdate = db.prepare(`UPDATE "${table}" SET uuid = ? WHERE rowid = ?`);
    for (const row of rows) {
      stmtUpdate.run(crypto.randomUUID(), row.rowid);
    }

    console.log(`[migrate-uuids] FILL   "${table}" — backfilled ${rows.length} row(s)`);
  }

  console.log("");

  // ── Step C: CREATE UNIQUE INDEX ─────────────────────────────
  console.log("─── Step C: CREATE UNIQUE INDEX ───");
  for (const table of ALL_TABLES) {
    const indexName = `idx_${table}_uuid`;

    // Check if index already exists
    const existing = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name=?"
    ).get(indexName);

    if (existing) {
      console.log(`[migrate-uuids] INDEX  "${table}" — index "${indexName}" already exists, skipping`);
    } else {
      db.prepare(`CREATE UNIQUE INDEX "${indexName}" ON "${table}"(uuid)`).run();
      console.log(`[migrate-uuids] INDEX  "${table}" — created "${indexName}"`);
    }
  }

  console.log("");

  // ── Step D: Mark schema_version ─────────────────────────────
  console.log("─── Step D: INSERT schema_version = 1 ───");
  db.prepare("INSERT INTO schema_version (version) VALUES (1)").run();
  console.log("[migrate-uuids] schema_version row inserted.");

});

try {
  migrate();
  console.log("");
  console.log("[migrate-uuids] Transaction committed.");
} catch (err) {
  console.error("\n[migrate-uuids] ERROR — transaction rolled back:", err.message);
  db.close();
  process.exit(1);
}

// ── Post-migration snapshot ───────────────────────────────────

console.log("");
console.log("═".repeat(60));
console.log("POST-MIGRATION SNAPSHOT");
console.log("═".repeat(60));

const postText = buildSnapshot(db, "POST-MIGRATION");
const postFile = path.join(scriptDir, "post-uuid-snapshot.txt");
fs.writeFileSync(postFile, postText, "utf8");
console.log(postText);
console.log(`[migrate-uuids] Post-migration snapshot written to ${postFile}`);

// ── Verification ──────────────────────────────────────────────

console.log("");
console.log("═".repeat(60));
console.log("VERIFICATION");
console.log("═".repeat(60));

let allOk = true;

for (const table of ALL_TABLES) {

  // Check 1: uuid column exists
  const cols = getTableCols(db, table);
  if (!cols.includes("uuid")) {
    console.error(`[migrate-uuids] ✗ "${table}" — uuid column MISSING`);
    allOk = false;
    continue;
  }

  // Check 2: no NULL uuids
  const nullCount = db.prepare(
    `SELECT COUNT(*) AS c FROM "${table}" WHERE uuid IS NULL`
  ).get().c;
  if (nullCount > 0) {
    console.error(`[migrate-uuids] ✗ "${table}" — ${nullCount} NULL uuid value(s) found`);
    allOk = false;
    continue;
  }

  // Check 3: no duplicate uuids
  const dupCount = db.prepare(
    `SELECT COUNT(*) AS c FROM (SELECT uuid FROM "${table}" GROUP BY uuid HAVING COUNT(*) > 1)`
  ).get().c;
  if (dupCount > 0) {
    console.error(`[migrate-uuids] ✗ "${table}" — ${dupCount} duplicate uuid value(s) found`);
    allOk = false;
    continue;
  }

  // Check 4: row count unchanged
  const postCount = getRowCount(db, table);
  const preCount  = preRowCounts[table];
  if (postCount !== preCount) {
    console.error(`[migrate-uuids] ✗ "${table}" — row count changed: ${preCount} → ${postCount}`);
    allOk = false;
    continue;
  }

  console.log(
    `[migrate-uuids] ✓ "${table}" — uuid column present, ${postCount} row(s), no NULLs, no duplicates`
  );
}

// Check 5: schema_version contains version=1
const svRow = db.prepare("SELECT version FROM schema_version WHERE version = 1").get();
if (!svRow) {
  console.error("[migrate-uuids] ✗ schema_version — version=1 row NOT found");
  allOk = false;
} else {
  console.log("[migrate-uuids] ✓ schema_version — version=1 confirmed");
}

console.log("");

if (!allOk) {
  console.error("[migrate-uuids] ABORT: one or more verification checks FAILED.");
  console.error("[migrate-uuids] Snapshot files written to scripts/ for manual inspection.");
  db.close();
  process.exit(1);
}

console.log("[migrate-uuids] All verifications passed. UUID migration complete. ✓");
db.close();
process.exit(0);

}
