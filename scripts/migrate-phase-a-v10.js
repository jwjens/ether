// scripts/migrate-phase-a-v10.js — Phase A v10 schema migration
//
// Run with: node_modules/.bin/electron --no-sandbox scripts/migrate-phase-a-v10.js
// Dry-run:  node_modules/.bin/electron --no-sandbox scripts/migrate-phase-a-v10.js --dry-run
//
// What it does (single atomic transaction):
//   1. Backs up openair.db to openair.db.pre-v10.<timestamp>.bak
//   2. Pre-flight 1: schema_version MAX must be 9; aborts if already v10
//   3. Pre-flight 2: station 1 must have exactly 47 built-in definitions
//   4. Transaction:
//        a. For each station where COUNT(is_built_in=1 definitions) = 0:
//             - Copy 47 metadata_definitions from station 1 (new UUIDs)
//             - Copy matching metadata_vocabulary from station 1 (new UUIDs)
//        b. INSERT OR IGNORE schema_version = 10
//        c. INSERT OR REPLACE system_state.schema_version = '10'
//   5. Post-migration verification: every station has 47 definitions + 35 vocab rows
//
// Idempotent: per-station seeding is skipped when the station already has
// is_built_in=1 definitions (COUNT > 0). The schema_version INSERT is
// OR IGNORE so duplicate runs do not error.

'use strict';

const path   = require('path');
const os     = require('os');
const fs     = require('fs');
const crypto = require('crypto');

// ── Config ────────────────────────────────────────────────────────────────────

const DRY_RUN = process.argv.includes('--dry-run');
const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const dbPath  = path.join(appData, 'com.ether.radio', 'openair.db');

console.log('[migrate-v10] DB path:', dbPath);
if (DRY_RUN) console.log('[migrate-v10] DRY-RUN mode — no changes will be committed');
console.log('');

if (!fs.existsSync(dbPath)) {
  console.error('[migrate-v10] ERROR: DB not found at', dbPath);
  process.exit(1);
}

const Database = require(path.join(__dirname, '../node_modules/better-sqlite3'));

// ── Backup ────────────────────────────────────────────────────────────────────

const datestamp = new Date().toISOString()
  .replace('T', '-')
  .replace(/:/g, '')
  .replace(/\..+Z$/, '')
  .replace(/^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})$/, '$1$2$3-$4$5$6');
const bakPath = dbPath + '.pre-v10.' + datestamp + '.bak';

if (!DRY_RUN) {
  console.log('[migrate-v10] Backing up DB to:', bakPath);
  fs.copyFileSync(dbPath, bakPath);
  console.log('[migrate-v10] Backup created ✓');
} else {
  console.log('[migrate-v10] DRY-RUN — skipping backup');
}
console.log('');

// ── Open DB ───────────────────────────────────────────────────────────────────

const db = new Database(dbPath, { timeout: 10000 });

function abort(msg) {
  console.error('[migrate-v10] ABORT:', msg);
  try { db.close(); } catch (_) {}
  process.exit(1);
}

// ── Pre-flight 1: schema_version ──────────────────────────────────────────────

console.log('═'.repeat(60));
console.log('PRE-FLIGHT CHECKS');
console.log('═'.repeat(60));

const svVersions = db.prepare('SELECT version FROM schema_version ORDER BY version').all().map(r => r.version);
console.log('[migrate-v10] schema_version rows:', JSON.stringify(svVersions));

if (svVersions.includes(10)) {
  abort('v10 already applied — schema_version contains 10. Nothing to do.');
}

const maxVersion = svVersions.length > 0 ? Math.max(...svVersions) : 0;
if (maxVersion < 9) {
  abort(`schema_version MAX is ${maxVersion}; expected 9. Run all prior migrations first.`);
}
console.log(`[migrate-v10] Pre-flight 1: schema_version MAX = ${maxVersion} ✓`);

// ── Pre-flight 2: station 1 built-in definitions ──────────────────────────────

const EXPECTED_DEFS  = 47;
const EXPECTED_VOCAB = 35; // Genre=10 + Era=7 + Tempo Feel=4 + Vocal Type=4 + Mood=5 + Kind=5

const station1DefCount = db.prepare(
  'SELECT COUNT(*) AS n FROM metadata_definitions WHERE station_id=1 AND is_built_in=1 AND deleted_at IS NULL'
).get().n;

if (station1DefCount !== EXPECTED_DEFS) {
  abort(`station 1 has ${station1DefCount} built-in definitions, expected ${EXPECTED_DEFS}. Cannot proceed.`);
}
console.log(`[migrate-v10] Pre-flight 2: station 1 has ${EXPECTED_DEFS} built-in definitions (source of truth) ✓`);

// ── Identify stations needing backfill ────────────────────────────────────────

const allStations = db.prepare(
  'SELECT id, name FROM stations WHERE deleted_at IS NULL ORDER BY id'
).all();

const stationsNeedingBackfill = allStations.filter(s => {
  if (s.id === 1) return false;
  const n = db.prepare(
    'SELECT COUNT(*) AS n FROM metadata_definitions WHERE station_id=? AND is_built_in=1 AND deleted_at IS NULL'
  ).get(s.id).n;
  return n === 0;
});

console.log(`[migrate-v10] All stations: ${allStations.map(s => `${s.id}(${s.name})`).join(', ')}`);
if (stationsNeedingBackfill.length === 0) {
  console.log('[migrate-v10] No stations need backfill — definitions already present on all stations.');
  console.log('[migrate-v10] Bumping schema_version to 10 only.');
} else {
  console.log(`[migrate-v10] Stations needing backfill: ${stationsNeedingBackfill.map(s => `${s.id}(${s.name})`).join(', ')}`);
}
console.log('');

// ── Fetch source data from station 1 ─────────────────────────────────────────

const sourceDefs = db.prepare(
  'SELECT * FROM metadata_definitions WHERE station_id=1 AND is_built_in=1 AND deleted_at IS NULL ORDER BY display_order'
).all();

const sourceVocabByDefId = {};
for (const def of sourceDefs) {
  sourceVocabByDefId[def.id] = db.prepare(
    'SELECT * FROM metadata_vocabulary WHERE definition_id=? AND deleted_at IS NULL ORDER BY display_order'
  ).all(def.id);
}

const station1VocabTotal = Object.values(sourceVocabByDefId).reduce((sum, rows) => sum + rows.length, 0);
console.log(`[migrate-v10] Source: ${sourceDefs.length} definitions, ${station1VocabTotal} vocabulary rows from station 1`);
console.log('');

// ── Prepared statements ───────────────────────────────────────────────────────

const insertDef = db.prepare(`
  INSERT OR IGNORE INTO metadata_definitions
    (uuid, station_id, name, data_type, description, is_built_in, is_required, display_order, created_at, updated_at, deleted_at)
  VALUES
    (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
`);

const insertVocab = db.prepare(`
  INSERT OR IGNORE INTO metadata_vocabulary
    (uuid, station_id, definition_id, value, display_order, color, created_at, updated_at, deleted_at)
  VALUES
    (?, ?, ?, ?, ?, ?, ?, ?, NULL)
`);

const getDefByName = db.prepare(
  'SELECT id FROM metadata_definitions WHERE station_id=? AND name=? AND deleted_at IS NULL'
);

// ── Migration transaction ─────────────────────────────────────────────────────

console.log('═'.repeat(60));
console.log('RUNNING MIGRATION');
console.log('═'.repeat(60));
console.log('');

const now = new Date().toISOString();
let totalDefsInserted  = 0;
let totalVocabInserted = 0;

const doMigration = db.transaction(() => {

  for (const station of stationsNeedingBackfill) {
    console.log(`[migrate-v10] Backfilling station ${station.id} (${station.name})...`);

    let stationDefs  = 0;
    let stationVocab = 0;

    // Map source def id → new def id for this station
    const newDefIdBySourceId = {};

    for (const def of sourceDefs) {
      const result = insertDef.run(
        crypto.randomUUID(), station.id,
        def.name, def.data_type, def.description,
        def.is_built_in, def.is_required, def.display_order,
        now, now
      );
      if (result.changes > 0) {
        newDefIdBySourceId[def.id] = result.lastInsertRowid;
        stationDefs++;
      } else {
        // OR IGNORE fired — row already existed (idempotent re-run)
        const existing = getDefByName.get(station.id, def.name);
        if (existing) newDefIdBySourceId[def.id] = existing.id;
      }
    }

    for (const [sourceDefIdStr, vocabRows] of Object.entries(sourceVocabByDefId)) {
      const sourceDefId = Number(sourceDefIdStr);
      const newDefId = newDefIdBySourceId[sourceDefId];
      if (!newDefId) continue;
      for (const vocab of vocabRows) {
        const result = insertVocab.run(
          crypto.randomUUID(), station.id, newDefId,
          vocab.value, vocab.display_order, vocab.color,
          now, now
        );
        if (result.changes > 0) stationVocab++;
      }
    }

    totalDefsInserted  += stationDefs;
    totalVocabInserted += stationVocab;
    console.log(`[migrate-v10]   station ${station.id}: ${stationDefs} definitions + ${stationVocab} vocabulary rows inserted ✓`);
  }

  // Bump schema_version
  db.prepare('INSERT OR IGNORE INTO schema_version (version) VALUES (10)').run();
  console.log('[migrate-v10] schema_version = 10 inserted ✓');

  // Stamp system_state so mutation-writer sees the new version immediately
  db.prepare(
    "INSERT OR REPLACE INTO system_state (key, value, updated_at) VALUES ('schema_version', '10', unixepoch())"
  ).run();
  console.log('[migrate-v10] system_state.schema_version = 10 stamped ✓');

});

if (DRY_RUN) {
  console.log('[migrate-v10] DRY-RUN — transaction NOT committed');
  console.log(`[migrate-v10] Would backfill ${stationsNeedingBackfill.length} station(s)`);
  console.log(`[migrate-v10] Would insert ${stationsNeedingBackfill.length * EXPECTED_DEFS} definitions and ${stationsNeedingBackfill.length * EXPECTED_VOCAB} vocabulary rows`);
  db.close();
  process.exit(0);
}

doMigration();

// ── Post-migration verification ───────────────────────────────────────────────

console.log('');
console.log('═'.repeat(60));
console.log('POST-MIGRATION VERIFICATION');
console.log('═'.repeat(60));

let allOk = true;
function verify(label, ok, detail) {
  if (ok) { console.log('  PASS  ' + label); }
  else     { console.error('  FAIL  ' + label + (detail ? ' — ' + detail : '')); allOk = false; }
}

for (const station of allStations) {
  const defCount = db.prepare(
    'SELECT COUNT(*) AS n FROM metadata_definitions WHERE station_id=? AND is_built_in=1 AND deleted_at IS NULL'
  ).get(station.id).n;
  verify(
    `station ${station.id} (${station.name}): ${EXPECTED_DEFS} built-in definitions`,
    defCount === EXPECTED_DEFS,
    `got ${defCount}`
  );

  const vocabCount = db.prepare(`
    SELECT COUNT(*) AS n FROM metadata_vocabulary mv
    JOIN metadata_definitions md ON md.id = mv.definition_id
    WHERE mv.station_id=? AND md.is_built_in=1
      AND mv.deleted_at IS NULL AND md.deleted_at IS NULL
  `).get(station.id).n;
  verify(
    `station ${station.id} (${station.name}): ${EXPECTED_VOCAB} vocabulary rows`,
    vocabCount === EXPECTED_VOCAB,
    `got ${vocabCount}`
  );
}

const newMaxVer = db.prepare('SELECT MAX(version) AS v FROM schema_version').get().v;
verify('schema_version MAX = 10', newMaxVer === 10, `got ${newMaxVer}`);

const ssRow = db.prepare("SELECT value FROM system_state WHERE key='schema_version'").get();
verify("system_state.schema_version = '10'", ssRow?.value === '10', `got ${ssRow?.value}`);

console.log('');
if (allOk) {
  console.log('v10 migration COMPLETE ✓');
  if (stationsNeedingBackfill.length === 0) {
    console.log('All stations already had built-in definitions — only schema_version bumped.');
  } else {
    console.log(
      `Backfilled ${stationsNeedingBackfill.length} station(s): ` +
      `${totalDefsInserted} definitions + ${totalVocabInserted} vocabulary rows inserted.`
    );
  }
} else {
  console.error('[migrate-v10] One or more post-migration checks FAILED.');
  console.error('[migrate-v10] DB backup preserved at:', bakPath);
}

db.close();
process.exit(allOk ? 0 : 1);
