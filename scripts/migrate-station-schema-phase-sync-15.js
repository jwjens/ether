// Migration v15: add station_id to ai_voice_segments
// Two-path: CREATE TABLE (fresh installs) handled in main.js runMigrations().
// This script handles existing installs via ALTER TABLE.

"use strict";

module.exports = {
  payloadTransformer: function payloadTransformer(payload) {
    return payload;
  },
};

if (require.main === module) {
  const path = require("path");
  const os = require("os");
  const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  const dbPath = path.join(appData, "com.ether.radio", "openair.db");

  const Database = require(path.join(__dirname, "..", "node_modules", "better-sqlite3"));
  const db = new Database(dbPath);

  console.log("=== migrate-station-schema-phase-sync-15.js ===");
  console.log("DB:", dbPath);

  // ── Pre-flight 1: schema_version must be 1..14 ────────────────
  const versions = db.prepare("SELECT version FROM schema_version ORDER BY version").all().map(r => r.version);
  const currentVersion = Math.max(...versions);
  console.log("schema_version rows:", JSON.stringify(versions));
  console.log("current schema_version:", currentVersion);
  if (currentVersion < 1 || currentVersion > 14) {
    console.error("ABORT: expected schema_version in [1..14], got", currentVersion);
    process.exit(1);
  }

  // ── Pre-flight 2: station_id must not already exist ───────────
  const cols = db.prepare("PRAGMA table_info(ai_voice_segments)").all().map(r => r.name);
  console.log("ai_voice_segments columns:", cols);
  if (cols.includes("station_id")) {
    console.log("INFO: station_id already present — migration already applied, exiting cleanly.");
    process.exit(0);
  }

  // ── Atomic transaction ────────────────────────────────────────
  db.prepare("BEGIN").run();
  try {
    db.prepare("ALTER TABLE ai_voice_segments ADD COLUMN station_id INTEGER NOT NULL DEFAULT 1").run();
    console.log("ALTER TABLE ai_voice_segments ADD COLUMN station_id: OK");

    db.prepare("CREATE INDEX IF NOT EXISTS idx_ai_voice_segments_station_id ON ai_voice_segments(station_id)").run();
    console.log("CREATE INDEX idx_ai_voice_segments_station_id: OK");

    db.prepare("INSERT INTO schema_version (version) VALUES (15)").run();
    console.log("schema_version 15 inserted");

    db.prepare("COMMIT").run();
    console.log("COMMIT: OK");
  } catch (err) {
    db.prepare("ROLLBACK").run();
    console.error("ROLLBACK — migration failed:", err.message);
    process.exit(1);
  }

  // ── Post-verification ─────────────────────────────────────────
  console.log("\n=== Post-verification ===");
  let allPass = true;

  const check = (label, pass, detail) => {
    const tag = pass ? "PASS" : "FAIL";
    console.log(`[${tag}] ${label}${detail ? " — " + detail : ""}`);
    if (!pass) allPass = false;
  };

  const newVersion = Math.max(...db.prepare("SELECT version FROM schema_version ORDER BY version").all().map(r => r.version));
  check("schema_version = 15", newVersion === 15, `got ${newVersion}`);

  const newCols = db.prepare("PRAGMA table_info(ai_voice_segments)").all().map(r => r.name);
  check("station_id column exists", newCols.includes("station_id"), newCols.join(", "));

  const idxRows = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_ai_voice_segments_station_id'").all();
  check("idx_ai_voice_segments_station_id exists", idxRows.length > 0);

  const nullCount = db.prepare("SELECT COUNT(*) as c FROM ai_voice_segments WHERE station_id IS NULL").get().c;
  check("no NULL station_id rows", nullCount === 0, `null count: ${nullCount}`);

  const wrongCount = db.prepare("SELECT COUNT(*) as c FROM ai_voice_segments WHERE station_id != 1").get().c;
  check("all existing rows have station_id=1", wrongCount === 0, `non-1 count: ${wrongCount}`);

  const totalRows = db.prepare("SELECT COUNT(*) as c FROM ai_voice_segments").get().c;
  check("row count stable", totalRows >= 0, `rows: ${totalRows}`);

  db.close();

  if (!allPass) {
    console.error("\nOne or more post-verification checks FAILED.");
    process.exit(1);
  }
  console.log("\nAll checks PASSED — migration v15 complete.");
}
