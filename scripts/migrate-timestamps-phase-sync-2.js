// scripts/migrate-timestamps-phase-sync-2.js — Phase Sync-2: add created_at / updated_at / deleted_at to all 27 tables
//
// Run with: node_modules/.bin/electron --no-sandbox scripts/migrate-timestamps-phase-sync-2.js
// IMPORTANT: Stop the Ether dev server before running.
//
// What it does (single atomic transaction):
//   1. Writes scripts/pre-timestamps-snapshot.txt  — column lists + row counts for all 27 targets
//   2. Checks schema_version: if version=2 already exists, ABORTs (idempotent)
//   3. Transaction:
//        Phase A — ALTER TABLE ADD COLUMN created_at/updated_at/deleted_at TEXT on each table (skip if present)
//        Phase B — Backfill created_at (from domain column or migration constant); backfill updated_at = created_at
//        Phase C — INSERT version=2 into schema_version
//   4. Writes scripts/post-timestamps-snapshot.txt
//   5. Verifies: all 3 columns present, zero NULL created_at/updated_at, deleted_at all NULL,
//                created_at/updated_at values are valid ISO dates, row counts unchanged, schema_version=2

const path   = require("path");
const os     = require("os");
const fs     = require("fs");

// ── Table definitions ─────────────────────────────────────────
//
// pkCols:         explicit PK column(s) — never rowid
// createdAtSource: domain column to copy into created_at (per-row); null = use migration constant

const TABLES = [
  { name: "albums",               pkCols: ["id"],                createdAtSource: null           },
  { name: "announcements",        pkCols: ["id"],                createdAtSource: null           },
  { name: "artists",              pkCols: ["id"],                createdAtSource: null           },
  { name: "cart_slots",           pkCols: ["id"],                createdAtSource: null           },
  { name: "categories",           pkCols: ["id"],                createdAtSource: null           },
  { name: "clock_slots",          pkCols: ["id"],                createdAtSource: null           },
  { name: "clocks",               pkCols: ["id"],                createdAtSource: null           },
  { name: "deck_configs",         pkCols: ["slot"],              createdAtSource: null           },
  { name: "format_clocks",        pkCols: ["id"],                createdAtSource: null           },
  { name: "generated_schedule",   pkCols: ["id"],                createdAtSource: "generated_at" },
  { name: "liner_cards",          pkCols: ["id"],                createdAtSource: null           },
  { name: "macros",               pkCols: ["id"],                createdAtSource: null           },
  { name: "operator_notes",       pkCols: ["id"],                createdAtSource: null           },
  { name: "operators",            pkCols: ["id"],                createdAtSource: null           },
  { name: "play_log",             pkCols: ["id"],                createdAtSource: "played_at"    },
  { name: "prep_notes",           pkCols: ["id"],                createdAtSource: null           },
  { name: "published_episodes",   pkCols: ["id"],                createdAtSource: "published_at" },
  { name: "rtmp_destinations",    pkCols: ["id"],                createdAtSource: null           },
  { name: "scheduled_log",        pkCols: ["id"],                createdAtSource: null           },
  { name: "separation_rules",     pkCols: ["id"],                createdAtSource: null           },
  { name: "shows",                pkCols: ["id"],                createdAtSource: null           },
  { name: "smart_schedule_rules", pkCols: ["id"],                createdAtSource: null           },
  { name: "songs",                pkCols: ["id"],                createdAtSource: null           },
  { name: "spots",                pkCols: ["id"],                createdAtSource: null           },
  { name: "station_config_kv",    pkCols: ["station_id", "key"], createdAtSource: null           },
  { name: "voice_tracks",         pkCols: ["id"],                createdAtSource: "recorded_at"  },
  { name: "stations",             pkCols: ["id"],                createdAtSource: null           },
];

const TIMESTAMP_COLS = ["created_at", "updated_at", "deleted_at"];

// ── DB path ───────────────────────────────────────────────────

const appData   = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
const dbPath    = path.join(appData, "com.ether.radio", "openair.db");
const scriptDir = path.join(__dirname);

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
    `Timestamp migration snapshot — ${label}`,
    `Generated: ${new Date().toISOString()}`,
    `Tables: ${TABLES.length}`,
    "",
    "table_name                     | row_count | columns",
    "-".repeat(110),
  ];
  for (const { name } of TABLES) {
    const cols  = getTableCols(db, name);
    const count = getRowCount(db, name);
    lines.push(`${name.padEnd(30)} | ${String(count).padEnd(9)} | ${cols.join(", ")}`);
  }
  return lines.join("\n") + "\n";
}

// Detect whether a source column stores epoch-ms integers, epoch-s integers, or ISO strings.
// Returns "epoch_ms" | "epoch_s" | "iso"
function detectSourceFormat(db, tableName, sourceCol) {
  const sample = db.prepare(
    `SELECT "${sourceCol}" FROM "${tableName}" WHERE "${sourceCol}" IS NOT NULL LIMIT 1`
  ).get();
  if (!sample) return "iso"; // no rows, doesn't matter

  const val = sample[sourceCol];
  if (typeof val === "number") {
    return val > 1e12 ? "epoch_ms" : "epoch_s";
  }
  if (typeof val === "string" && /^\d+$/.test(val.trim())) {
    return parseInt(val, 10) > 1e12 ? "epoch_ms" : "epoch_s";
  }
  return "iso";
}

// Convert a raw source-column value to an ISO 8601 UTC string.
// Falls back to migrationTimestamp if the value is null/unparseable.
function convertToIso(val, format, fallback) {
  if (val === null || val === undefined) return fallback;
  try {
    if (format === "epoch_ms") {
      const ms = typeof val === "string" ? parseInt(val, 10) : val;
      return new Date(ms).toISOString();
    }
    if (format === "epoch_s") {
      const s = typeof val === "string" ? parseInt(val, 10) : val;
      return new Date(s * 1000).toISOString();
    }
    // iso — parse and re-serialize to normalise format
    const d = new Date(val);
    if (isNaN(d.getTime())) return fallback;
    return d.toISOString();
  } catch {
    return fallback;
  }
}

module.exports = {
  // [N-70] Migration 2 adds created_at/updated_at/deleted_at to all synced tables.
  // For v1 payloads missing these fields, inject defaults (wall-clock at receive time).
  // [Q-15] resolved: option α — wall-clock now. Semantically "when this row arrived"
  // which is the best truth available for backfilled rows from a v1 peer.
  payloadTransformer: function payloadTransformer(payload, fromVersion) {
    if (fromVersion !== 1) return payload;
    const now = new Date().toISOString();
    return {
      ...payload,
      created_at: payload.created_at ?? now,
      updated_at: payload.updated_at ?? now,
      deleted_at: payload.deleted_at ?? null,
    };
  },
};

if (require.main === module) {

// ── Startup ───────────────────────────────────────────────────

console.log("[migrate-timestamps] DB path:", dbPath);
console.log("");

if (!fs.existsSync(dbPath)) {
  console.error("[migrate-timestamps] ERROR: DB not found at", dbPath);
  process.exit(1);
}

const Database = require(path.join(__dirname, "../node_modules/better-sqlite3"));
const db = new Database(dbPath);

function abort(msg) {
  console.error(`\n[migrate-timestamps] ABORT: ${msg}`);
  db.close();
  process.exit(1);
}

// Single constant for the entire migration run — used for tables with no domain timestamp source.
const migrationTimestamp = new Date().toISOString();
console.log("[migrate-timestamps] Migration timestamp constant:", migrationTimestamp);
console.log("");

// ── Pre-migration snapshot ────────────────────────────────────

console.log("═".repeat(60));
console.log("PRE-MIGRATION SNAPSHOT");
console.log("═".repeat(60));

const preText = buildSnapshot(db, "PRE-MIGRATION");
const preFile = path.join(scriptDir, "pre-timestamps-snapshot.txt");
fs.writeFileSync(preFile, preText, "utf8");
console.log(preText);
console.log(`[migrate-timestamps] Pre-migration snapshot written to ${preFile}`);

const preRowCounts = {};
for (const { name } of TABLES) {
  preRowCounts[name] = getRowCount(db, name);
}

// ── Idempotency check ─────────────────────────────────────────

console.log("");
console.log("═".repeat(60));
console.log("IDEMPOTENCY CHECK");
console.log("═".repeat(60));

const schemaVersionRow = db.prepare(
  "SELECT version FROM schema_version WHERE version = 2"
).get();

if (schemaVersionRow) {
  console.error("[migrate-timestamps] ABORT: migration already applied — schema_version contains version=2.");
  db.close();
  process.exit(1);
}

console.log("[migrate-timestamps] schema_version: version=2 not present — safe to proceed.");

// ── Atomic migration transaction ──────────────────────────────

console.log("");
console.log("═".repeat(60));
console.log("RUNNING MIGRATION");
console.log("═".repeat(60));
console.log("");

const migrate = db.transaction(() => {

  // ── Phase A: ADD COLUMNS ─────────────────────────────────────
  console.log("─── Phase A: ADD COLUMNS ───");
  for (const { name } of TABLES) {
    const cols = getTableCols(db, name);
    for (const col of TIMESTAMP_COLS) {
      if (cols.includes(col)) {
        console.log(`[migrate-timestamps] SKIP   ALTER "${name}".${col} — column already exists`);
      } else {
        db.prepare(`ALTER TABLE "${name}" ADD COLUMN ${col} TEXT`).run();
        console.log(`[migrate-timestamps] ALTER  "${name}".${col} — column added`);
      }
    }
  }

  console.log("");

  // ── Phase B: BACKFILL ────────────────────────────────────────
  console.log("─── Phase B: BACKFILL created_at / updated_at ───");

  for (const { name, pkCols, createdAtSource } of TABLES) {
    let createdAtFilled = 0;
    let updatedAtFilled = 0;

    // B1: Backfill created_at (only NULL rows)
    if (createdAtSource) {
      // Per-row: copy from domain column, converting format as needed
      const format  = detectSourceFormat(db, name, createdAtSource);
      const selectSql = `SELECT ${pkCols.map(c => `"${c}"`).join(", ")}, "${createdAtSource}" FROM "${name}" WHERE created_at IS NULL`;
      const rows    = db.prepare(selectSql).all();

      if (rows.length > 0) {
        const whereParts = pkCols.map(c => `"${c}" = ?`).join(" AND ");
        const stmt = db.prepare(`UPDATE "${name}" SET created_at = ? WHERE ${whereParts}`);
        for (const row of rows) {
          const iso    = convertToIso(row[createdAtSource], format, migrationTimestamp);
          const pkVals = pkCols.map(c => row[c]);
          createdAtFilled += stmt.run(iso, ...pkVals).changes;
        }
      }
    } else {
      // Single-statement: set constant for all NULL rows
      const r = db.prepare(`UPDATE "${name}" SET created_at = ? WHERE created_at IS NULL`).run(migrationTimestamp);
      createdAtFilled = r.changes;
    }

    // B2: Backfill updated_at = created_at (only NULL rows, single SQL statement)
    // At this point created_at is already populated within this transaction,
    // so reading created_at here reflects the values we just wrote.
    const r2 = db.prepare(`UPDATE "${name}" SET updated_at = created_at WHERE updated_at IS NULL`).run();
    updatedAtFilled = r2.changes;

    console.log(`[migrate-timestamps] FILL   "${name}" — ${createdAtFilled} created_at, ${updatedAtFilled} updated_at`);
  }

  console.log("");

  // ── Phase C: Mark schema_version ─────────────────────────────
  console.log("─── Phase C: INSERT schema_version = 2 ───");
  db.prepare("INSERT INTO schema_version (version) VALUES (2)").run();
  console.log("[migrate-timestamps] schema_version row inserted.");

});

try {
  migrate();
  console.log("");
  console.log("[migrate-timestamps] Transaction committed.");
} catch (err) {
  console.error("\n[migrate-timestamps] ERROR — transaction rolled back:", err.message);
  db.close();
  process.exit(1);
}

// ── Post-migration snapshot ───────────────────────────────────

console.log("");
console.log("═".repeat(60));
console.log("POST-MIGRATION SNAPSHOT");
console.log("═".repeat(60));

const postText = buildSnapshot(db, "POST-MIGRATION");
const postFile = path.join(scriptDir, "post-timestamps-snapshot.txt");
fs.writeFileSync(postFile, postText, "utf8");
console.log(postText);
console.log(`[migrate-timestamps] Post-migration snapshot written to ${postFile}`);

// ── Verification ──────────────────────────────────────────────

console.log("");
console.log("═".repeat(60));
console.log("VERIFICATION");
console.log("═".repeat(60));
console.log("");

let allOk = true;

for (const { name } of TABLES) {

  // Check 1: all three columns present
  const cols = getTableCols(db, name);
  const missingCols = TIMESTAMP_COLS.filter(c => !cols.includes(c));
  if (missingCols.length > 0) {
    console.error(`[migrate-timestamps] ✗ "${name}" — missing columns: ${missingCols.join(", ")}`);
    allOk = false;
    continue;
  }

  // Check 2: zero NULL created_at
  const nullCreated = db.prepare(`SELECT COUNT(*) AS c FROM "${name}" WHERE created_at IS NULL`).get().c;
  if (nullCreated > 0) {
    console.error(`[migrate-timestamps] ✗ "${name}" — ${nullCreated} NULL created_at value(s)`);
    allOk = false;
    continue;
  }

  // Check 3: zero NULL updated_at
  const nullUpdated = db.prepare(`SELECT COUNT(*) AS c FROM "${name}" WHERE updated_at IS NULL`).get().c;
  if (nullUpdated > 0) {
    console.error(`[migrate-timestamps] ✗ "${name}" — ${nullUpdated} NULL updated_at value(s)`);
    allOk = false;
    continue;
  }

  // Check 4: deleted_at all NULL (sanity — we must not have set any)
  const nonNullDeleted = db.prepare(`SELECT COUNT(*) AS c FROM "${name}" WHERE deleted_at IS NOT NULL`).get().c;
  if (nonNullDeleted > 0) {
    console.error(`[migrate-timestamps] ✗ "${name}" — ${nonNullDeleted} unexpected non-NULL deleted_at value(s)`);
    allOk = false;
    continue;
  }

  // Check 5: created_at and updated_at values are valid ISO dates
  // Use GLOB to check for ISO 8601 shape: "YYYY-MM-DDTHH:MM:SS*"
  const badCreated = db.prepare(
    `SELECT COUNT(*) AS c FROM "${name}" WHERE created_at IS NOT NULL AND created_at NOT GLOB '????-??-??T??:??:??*'`
  ).get().c;
  const badUpdated = db.prepare(
    `SELECT COUNT(*) AS c FROM "${name}" WHERE updated_at IS NOT NULL AND updated_at NOT GLOB '????-??-??T??:??:??*'`
  ).get().c;
  if (badCreated > 0 || badUpdated > 0) {
    console.error(`[migrate-timestamps] ✗ "${name}" — malformed dates: ${badCreated} created_at, ${badUpdated} updated_at`);
    allOk = false;
    continue;
  }

  // Check 6: row count unchanged
  const postCount = getRowCount(db, name);
  const preCount  = preRowCounts[name];
  if (postCount !== preCount) {
    console.error(`[migrate-timestamps] ✗ "${name}" — row count changed: ${preCount} → ${postCount}`);
    allOk = false;
    continue;
  }

  console.log(`[migrate-timestamps] ✓ "${name}" — all columns present, ${postCount} row(s), no NULLs, valid dates`);
}

// Check 7: schema_version contains version=2
const svRow = db.prepare("SELECT version FROM schema_version WHERE version = 2").get();
if (!svRow) {
  console.error("[migrate-timestamps] ✗ schema_version — version=2 row NOT found");
  allOk = false;
} else {
  console.log("[migrate-timestamps] ✓ schema_version — version=2 confirmed");
}

console.log("");

if (!allOk) {
  console.error("[migrate-timestamps] ABORT: one or more verification checks FAILED.");
  console.error("[migrate-timestamps] Snapshot files written to scripts/ for manual inspection.");
  db.close();
  process.exit(1);
}

console.log("[migrate-timestamps] All verifications passed. Timestamp migration complete. ✓");
db.close();
process.exit(0);

}
