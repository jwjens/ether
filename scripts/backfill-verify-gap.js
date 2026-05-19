'use strict';
// scripts/backfill-verify-gap.js — prove the gap query is correct before --write.
//
// Answers three questions:
//  1. For each of the 9 gap tables: null-uuid count, distinct-uuid-in-mutations
//     count, and full accounting (has-mutation + gap = total, zero remainder).
//  2. The exact identity join: shows one real artist mutation's row_id and
//     payload_after so the predicate can be verified by eye.
//  3. DB write-time freshness check: hlc_last + mutations MAX created_at,
//     so we know whether OV is generating new mutations under us.
//
// Run via:  npx electron --no-sandbox scripts/backfill-verify-gap.js

const path = require('path');
const os   = require('os');
const fs   = require('fs');

const ROOT    = path.join(__dirname, '..');
const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const DB_PATH = path.join(appData, 'com.ether.radio', 'openair.db');

const GAP_TABLES = [
  'artists', 'install_config_kv',
  'categories', 'operators', 'separation_rules',
  'metadata_definitions', 'metadata_vocabulary',
  'clocks', 'station_programming',
];

function sep(label) {
  console.log('\n' + '═'.repeat(72));
  console.log('  ' + label);
  console.log('═'.repeat(72));
}

function main() {
  if (!fs.existsSync(DB_PATH)) { console.error('DB not found:', DB_PATH); process.exit(1); }

  const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
  const db = new Database(DB_PATH, { readonly: true });

  // ── 1. Full accounting per table ─────────────────────────────────────────
  sep('1 — Full accounting: total = has-mutation + gap (must be exact)');

  console.log('\n  ' +
    'table'.padEnd(26) +
    'total'.padStart(8) +
    'null-uuid'.padStart(11) +
    'has-mutation'.padStart(14) +
    'gap'.padStart(6) +
    '  sum=total?'
  );
  console.log('  ' + '─'.repeat(69));

  let anyFail = false;

  for (const tname of GAP_TABLES) {
    const total = db.prepare(`SELECT COUNT(*) as c FROM "${tname}"`).get()?.c ?? 0;

    const nullUuid = db.prepare(
      `SELECT COUNT(*) as c FROM "${tname}" WHERE uuid IS NULL`
    ).get()?.c ?? 0;

    // Rows that have at least one mutation (any op) identified by uuid
    const hasMutation = db.prepare(`
      SELECT COUNT(*) as c FROM "${tname}" t
      WHERE t.uuid IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM mutations m
          WHERE m.table_name = ? AND m.row_id = t.uuid
        )
    `).get(tname)?.c ?? 0;

    // Rows in the gap (no mutation, uuid non-null)
    const gap = db.prepare(`
      SELECT COUNT(*) as c FROM "${tname}" t
      WHERE t.uuid IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM mutations m
          WHERE m.table_name = ? AND m.row_id = t.uuid
        )
    `).get(tname)?.c ?? 0;

    const sum   = nullUuid + hasMutation + gap;
    const match = sum === total ? '✓' : `✗ SUM=${sum} TOTAL=${total}`;
    if (sum !== total) anyFail = true;

    const nullMark = nullUuid > 0 ? '⚠' : ' ';
    console.log(
      `  ${nullMark} ${tname.padEnd(25)}` +
      `${String(total).padStart(8)}` +
      `${String(nullUuid).padStart(11)}` +
      `${String(hasMutation).padStart(14)}` +
      `${String(gap).padStart(6)}` +
      `  ${match}`
    );
  }

  if (anyFail) {
    console.log('\n  ✗ ACCOUNTING FAILURE — gap query does not partition rows cleanly.');
  } else {
    console.log('\n  ✓ All tables: null-uuid + has-mutation + gap = total exactly.');
  }

  // ── 2. Artists deep-dive ─────────────────────────────────────────────────
  sep('2 — Artists: independent verification of both halves');

  const artistTotal  = db.prepare('SELECT COUNT(*) as c FROM artists').get()?.c;
  const artistNonNull = db.prepare('SELECT COUNT(*) as c FROM artists WHERE uuid IS NOT NULL').get()?.c;
  const artistNullUuid = artistTotal - artistNonNull;

  // How many DISTINCT artist UUIDs appear in mutations.row_id?
  const distinctInMutations = db.prepare(`
    SELECT COUNT(DISTINCT m.row_id) as c
    FROM mutations m
    WHERE m.table_name = 'artists'
      AND m.row_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM artists a WHERE a.uuid = m.row_id)
  `).get()?.c ?? 0;

  // Cross-check: distinct UUIDs in mutations.row_id for artists (may include deleted rows)
  const distinctInMutationsAll = db.prepare(`
    SELECT COUNT(DISTINCT row_id) as c FROM mutations WHERE table_name = 'artists'
  `).get()?.c ?? 0;

  const gapCount = db.prepare(`
    SELECT COUNT(*) as c FROM artists t
    WHERE t.uuid IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM mutations m WHERE m.table_name = 'artists' AND m.row_id = t.uuid)
  `).get()?.c;

  console.log(`\n  Total artists rows       : ${artistTotal}`);
  console.log(`  Non-null uuid            : ${artistNonNull}`);
  console.log(`  Null uuid                : ${artistNullUuid}`);
  console.log(`  Distinct artist UUIDs in mutations (live rows only)  : ${distinctInMutations}`);
  console.log(`  Distinct artist UUIDs in mutations (incl. orphans)   : ${distinctInMutationsAll}`);
  console.log(`  Gap (NOT EXISTS on uuid) : ${gapCount}`);
  console.log(`\n  Accounting: null(${artistNullUuid}) + has-mutation(${distinctInMutations}) + gap(${gapCount}) = ${artistNullUuid + distinctInMutations + gapCount} (expect ${artistTotal})`);

  const artistOk = (artistNullUuid + distinctInMutations + gapCount) === artistTotal;
  console.log(`  Result: ${artistOk ? '✓ exact match' : '✗ MISMATCH'}`);

  // ── 3. Identity join proof: one real artist mutation ─────────────────────
  sep('3 — Identity join proof: one real artist mutation');

  const sampleMutation = db.prepare(`
    SELECT id, table_name, row_id, op, payload_after
    FROM mutations
    WHERE table_name = 'artists'
    ORDER BY created_at DESC
    LIMIT 1
  `).get();

  if (!sampleMutation) {
    console.log('\n  No artist mutations found.');
  } else {
    console.log(`\n  mutations.id         : ${sampleMutation.id}`);
    console.log(`  mutations.table_name : ${sampleMutation.table_name}`);
    console.log(`  mutations.row_id     : ${sampleMutation.row_id}`);
    console.log(`  mutations.op         : ${sampleMutation.op}`);

    let payload = null;
    try { payload = JSON.parse(sampleMutation.payload_after); } catch (_) {}
    if (payload) {
      console.log(`\n  payload_after.id     : ${payload.id}`);
      console.log(`  payload_after.uuid   : ${payload.uuid}`);
      console.log(`  payload_after.name   : ${payload.name}`);
    } else {
      console.log('\n  payload_after: (null or unparseable)');
    }

    // Verify: does an artists row exist with uuid = mutations.row_id?
    const artistRow = db.prepare('SELECT id, uuid, name FROM artists WHERE uuid = ?').get(sampleMutation.row_id);
    console.log(`\n  Live artists row for that row_id:`);
    if (artistRow) {
      console.log(`    id=${artistRow.id}  uuid=${artistRow.uuid}  name=${artistRow.name}`);
      const joinMatch = sampleMutation.row_id === artistRow.uuid;
      console.log(`  mutations.row_id === artists.uuid : ${joinMatch ? '✓ YES' : '✗ NO'}`);
    } else {
      console.log('    (no live row — row may have been deleted; this is OK)');
    }
    if (payload) {
      const payloadMatch = payload.uuid === sampleMutation.row_id;
      console.log(`  payload_after.uuid === row_id     : ${payloadMatch ? '✓ YES' : '✗ NO'}`);
    }
  }

  // Also show a sample of an artist row that IS in the gap
  const gapSample = db.prepare(`
    SELECT a.id, a.uuid, a.name, a.created_at
    FROM artists a
    WHERE a.uuid IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM mutations m WHERE m.table_name = 'artists' AND m.row_id = a.uuid)
    ORDER BY a.id
    LIMIT 3
  `).all();

  console.log(`\n  Sample gap rows (artists with no mutation, joined on uuid):`);
  for (const r of gapSample) {
    console.log(`    id=${r.id}  uuid=${r.uuid}  name=${r.name}  created_at=${r.created_at}`);
  }

  // ── 4. DB freshness: is OV generating mutations right now? ────────────────
  sep('4 — DB freshness: is OV generating new mutations?');

  const hlcLast = db.prepare("SELECT value, updated_at FROM system_state WHERE key = 'hlc_last'").get();
  const maxMutCreated = db.prepare('SELECT MAX(created_at) as v FROM mutations').get()?.v;
  const mutCount = db.prepare('SELECT COUNT(*) as c FROM mutations').get()?.c;

  console.log(`\n  mutations total count        : ${mutCount}`);
  console.log(`  mutations MAX created_at     : ${maxMutCreated}`);
  console.log(`  system_state hlc_last value  : ${hlcLast?.value}`);
  console.log(`  system_state hlc_last updated: ${hlcLast?.updated_at}`);
  console.log(`\n  (If hlc_last.updated_at is very recent, OV is actively syncing.)`);
  console.log('  (Run this script twice ~10s apart and compare counts to confirm liveness.)');

  db.close();
}

main();
process.exit(0);
