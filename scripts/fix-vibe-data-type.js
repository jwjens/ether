// scripts/fix-vibe-data-type.js — one-shot DB patch
//
// Finds user-created metadata definitions (is_built_in=0) that have vocabulary
// rows in metadata_vocabulary but whose data_type is 'text' or 'number' instead
// of 'single_choice'/'multi_choice'. Updates them to 'single_choice'.
//
// Run with: node scripts/fix-vibe-data-type.js         (dry-run: report only)
//           node scripts/fix-vibe-data-type.js --apply  (apply the fix)
//
// IMPORTANT: Stop Ether dev server before running.

const path = require("path");
const os   = require("os");
const fs   = require("fs");

const DRY_RUN = !process.argv.includes("--apply");

const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
const dbPath  = path.join(appData, "com.ether.radio", "openair.db");

console.log("[fix-vibe-data-type] DB path:", dbPath);
console.log("[fix-vibe-data-type] Mode:", DRY_RUN ? "DRY RUN (pass --apply to fix)" : "APPLY");
console.log("");

if (!fs.existsSync(dbPath)) {
  console.error("[fix-vibe-data-type] ERROR: DB not found at", dbPath);
  process.exit(1);
}

const Database = require(path.join(__dirname, "../node_modules/better-sqlite3"));
const db = new Database(dbPath);

// Find user-created definitions that have vocab rows but wrong data_type
const candidates = db.prepare(`
  SELECT d.id, d.uuid, d.name, d.data_type,
         COUNT(v.id) AS vocab_count
  FROM   metadata_definitions d
  JOIN   metadata_vocabulary  v ON v.definition_id = d.id
  WHERE  d.is_built_in = 0
    AND  d.data_type NOT IN ('single_choice', 'multi_choice')
  GROUP  BY d.id
  ORDER  BY d.name
`).all();

if (candidates.length === 0) {
  console.log("No affected definitions found — nothing to fix.");
  db.close();
  process.exit(0);
}

console.log("Affected definitions:");
for (const r of candidates) {
  console.log(`  id=${r.id}  name="${r.name}"  data_type="${r.data_type}"  vocab_count=${r.vocab_count}`);
}
console.log("");

if (DRY_RUN) {
  console.log("DRY RUN — no changes made. Re-run with --apply to fix.");
  db.close();
  process.exit(0);
}

// Apply fix inside a transaction
const ids = candidates.map(r => r.id);
const placeholders = ids.map(() => "?").join(", ");

const fix = db.transaction(() => {
  const result = db.prepare(
    `UPDATE metadata_definitions SET data_type = 'single_choice' WHERE id IN (${placeholders})`
  ).run(...ids);
  return result.changes;
});

const changed = fix();

console.log(`Updated ${changed} definition(s) to data_type='single_choice'.`);
console.log("");

// Verify
console.log("AFTER:");
for (const r of candidates) {
  const row = db.prepare("SELECT data_type FROM metadata_definitions WHERE id = ?").get(r.id);
  console.log(`  id=${r.id}  name="${r.name}"  data_type="${row.data_type}" ✓`);
}

console.log("");
console.log("[fix-vibe-data-type] Done.");

db.close();
process.exit(0);
