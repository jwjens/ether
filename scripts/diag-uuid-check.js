// scripts/diag-uuid-check.js — read-only UUID column diagnostic
//
// Run with: node_modules/.bin/electron --no-sandbox scripts/diag-uuid-check.js

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

// Tables to inspect + which column to show as the "key" in sample rows
const TARGETS = [
  { table: "songs",              key: "id"         },
  { table: "artists",            key: "id"         },
  { table: "play_log",           key: "id"         },
  { table: "generated_schedule", key: "id"         },
  { table: "categories",         key: "id"         },
  { table: "stations",           key: "id"         },
];

for (const { table, key } of TARGETS) {
  section(table);

  // Check whether uuid column exists at all
  const cols = db.prepare(`PRAGMA table_info("${table}")`).all().map(c => c.name);
  if (!cols.includes("uuid")) {
    console.log(`  uuid column: NOT PRESENT`);
    const total = db.prepare(`SELECT COUNT(*) AS c FROM "${table}"`).get().c;
    console.log(`  total rows:  ${total}`);
    continue;
  }

  const total    = db.prepare(`SELECT COUNT(*) AS c FROM "${table}"`).get().c;
  const nonNull  = db.prepare(`SELECT COUNT(*) AS c FROM "${table}" WHERE uuid IS NOT NULL`).get().c;
  const nulls    = db.prepare(`SELECT COUNT(*) AS c FROM "${table}" WHERE uuid IS NULL`).get().c;

  console.log(`  uuid column:    PRESENT`);
  console.log(`  total rows:     ${total}`);
  console.log(`  uuid NOT NULL:  ${nonNull}`);
  console.log(`  uuid IS NULL:   ${nulls}`);

  // First 3 sample rows
  const samples = db.prepare(`SELECT "${key}", uuid FROM "${table}" LIMIT 3`).all();
  console.log(`\n  First 3 rows (${key}, uuid):`);
  for (const r of samples) {
    console.log(`    ${key}=${r[key]}  uuid=${r.uuid ?? "(null)"}`);
  }
}

// ── schema_version ────────────────────────────────────────────

section("schema_version");

const svCols = db.prepare(`PRAGMA table_info("schema_version")`).all();
console.log(`  columns: ${svCols.map(c => c.name).join(", ")}`);

const svRows = db.prepare(`SELECT * FROM schema_version`).all();
console.log(`  rows (${svRows.length}):`);
for (const r of svRows) {
  console.log("   ", JSON.stringify(r));
}

db.close();
process.exit(0);
