// scripts/verify-vocab-fks.js — read-only diagnostic for value_vocabulary_id correctness
//
// Run with: node_modules/.bin/electron --no-sandbox scripts/verify-vocab-fks.js
// IMPORTANT: Read-only. No writes.
//
// Shows the 5 most-recently-updated song_metadata_values rows, then for any row
// with a non-null value_vocabulary_id resolves the matching metadata_vocabulary row.

const path = require("path");
const os   = require("os");
const fs   = require("fs");

const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
const dbPath  = path.join(appData, "com.ether.radio", "openair.db");

console.log("[verify-vocab-fks] DB path:", dbPath);
console.log("");

if (!fs.existsSync(dbPath)) {
  console.error("[verify-vocab-fks] ERROR: DB not found at", dbPath);
  process.exit(1);
}

const Database = require(path.join(__dirname, "../node_modules/better-sqlite3"));
const db = new Database(dbPath, { readonly: true });

// ── Last 5 smv rows ───────────────────────────────────────────

const rows = db.prepare(`
  SELECT song_id, definition_id, value_text, value_vocabulary_id, updated_at
  FROM song_metadata_values
  ORDER BY updated_at DESC
  LIMIT 5
`).all();

console.log("═".repeat(72));
console.log("LAST 5 song_metadata_values ROWS (by updated_at DESC)");
console.log("═".repeat(72));

if (rows.length === 0) {
  console.log("  (no rows found)");
} else {
  for (const r of rows) {
    const fkStatus = r.value_vocabulary_id != null ? `FK=${r.value_vocabulary_id}` : "FK=NULL";
    console.log(`  song_id=${r.song_id}  def_id=${r.definition_id}  value_text="${r.value_text}"  ${fkStatus}  updated_at=${r.updated_at}`);
  }
}

console.log("");

// ── Resolve FKs ───────────────────────────────────────────────

const withFk = rows.filter(r => r.value_vocabulary_id != null);

if (withFk.length === 0) {
  console.log("  WARNING: No rows with value_vocabulary_id populated.");
  console.log("  Commit 1 FK writes may not have fired for recent saves.");
} else {
  console.log("═".repeat(72));
  console.log("FK RESOLUTION (value_vocabulary_id → metadata_vocabulary)");
  console.log("═".repeat(72));

  for (const r of withFk) {
    const vocab = db.prepare(`
      SELECT id, value, color FROM metadata_vocabulary WHERE id = ?
    `).get(r.value_vocabulary_id);

    if (!vocab) {
      console.log(`  FK=${r.value_vocabulary_id} → DANGLING (no matching vocab row!) — value_text="${r.value_text}"`);
    } else {
      const match = vocab.value === r.value_text ? "MATCH" : `MISMATCH (vocab.value="${vocab.value}" vs value_text="${r.value_text}")`;
      const colorStr = vocab.color ? `color=${vocab.color}` : "color=NULL";
      console.log(`  FK=${r.value_vocabulary_id} → vocab.value="${vocab.value}"  ${colorStr}  [${match}]`);
    }
  }
}

console.log("");
console.log("═".repeat(72));
console.log(`Summary: ${rows.length} rows shown, ${withFk.length} with FK populated`);
console.log("═".repeat(72));

db.close();
