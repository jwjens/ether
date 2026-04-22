// scripts/flip-safety-gate.js — Phase 3c: flip multistation_insert_audit_complete gate
//
// Run with: node_modules/.bin/electron --no-sandbox scripts/flip-safety-gate.js
//
// Sets station_config_kv key 'multistation_insert_audit_complete' = 'true' at station_id=0.
// This gates the multi-station INSERT audit in the app — only flip after all
// station_id scoping work (3a, 3b-i, 3b-ii, 3b-iii) is verified complete.

const path = require("path");
const os   = require("os");

const KEY        = "multistation_insert_audit_complete";
const STATION_ID = 0;
const NEW_VALUE  = "true";

const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
const dbPath  = path.join(appData, "com.ether.radio", "openair.db");

console.log("[flip-safety-gate] DB path:", dbPath);
console.log("");

const fs = require("fs");
if (!fs.existsSync(dbPath)) {
  console.error("[flip-safety-gate] ERROR: DB not found at", dbPath);
  process.exit(1);
}

const Database = require(path.join(__dirname, "../node_modules/better-sqlite3"));
const db = new Database(dbPath);

// Read current value — no station_id filter, show all rows for this key
const existing = db.prepare(
  "SELECT station_id, key, value FROM station_config_kv WHERE key = ?"
).all(KEY);

if (existing.length === 0) {
  console.log(`[flip-safety-gate] BEFORE: key "${KEY}" not present in station_config_kv`);
} else {
  for (const r of existing) {
    console.log(`[flip-safety-gate] BEFORE: station_id=${r.station_id}  key="${r.key}"  value="${r.value}"`);
  }
}

console.log("");

// Flip it
db.prepare(
  "INSERT OR REPLACE INTO station_config_kv (station_id, key, value) VALUES (?, ?, ?)"
).run(STATION_ID, KEY, NEW_VALUE);

console.log(`[flip-safety-gate] SET: station_id=${STATION_ID}  key="${KEY}"  value="${NEW_VALUE}"`);
console.log("");

// Confirm
const after = db.prepare(
  "SELECT station_id, key, value FROM station_config_kv WHERE key = ?"
).all(KEY);

for (const r of after) {
  console.log(`[flip-safety-gate] AFTER:  station_id=${r.station_id}  key="${r.key}"  value="${r.value}"`);
}

console.log("");
console.log("[flip-safety-gate] Done. ✓");

db.close();
process.exit(0);
