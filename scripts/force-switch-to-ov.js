// scripts/force-switch-to-ov.js — Phase 3c: force active station to id=1 (Opportunity Village)
//
// Run with: node_modules/.bin/electron --no-sandbox scripts/force-switch-to-ov.js
// IMPORTANT: Stop the Ether dev server before running.
//
// Context: Station 2 is currently active in both stations.is_active and
// station_config_kv.active_station_id. The UI switch back to OV never hit the DB.
// This script corrects both sources atomically.

const path = require("path");
const os   = require("os");
const fs   = require("fs");

const TARGET_STATION_ID = 1;

const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
const dbPath  = path.join(appData, "com.ether.radio", "openair.db");

console.log("[force-switch-to-ov] DB path:", dbPath);
console.log("");

if (!fs.existsSync(dbPath)) {
  console.error("[force-switch-to-ov] ERROR: DB not found at", dbPath);
  process.exit(1);
}

const Database = require(path.join(__dirname, "../node_modules/better-sqlite3"));
const db = new Database(dbPath);

// ── Helpers ───────────────────────────────────────────────────

function readState() {
  const stations = db.prepare("SELECT id, name, is_active FROM stations ORDER BY id").all();
  const kvRow    = db.prepare(
    "SELECT value FROM station_config_kv WHERE key = 'active_station_id' AND station_id = 0"
  ).get();
  return { stations, activeKv: kvRow?.value ?? "(not set)" };
}

function printState(label, state) {
  console.log(`${label}`);
  for (const s of state.stations) {
    const flag = s.is_active ? "✓ is_active=1" : "  is_active=0";
    console.log(`  stations: id=${s.id}  ${flag}  name="${s.name}"`);
  }
  console.log(`  station_config_kv: active_station_id = "${state.activeKv}"`);
  console.log("");
}

// ── Before ────────────────────────────────────────────────────

const before = readState();
printState("BEFORE:", before);

// ── Atomic transaction ────────────────────────────────────────

const switchToOV = db.transaction(() => {
  // Set is_active=1 only for station 1, 0 for all others
  db.prepare(
    "UPDATE stations SET is_active = CASE WHEN id = ? THEN 1 ELSE 0 END"
  ).run(TARGET_STATION_ID);

  // Update the KV pointer — this is the source of truth read by useActiveStation hook
  db.prepare(
    "INSERT OR REPLACE INTO station_config_kv (station_id, key, value) VALUES (0, 'active_station_id', ?)"
  ).run(String(TARGET_STATION_ID));
});

try {
  switchToOV();
  console.log("[force-switch-to-ov] Transaction committed.\n");
} catch (err) {
  console.error("[force-switch-to-ov] ERROR — transaction rolled back:", err.message);
  db.close();
  process.exit(1);
}

// ── After ─────────────────────────────────────────────────────

const after = readState();
printState("AFTER:", after);

// ── Verification ──────────────────────────────────────────────

const ovRow      = after.stations.find(s => s.id === TARGET_STATION_ID);
const isActiveOk = ovRow?.is_active === 1;
const isKvOk     = after.activeKv === String(TARGET_STATION_ID);

if (isActiveOk && isKvOk) {
  console.log("[force-switch-to-ov] ✓ OV is now the active station in both sources.");
} else {
  if (!isActiveOk) console.error(`[force-switch-to-ov] ✗ stations.is_active for id=${TARGET_STATION_ID} is not 1 (got ${ovRow?.is_active})`);
  if (!isKvOk)     console.error(`[force-switch-to-ov] ✗ station_config_kv.active_station_id is "${after.activeKv}", expected "${TARGET_STATION_ID}"`);
  console.error("[force-switch-to-ov] ABORT: verification failed — state may be inconsistent.");
  db.close();
  process.exit(1);
}

db.close();
process.exit(0);
