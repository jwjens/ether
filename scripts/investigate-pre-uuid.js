// scripts/investigate-pre-uuid.js — pre-UUID migration investigation
// Run with: node_modules/.bin/electron --no-sandbox scripts/investigate-pre-uuid.js

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

function tableInfo(name) {
  console.log(`\nPRAGMA table_info(${name}):`);
  const cols = db.prepare(`PRAGMA table_info(${name})`).all();
  for (const c of cols) {
    console.log(`  [${c.cid}] ${c.name.padEnd(25)} ${c.type.padEnd(15)} notnull=${c.notnull} dflt=${c.dflt_value} pk=${c.pk}`);
  }
  return cols;
}

function tableRows(name) {
  try {
    const rows = db.prepare(`SELECT * FROM "${name}"`).all();
    console.log(`\nSELECT * FROM ${name}: (${rows.length} row(s))`);
    for (const r of rows) console.log(" ", JSON.stringify(r));
    return rows;
  } catch (e) {
    console.log(`  ERROR reading ${name}: ${e.message}`);
    return [];
  }
}

// ── 1. schema_version ─────────────────────────────────────────

section("1. schema_version");
tableInfo("schema_version");
tableRows("schema_version");

// ── 2. replication_* ──────────────────────────────────────────

section("2. replication_config / replication_log / replication_peers");
for (const t of ["replication_config", "replication_log", "replication_peers"]) {
  tableInfo(t);
  tableRows(t);
}

// ── 3. pinned_songs ───────────────────────────────────────────

section("3. pinned_songs");
tableInfo("pinned_songs");
tableRows("pinned_songs");

db.close();
process.exit(0);
