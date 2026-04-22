// scripts/audit-timestamps.js — audit timestamp columns across all 27 target tables
//
// Run with: node_modules/.bin/electron --no-sandbox scripts/audit-timestamps.js

const path = require("path");
const os   = require("os");
const fs   = require("fs");

const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
const dbPath  = path.join(appData, "com.ether.radio", "openair.db");

if (!fs.existsSync(dbPath)) { console.error("DB not found:", dbPath); process.exit(1); }

const Database = require(path.join(__dirname, "../node_modules/better-sqlite3"));
const db = new Database(dbPath, { readonly: true });

const TABLES = [
  "albums", "announcements", "artists", "cart_slots", "categories",
  "clock_slots", "clocks", "deck_configs", "format_clocks", "generated_schedule",
  "liner_cards", "macros", "operator_notes", "operators", "play_log",
  "prep_notes", "published_episodes", "rtmp_destinations", "scheduled_log",
  "separation_rules", "shows", "smart_schedule_rules", "songs", "spots",
  "station_config_kv", "voice_tracks", "stations",
];

const KNOWN = ["created_at", "updated_at", "deleted_at"];

function isTimestampLike(name) {
  const l = name.toLowerCase();
  return l.endsWith("_at") || l.endsWith("_time") || l.endsWith("_date") || l.includes("timestamp");
}

const results = [];

for (const table of TABLES) {
  const cols = db.prepare(`PRAGMA table_info("${table}")`).all().map(c => c.name);
  const has = name => cols.includes(name);
  const other = cols.filter(c => isTimestampLike(c) && !KNOWN.includes(c));
  results.push({
    table,
    created_at: has("created_at"),
    updated_at: has("updated_at"),
    deleted_at: has("deleted_at"),
    other,
  });
}

// ── Output table ──────────────────────────────────────────────

const COL = {
  table:      24,
  created_at: 12,
  updated_at: 12,
  deleted_at: 12,
};

const y = "yes";
const n = "no";
const pad = (s, n) => String(s).padEnd(n);

console.log("");
console.log(
  pad("table_name", COL.table) + "| " +
  pad("created_at", COL.created_at) + "| " +
  pad("updated_at", COL.updated_at) + "| " +
  pad("deleted_at", COL.deleted_at) + "| other timestamps"
);
console.log("-".repeat(90));

for (const r of results) {
  console.log(
    pad(r.table, COL.table) + "| " +
    pad(r.created_at ? y : n, COL.created_at) + "| " +
    pad(r.updated_at ? y : n, COL.updated_at) + "| " +
    pad(r.deleted_at ? y : n, COL.deleted_at) + "| " +
    (r.other.length ? r.other.join(", ") : "(none)")
  );
}

// ── Summary ───────────────────────────────────────────────────

const noCreated = results.filter(r => !r.created_at);
const noUpdated = results.filter(r => !r.updated_at);
const noDeleted = results.filter(r => !r.deleted_at);
const hasOther  = results.filter(r => r.other.length > 0);

console.log("");
console.log("═".repeat(60));
console.log("SUMMARY");
console.log("═".repeat(60));
console.log(`Tables with no created_at: ${noCreated.length}`);
if (noCreated.length) console.log("  " + noCreated.map(r => r.table).join(", "));

console.log(`Tables with no updated_at: ${noUpdated.length}`);
if (noUpdated.length) console.log("  " + noUpdated.map(r => r.table).join(", "));

console.log(`Tables with no deleted_at: ${noDeleted.length}`);
if (noDeleted.length) console.log("  " + noDeleted.map(r => r.table).join(", "));

console.log(`\nTables with other _at/_time/_date/timestamp columns: ${hasOther.length}`);
for (const r of hasOther) {
  console.log(`  ${r.table}: ${r.other.join(", ")}`);
}

db.close();
process.exit(0);
