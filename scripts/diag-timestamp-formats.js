// scripts/diag-timestamp-formats.js — read-only diagnostic for pre-existing timestamp values
//
// Run with: node_modules/.bin/electron --no-sandbox scripts/diag-timestamp-formats.js

const path = require("path");
const os   = require("os");
const fs   = require("fs");

const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
const dbPath  = path.join(appData, "com.ether.radio", "openair.db");

if (!fs.existsSync(dbPath)) { console.error("DB not found:", dbPath); process.exit(1); }

const Database = require(path.join(__dirname, "../node_modules/better-sqlite3"));
const db = new Database(dbPath, { readonly: true });

function section(title) {
  console.log("\n" + "═".repeat(60));
  console.log(title);
  console.log("═".repeat(60));
}

const TABLES = ["artists", "songs", "operators", "stations"];

for (const table of TABLES) {
  section(table);

  const rowCount   = db.prepare(`SELECT COUNT(*) AS c FROM "${table}"`).get().c;
  const nullCreate = db.prepare(`SELECT COUNT(*) AS c FROM "${table}" WHERE created_at IS NULL`).get().c;
  const nullUpdate = db.prepare(`SELECT COUNT(*) AS c FROM "${table}" WHERE updated_at IS NULL`).get().c;

  console.log(`  row_count:          ${rowCount}`);
  console.log(`  NULL created_at:    ${nullCreate}`);
  console.log(`  NULL updated_at:    ${nullUpdate}`);

  // First 3 rows: id, created_at value, SQLite typeof(), string length
  console.log(`\n  created_at samples (first 3 rows):`);
  const caRows = db.prepare(
    `SELECT id, created_at, typeof(created_at) AS ca_type, length(created_at) AS ca_len FROM "${table}" LIMIT 3`
  ).all();
  for (const r of caRows) {
    console.log(`    id=${r.id}  value=${JSON.stringify(r.created_at)}  typeof=${r.ca_type}  length=${r.ca_len}`);
  }

  // First 3 rows: id, updated_at value, SQLite typeof(), string length
  console.log(`\n  updated_at samples (first 3 rows):`);
  const uaRows = db.prepare(
    `SELECT id, updated_at, typeof(updated_at) AS ua_type, length(updated_at) AS ua_len FROM "${table}" LIMIT 3`
  ).all();
  for (const r of uaRows) {
    console.log(`    id=${r.id}  value=${JSON.stringify(r.updated_at)}  typeof=${r.ua_type}  length=${r.ua_len}`);
  }

  // Up to 5 distinct created_at values
  console.log(`\n  distinct created_at values (up to 5):`);
  const distinct = db.prepare(
    `SELECT DISTINCT created_at FROM "${table}" WHERE created_at IS NOT NULL LIMIT 5`
  ).all();
  if (distinct.length === 0) {
    console.log(`    (none — all NULL)`);
  } else {
    for (const r of distinct) {
      console.log(`    ${JSON.stringify(r.created_at)}`);
    }
  }
}

// ── schema_version ────────────────────────────────────────────

section("schema_version");
const svRows = db.prepare("SELECT * FROM schema_version").all();
console.log(`  rows (${svRows.length}):`);
for (const r of svRows) {
  console.log("   ", JSON.stringify(r));
}

db.close();
process.exit(0);
