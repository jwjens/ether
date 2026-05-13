// scripts/backfill-vocab-fks.js — backfill value_vocabulary_id on song_metadata_values
//
// Run with: node scripts/backfill-vocab-fks.js
// IMPORTANT: Stop the Ether dev server before running.
//
// Finds smv rows where the definition is single_choice/multi_choice and
// value_vocabulary_id IS NULL but value_text is non-empty.
// Looks up the matching vocab row by (definition_id, value_text) and writes the FK.
// Idempotent: rows that already have value_vocabulary_id set are skipped.

const path = require("path");
const os   = require("os");
const fs   = require("fs");

// ── DB path ───────────────────────────────────────────────────

const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
const dbPath  = path.join(appData, "com.ether.radio", "openair.db");

console.log("[backfill-vocab-fks] DB path:", dbPath);
console.log("");

if (!fs.existsSync(dbPath)) {
  console.error("[backfill-vocab-fks] ERROR: DB not found at", dbPath);
  process.exit(1);
}

const Database = require(path.join(__dirname, "../node_modules/better-sqlite3"));
const db = new Database(dbPath);

// ── Pre-flight ────────────────────────────────────────────────

const nullCount = db.prepare(`
  SELECT COUNT(*) AS c
  FROM song_metadata_values smv
  JOIN metadata_definitions md ON md.id = smv.definition_id
  WHERE md.data_type IN ('single_choice', 'multi_choice')
    AND smv.value_vocabulary_id IS NULL
    AND smv.value_text IS NOT NULL
    AND smv.value_text != ''
`).get().c;

console.log(`[backfill-vocab-fks] Rows needing backfill: ${nullCount}`);

if (nullCount === 0) {
  console.log("[backfill-vocab-fks] Nothing to do. Exiting.");
  db.close();
  process.exit(0);
}

// ── Fetch candidate rows ──────────────────────────────────────

const rows = db.prepare(`
  SELECT smv.uuid, smv.definition_id, smv.value_text
  FROM song_metadata_values smv
  JOIN metadata_definitions md ON md.id = smv.definition_id
  WHERE md.data_type IN ('single_choice', 'multi_choice')
    AND smv.value_vocabulary_id IS NULL
    AND smv.value_text IS NOT NULL
    AND smv.value_text != ''
`).all();

// ── Build vocab lookup: definition_id → Map<value, id> ───────

const vocabRows = db.prepare(`
  SELECT id, definition_id, value FROM metadata_vocabulary
`).all();

const vocabLookup = new Map(); // "defId:value" → id
for (const v of vocabRows) {
  vocabLookup.set(`${v.definition_id}:${v.value}`, v.id);
}

// ── Atomic backfill ───────────────────────────────────────────

const updateStmt = db.prepare(`
  UPDATE song_metadata_values SET value_vocabulary_id = ? WHERE uuid = ?
`);

let updated = 0;
let unmatched = 0;

const backfill = db.transaction(() => {
  for (const row of rows) {
    const key   = `${row.definition_id}:${row.value_text}`;
    const vocabId = vocabLookup.get(key);
    if (vocabId == null) {
      console.log(`[backfill-vocab-fks] WARN  no vocab match for def=${row.definition_id} value="${row.value_text}"`);
      unmatched++;
      continue;
    }
    updateStmt.run(vocabId, row.uuid);
    updated++;
  }
});

backfill();

// ── Post-flight verify ────────────────────────────────────────

const remaining = db.prepare(`
  SELECT COUNT(*) AS c
  FROM song_metadata_values smv
  JOIN metadata_definitions md ON md.id = smv.definition_id
  WHERE md.data_type IN ('single_choice', 'multi_choice')
    AND smv.value_vocabulary_id IS NULL
    AND smv.value_text IS NOT NULL
    AND smv.value_text != ''
`).get().c;

console.log("");
console.log("═".repeat(50));
console.log(`Updated:    ${updated}`);
console.log(`Unmatched:  ${unmatched}`);
console.log(`Remaining:  ${remaining}`);
console.log("═".repeat(50));

if (remaining > 0 && unmatched === 0) {
  console.error("[backfill-vocab-fks] ERROR: rows remain but none were unmatched — unexpected");
  db.close();
  process.exit(1);
}

console.log("[backfill-vocab-fks] Done.");
db.close();
