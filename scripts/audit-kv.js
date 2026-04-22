// scripts/audit-kv.js — Phase 3c audit: inventory all station_config_kv rows
// Run with: node scripts/audit-kv.js

const path = require("path");
const os   = require("os");

// Mirror electron/main.js getDbPath()
const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
const dbPath  = path.join(appData, "com.ether.radio", "openair.db");

console.log("[audit-kv] DB path:", dbPath);
console.log("");

let Database;
try {
  Database = require("better-sqlite3");
} catch {
  // Try from the project's own node_modules
  Database = require(path.join(__dirname, "../node_modules/better-sqlite3"));
}

const db = new Database(dbPath, { readonly: true });

const rows = db.prepare(
  "SELECT station_id, key, value FROM station_config_kv ORDER BY station_id, key"
).all();

console.log(`Found ${rows.length} rows in station_config_kv\n`);
console.log(
  "station_id | key                                | value (first 60 chars)"
);
console.log("-".repeat(100));

for (const r of rows) {
  const val = r.value == null ? "(null)" : String(r.value).replace(/\n/g, "\\n").slice(0, 60);
  const key = r.key.padEnd(35);
  console.log(`         ${r.station_id} | ${key} | ${val}`);
}

db.close();
