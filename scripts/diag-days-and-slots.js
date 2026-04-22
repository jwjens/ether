// scripts/diag-days-and-slots.js — read-only diagnostic for days/slots column formats
//
// Run with: node_modules/.bin/electron --no-sandbox scripts/diag-days-and-slots.js

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

function diagColumn(table, col) {
  section(`${table}.${col}`);

  const rowCount  = db.prepare(`SELECT COUNT(*) AS c FROM "${table}"`).get().c;
  const nullCount = db.prepare(`SELECT COUNT(*) AS c FROM "${table}" WHERE "${col}" IS NULL`).get().c;

  console.log(`  table row count:   ${rowCount}`);
  console.log(`  NULL "${col}":     ${nullCount}`);

  const samples = db.prepare(
    `SELECT "${col}", typeof("${col}") AS sql_type FROM "${table}" WHERE "${col}" IS NOT NULL LIMIT 5`
  ).all();

  console.log(`\n  First ${samples.length} non-NULL sample(s):`);
  if (samples.length === 0) {
    console.log("    (none — all NULL)");
    return;
  }

  for (let i = 0; i < samples.length; i++) {
    const raw      = samples[i][col];
    const sqlType  = samples[i].sql_type;
    const jsType   = typeof raw;
    const display  = JSON.stringify(raw);
    console.log(`\n  [${i + 1}] sql typeof=${sqlType}  js typeof=${jsType}`);
    console.log(`      raw: ${display.length > 200 ? display.slice(0, 200) + "…" : display}`);

    // If it looks like JSON, try parsing
    const str = typeof raw === "string" ? raw.trim() : String(raw);
    if (str.startsWith("[") || str.startsWith("{")) {
      try {
        const parsed = JSON.parse(str);
        console.log(`      JSON.parse: OK — ${JSON.stringify(parsed).slice(0, 200)}`);
      } catch (e) {
        console.log(`      JSON.parse: FAILED — ${e.message}`);
      }
    }
  }
}

// ── Columns to inspect ────────────────────────────────────────

diagColumn("announcements",        "days");
diagColumn("shows",                "days");
diagColumn("smart_schedule_rules", "days");
diagColumn("format_clocks",        "slots");
diagColumn("format_clocks",        "slots_json");

// ── format_clocks: slots vs slots_json co-presence ───────────

section("format_clocks — slots vs slots_json co-presence");

const fcCount        = db.prepare(`SELECT COUNT(*) AS c FROM format_clocks`).get().c;
const bothPopulated  = db.prepare(`SELECT COUNT(*) AS c FROM format_clocks WHERE slots IS NOT NULL AND slots_json IS NOT NULL`).get().c;
const onlySlots      = db.prepare(`SELECT COUNT(*) AS c FROM format_clocks WHERE slots IS NOT NULL AND slots_json IS NULL`).get().c;
const onlySlotsJson  = db.prepare(`SELECT COUNT(*) AS c FROM format_clocks WHERE slots IS NULL AND slots_json IS NOT NULL`).get().c;
const neitherSet     = db.prepare(`SELECT COUNT(*) AS c FROM format_clocks WHERE slots IS NULL AND slots_json IS NULL`).get().c;

console.log(`  total rows:                  ${fcCount}`);
console.log(`  both slots + slots_json set: ${bothPopulated}`);
console.log(`  only slots set:              ${onlySlots}`);
console.log(`  only slots_json set:         ${onlySlotsJson}`);
console.log(`  neither set (both NULL):     ${neitherSet}`);

db.close();
process.exit(0);
