// scripts/migrate-kv-phase3c.js — Phase 3c: migrate per-station keys from station_id=0 → station_id=1
//
// Run with: node_modules/.bin/electron --no-sandbox scripts/migrate-kv-phase3c.js
//
// What it does (single atomic transaction):
//   1. Snapshots station_config_kv to scripts/pre-migration-snapshot-kv.txt
//   2. For each PER_STATION key at station_id=0: INSERT OR IGNORE at station_id=1, DELETE at station_id=0
//   3. DELETEs deprecated keys (playout_server, icecast_source_password) — no-op if absent
//   4. Snapshots result to scripts/post-migration-snapshot-kv.txt
//   5. Verifies counts match expectations

const path = require("path");
const os   = require("os");
const fs   = require("fs");

// ── Config ────────────────────────────────────────────────────

const TARGET_STATION_ID = 1;

// Keys that belong to a specific station, not the account.
// Include all known per-station keys — including ones not yet in DB
// (INSERT OR IGNORE + graceful no-op if absent at station_id=0).
const PER_STATION_KEYS = [
  "station_name",
  "station_tagline",
  "station_logo",
  "venue_type",
  "experience_mode",
  "timezone",
  "theme_preset_id",
  "theme_custom_vars",
  "theme_font_id",
  "eq_deck_A",
  "eq_deck_B",
  "eq_deck_C",
  "eq_deck_mic",
  "eq_master",
  "studio_scenes",
  "studio_brand_kit",
  "studio_rtmp_multi",
  "studio_rtmp_url",
  "studio_stream_key",
  "studio_resolution",
  "studio_bitrate",
  "ig_handle",
  "ig_enabled",
  "now_playing_widget",
  "weather_city",
  "weather_lat",
  "weather_lon",
  "audio_routing",
  "last_operator_id",
  "clipeditor_format",
  "canvas_layout",
  "canvas_profiles",
  "canvas_active_name",
  "canvas_layout_version",
];

// Keys that were duplicated to the stations table and are no longer
// authoritative here — delete from station_config_kv entirely.
const DEPRECATED_KEYS = [
  "playout_server",
  "icecast_source_password",
];

// ── DB path (mirrors electron/main.js getDbPath) ─────────────

const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
const dbPath  = path.join(appData, "com.ether.radio", "openair.db");
const snapshotDir = path.join(__dirname);

// ── Helpers ───────────────────────────────────────────────────

function snapshot(db, label) {
  const rows = db.prepare(
    "SELECT station_id, key, value FROM station_config_kv ORDER BY station_id, key"
  ).all();

  const lines = [
    `station_config_kv snapshot — ${label}`,
    `Generated: ${new Date().toISOString()}`,
    `Total rows: ${rows.length}`,
    "",
    "station_id | key                                | value (first 80 chars)",
    "-".repeat(110),
  ];

  for (const r of rows) {
    const val = r.value == null ? "(null)" : String(r.value).replace(/\n/g, "\\n").slice(0, 80);
    lines.push(`         ${r.station_id} | ${r.key.padEnd(35)} | ${val}`);
  }

  const text = lines.join("\n") + "\n";
  console.log(text);
  return { rows, text };
}

function countByStation(rows) {
  const counts = {};
  for (const r of rows) {
    counts[r.station_id] = (counts[r.station_id] || 0) + 1;
  }
  return counts;
}

// ── Main ──────────────────────────────────────────────────────

console.log("[migrate-kv] DB path:", dbPath);
console.log("");

if (!fs.existsSync(dbPath)) {
  console.error("[migrate-kv] ERROR: DB not found at", dbPath);
  process.exit(1);
}

const Database = require(path.join(__dirname, "../node_modules/better-sqlite3"));
const db = new Database(dbPath);

// ── Pre-migration snapshot ────────────────────────────────────

console.log("═".repeat(60));
console.log("PRE-MIGRATION SNAPSHOT");
console.log("═".repeat(60));
const { rows: preMigrationRows, text: preText } = snapshot(db, "PRE-MIGRATION");
const preFile = path.join(snapshotDir, "pre-migration-snapshot-kv.txt");
fs.writeFileSync(preFile, preText, "utf8");
console.log(`[migrate-kv] Pre-migration snapshot written to ${preFile}\n`);

const preCounts = countByStation(preMigrationRows);
console.log(`[migrate-kv] Pre-migration counts:`, preCounts);
console.log("");

// ── Prepare statements ────────────────────────────────────────

const stmtSelect = db.prepare(
  "SELECT value FROM station_config_kv WHERE station_id = 0 AND key = ?"
);
const stmtInsert = db.prepare(
  "INSERT OR IGNORE INTO station_config_kv (station_id, key, value) VALUES (?, ?, ?)"
);
const stmtDelete = db.prepare(
  "DELETE FROM station_config_kv WHERE station_id = ? AND key = ?"
);
const stmtDeleteAny = db.prepare(
  "DELETE FROM station_config_kv WHERE key = ?"
);

// ── Migration transaction ─────────────────────────────────────

console.log("═".repeat(60));
console.log("RUNNING MIGRATION");
console.log("═".repeat(60));

const migrate = db.transaction(() => {
  let moved = 0;
  let skipped = 0;

  // Step 1: Move PER_STATION keys from station_id=0 → station_id=TARGET_STATION_ID
  for (const key of PER_STATION_KEYS) {
    const row = stmtSelect.get(key);

    if (!row) {
      console.log(`[migrate-kv] SKIP   ${key}: not present at station_id=0 (no-op)`);
      skipped++;
      continue;
    }

    const displayVal = String(row.value ?? "").slice(0, 50);

    // INSERT OR IGNORE at target station — skip if already exists there
    const insertResult = stmtInsert.run(TARGET_STATION_ID, key, row.value);

    if (insertResult.changes === 0) {
      // Row already existed at station_id=1 — still delete the station_id=0 row
      console.log(`[migrate-kv] MOVE   ${key}: station_id=0 → station_id=${TARGET_STATION_ID} (target already existed, kept existing value: "${displayVal}")`);
    } else {
      console.log(`[migrate-kv] MOVE   ${key}: station_id=0 → station_id=${TARGET_STATION_ID} (value: "${displayVal}")`);
    }

    // DELETE from station_id=0
    stmtDelete.run(0, key);
    moved++;
  }

  // Step 2: Delete deprecated keys entirely
  for (const key of DEPRECATED_KEYS) {
    const result = stmtDeleteAny.run(key);
    if (result.changes === 0) {
      console.log(`[migrate-kv] DELETE deprecated key ${key} (no-op, not present)`);
    } else {
      console.log(`[migrate-kv] DELETE deprecated key ${key} (removed ${result.changes} row(s))`);
    }
  }

  return { moved, skipped };
});

let migrationResult;
try {
  migrationResult = migrate();
  console.log("");
  console.log(`[migrate-kv] Transaction committed. Moved: ${migrationResult.moved}, Skipped: ${migrationResult.skipped}`);
} catch (err) {
  console.error("\n[migrate-kv] ERROR — transaction rolled back:", err.message);
  db.close();
  process.exit(1);
}

// ── Post-migration snapshot ───────────────────────────────────

console.log("");
console.log("═".repeat(60));
console.log("POST-MIGRATION SNAPSHOT");
console.log("═".repeat(60));
const { rows: postMigrationRows, text: postText } = snapshot(db, "POST-MIGRATION");
const postFile = path.join(snapshotDir, "post-migration-snapshot-kv.txt");
fs.writeFileSync(postFile, postText, "utf8");
console.log(`[migrate-kv] Post-migration snapshot written to ${postFile}\n`);

const postCounts = countByStation(postMigrationRows);

// ── Verification ──────────────────────────────────────────────

console.log("═".repeat(60));
console.log("VERIFICATION");
console.log("═".repeat(60));

const pre0  = preCounts[0]  || 0;
const post0 = postCounts[0] || 0;
const pre1  = preCounts[1]  || 0;
const post1 = postCounts[1] || 0;

const moved = migrationResult.moved;
const expectedPost0 = pre0 - moved;
const expectedPost1 = pre1 + moved;

const ok0 = post0 === expectedPost0;
const ok1 = post1 === expectedPost1;

console.log(
  `[migrate-kv] VERIFICATION: station_id=0 count changed from ${pre0} → ${post0}` +
  (ok0 ? ` ✓` : ` ✗ EXPECTED ${expectedPost0}`)
);
console.log(
  `[migrate-kv] VERIFICATION: station_id=1 count changed from ${pre1} → ${post1}` +
  (ok1 ? ` ✓` : ` ✗ EXPECTED ${expectedPost1}`)
);

if (!ok0 || !ok1) {
  console.error("\n[migrate-kv] VERIFICATION FAILED — counts do not match expectations.");
  console.error("[migrate-kv] Snapshot files written for manual inspection.");
  db.close();
  process.exit(1);
}

console.log("\n[migrate-kv] Migration complete. ✓");
db.close();
process.exit(0);
