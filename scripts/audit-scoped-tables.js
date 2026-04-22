// scripts/audit-scoped-tables.js — audit which tables have station_id column
// Run with: node_modules/.bin/electron --no-sandbox scripts/audit-scoped-tables.js

const path = require("path");
const os   = require("os");
const fs   = require("fs");

const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
const dbPath  = path.join(appData, "com.ether.radio", "openair.db");

if (!fs.existsSync(dbPath)) { console.error("DB not found:", dbPath); process.exit(1); }

const Database = require(path.join(__dirname, "../node_modules/better-sqlite3"));
const db = new Database(dbPath, { readonly: true });

// Get all user tables
const tables = db.prepare(
  "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
).all().map(r => r.name);

const scoped   = [];
const unscoped = [];
let   stationsRow = null;

for (const name of tables) {
  const cols     = db.prepare(`PRAGMA table_info(${name})`).all().map(c => c.name);
  const hasStation = cols.includes("station_id");
  const hasUuid    = cols.includes("uuid");
  let   rowCount;
  try { rowCount = db.prepare(`SELECT COUNT(*) as c FROM "${name}"`).get().c; }
  catch { rowCount = -1; }

  const entry = { name, rowCount, hasStation, hasUuid };

  if (name === "stations") {
    stationsRow = entry;
  } else if (hasStation) {
    scoped.push(entry);
  } else {
    unscoped.push(entry);
  }
}

const pad = (s, n) => String(s).padEnd(n);

console.log("\n=== SCOPED TABLES (have station_id column) ===");
console.log(pad("table_name", 30) + pad("row_count", 13) + "has_uuid_column");
console.log("-".repeat(58));
for (const t of scoped) {
  console.log(pad(t.name, 30) + pad(t.rowCount, 13) + (t.hasUuid ? "yes" : "no"));
}

console.log("\n=== STATIONS TABLE (parent) ===");
if (stationsRow) {
  console.log(pad("table_name", 30) + pad("row_count", 13) + "has_uuid_column");
  console.log("-".repeat(58));
  console.log(pad(stationsRow.name, 30) + pad(stationsRow.rowCount, 13) + (stationsRow.hasUuid ? "yes" : "no"));
}

console.log("\n=== UNSCOPED TABLES (no station_id) ===");
console.log(pad("table_name", 30) + "row_count");
console.log("-".repeat(42));
for (const t of unscoped) {
  console.log(pad(t.name, 30) + t.rowCount);
}

console.log("\n=== COUNTS ===");
console.log(`Scoped tables:   ${scoped.length}`);
console.log(`Stations table:  1`);
console.log(`Unscoped tables: ${unscoped.length}`);
console.log(`Total:           ${scoped.length + 1 + unscoped.length}`);

db.close();
process.exit(0);
