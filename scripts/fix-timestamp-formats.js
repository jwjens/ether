// scripts/fix-timestamp-formats.js — normalize epoch-integer timestamps to ISO 8601 strings
//
// Run with: node_modules/.bin/electron --no-sandbox scripts/fix-timestamp-formats.js
// IMPORTANT: Stop the Ether dev server before running.
//
// Context: migrate-timestamps-phase-sync-2.js left 4 tables with pre-existing created_at/updated_at
// values stored as epoch-second integers (or epoch-second numeric strings). The migration correctly
// skipped them (they were NOT NULL), but the verifier rejected them as non-ISO. This script
// normalizes those 4 tables only by converting epoch-s / epoch-ms values to ISO 8601 strings.
//
// Does NOT touch schema_version — it is already at version=2.
// Does NOT touch any of the other 23 tables.

const path = require("path");
const os   = require("os");
const fs   = require("fs");

const TABLES = ["artists", "songs", "operators", "stations"];
const TS_COLS = ["created_at", "updated_at"];

// ── DB path ───────────────────────────────────────────────────

const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
const dbPath  = path.join(appData, "com.ether.radio", "openair.db");

console.log("[fix-timestamps] DB path:", dbPath);
console.log("");

if (!fs.existsSync(dbPath)) {
  console.error("[fix-timestamps] ERROR: DB not found at", dbPath);
  process.exit(1);
}

const Database = require(path.join(__dirname, "../node_modules/better-sqlite3"));
const db = new Database(dbPath);

// ── Helpers ───────────────────────────────────────────────────

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

// Returns the normalized ISO string, or null if no change is needed, or false if unparseable.
function normalizeTimestamp(val) {
  if (val === null || val === undefined) {
    return null; // skip NULLs
  }

  // Already a valid ISO string — do not touch
  if (typeof val === "string" && ISO_RE.test(val)) {
    return null;
  }

  // Numeric value (integer column) or numeric string
  const asNum = typeof val === "number" ? val : (typeof val === "string" && /^\d+$/.test(val.trim()) ? parseInt(val, 10) : NaN);

  if (!isNaN(asNum)) {
    const ms = asNum * 1000;
    const d  = new Date(ms);
    if (isNaN(d.getTime())) return false; // unparseable
    return d.toISOString();
  }

  // Non-numeric, non-ISO — unparseable
  return false;
}

function abort(msg) {
  console.error(`\n[fix-timestamps] ABORT: ${msg}`);
  db.close();
  process.exit(1);
}

// ── Atomic normalization transaction ──────────────────────────

console.log("═".repeat(60));
console.log("NORMALIZING TIMESTAMP FORMATS");
console.log("═".repeat(60));
console.log("");

const normalize = db.transaction(() => {
  for (const table of TABLES) {
    let createdAtNormalized = 0;
    let updatedAtNormalized = 0;

    const rows = db.prepare(`SELECT id, created_at, updated_at FROM "${table}"`).all();

    const stmtCreatedAt = db.prepare(`UPDATE "${table}" SET created_at = ? WHERE id = ?`);
    const stmtUpdatedAt = db.prepare(`UPDATE "${table}" SET updated_at = ? WHERE id = ?`);

    for (const row of rows) {
      for (const col of TS_COLS) {
        const raw        = row[col];
        const normalized = normalizeTimestamp(raw);

        if (normalized === null) {
          // NULL or already ISO — skip silently
          continue;
        }

        if (normalized === false) {
          // Unparseable — log and leave alone; verifier will catch it
          console.log(`[fix-timestamps] WARN   "${table}" id=${row.id} ${col}=${JSON.stringify(raw)} — unparseable, leaving as-is`);
          continue;
        }

        // Write the ISO string back
        if (col === "created_at") {
          stmtCreatedAt.run(normalized, row.id);
          createdAtNormalized++;
        } else {
          stmtUpdatedAt.run(normalized, row.id);
          updatedAtNormalized++;
        }
      }
    }

    console.log(`[fix-timestamps] NORM   "${table}" — ${createdAtNormalized} created_at, ${updatedAtNormalized} updated_at normalized`);
  }
});

try {
  normalize();
  console.log("");
  console.log("[fix-timestamps] Transaction committed.");
} catch (err) {
  console.error("\n[fix-timestamps] ERROR — transaction rolled back:", err.message);
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

for (const table of TABLES) {
  const badCreated = db.prepare(
    `SELECT COUNT(*) AS c FROM "${table}" WHERE created_at IS NOT NULL AND created_at NOT GLOB '????-??-??T??:??:??*'`
  ).get().c;

  const badUpdated = db.prepare(
    `SELECT COUNT(*) AS c FROM "${table}" WHERE updated_at IS NOT NULL AND updated_at NOT GLOB '????-??-??T??:??:??*'`
  ).get().c;

  if (badCreated > 0 || badUpdated > 0) {
    console.error(`[fix-timestamps] ✗ "${table}" — malformed values remain: ${badCreated} created_at, ${badUpdated} updated_at`);
    allOk = false;
  } else {
    const rowCount = db.prepare(`SELECT COUNT(*) AS c FROM "${table}"`).get().c;
    console.log(`[fix-timestamps] ✓ "${table}" — ${rowCount} row(s), all timestamps ISO 8601`);
  }
}

console.log("");

if (!allOk) {
  abort("one or more tables still have malformed timestamp values.");
}

console.log("[fix-timestamps] All 4 tables normalized. ✓");
db.close();
process.exit(0);
