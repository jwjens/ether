'use strict';

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(
  process.env.APPDATA || require('os').homedir() + '/AppData/Roaming',
  'Electron', 'openair.db'
);

console.log('Opening:', DB_PATH);
const db = new Database(DB_PATH, { readonly: true });

// ── Query 1: SMV rows for song 1 ──────────────────────────────
console.log('\n═══ song_metadata_values for song_id = 1 ═══\n');
const smvRows = db.prepare(`
  SELECT
    smv.id,
    smv.uuid         AS smv_uuid,
    smv.song_id,
    smv.definition_id,
    smv.value_text,
    smv.value_vocabulary_id,
    smv.deleted_at   AS smv_deleted_at,
    mv.id            AS vocab_id,
    mv.value         AS vocab_value,
    mv.deleted_at    AS vocab_deleted_at,
    md.name          AS def_name,
    md.deleted_at    AS def_deleted_at
  FROM song_metadata_values smv
  LEFT JOIN metadata_vocabulary mv ON mv.id = smv.value_vocabulary_id
  LEFT JOIN metadata_definitions md ON md.id = smv.definition_id
  WHERE smv.song_id = 1
  ORDER BY smv.id
`).all();

if (smvRows.length === 0) {
  console.log('  (no rows)');
} else {
  smvRows.forEach(r => {
    console.log(JSON.stringify(r, null, 2));
  });
}

console.log(`\n  Total smv rows for song 1 (including soft-deleted): ${smvRows.length}`);
const activeSmv = smvRows.filter(r => !r.smv_deleted_at);
const deletedSmv = smvRows.filter(r => !!r.smv_deleted_at);
console.log(`  Active (smv_deleted_at IS NULL): ${activeSmv.length}`);
console.log(`  Soft-deleted (smv_deleted_at NOT NULL): ${deletedSmv.length}`);

// ── Query 2: Recent mutations ─────────────────────────────────
console.log('\n═══ mutations ORDER BY rowid DESC LIMIT 30 ═══\n');
const mutations = db.prepare(`
  SELECT id, table_name, row_id, op, parent_mutation_id, created_at
  FROM mutations
  ORDER BY rowid DESC
  LIMIT 30
`).all();

if (mutations.length === 0) {
  console.log('  (no mutations)');
} else {
  mutations.forEach(m => {
    console.log(JSON.stringify(m));
  });
}

// ── Summary ───────────────────────────────────────────────────
const smvDeleteMutations = mutations.filter(m => m.table_name === 'song_metadata_values' && m.op === 'delete');
const vocabDeleteMutations = mutations.filter(m => m.table_name === 'metadata_vocabulary' && m.op === 'delete');
console.log(`\n  SMV delete mutations in last 30: ${smvDeleteMutations.length}`);
console.log(`  Vocab delete mutations in last 30: ${vocabDeleteMutations.length}`);
if (smvDeleteMutations.length > 0) {
  const withParent = smvDeleteMutations.filter(m => m.parent_mutation_id);
  console.log(`  SMV deletes with parent_mutation_id: ${withParent.length}`);
}

db.close();
