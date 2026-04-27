'use strict';

// scripts/migrate-metadata-tables-phase-sync-6.js — Phase Sync-6
//
// Run with: node scripts/migrate-metadata-tables-phase-sync-6.js
//   OR:     node_modules/.bin/electron --no-sandbox scripts/migrate-metadata-tables-phase-sync-6.js
// IMPORTANT: Stop the Ether app before running.
//
// What it does (single atomic transaction):
//   1. Backs up openair.db to openair.db.pre-v6.<timestamp>.bak
//   2. Pre-flight 1: schema_version must be exactly [1,2,3,4,5]; aborts if already v6
//   3. Pre-flight 2: metadata_definitions table must NOT already exist
//   4. Transaction:
//        a. CREATE TABLE metadata_definitions + 2 indexes
//        b. CREATE TABLE metadata_vocabulary + 3 indexes
//        c. CREATE TABLE song_metadata_values + 4 indexes
//        d. For each row in stations: seed 47 metadata_definitions (is_built_in=1, is_required=0)
//           + 35 starter vocabulary rows for the 6 single_choice definitions
//        e. INSERT version=6 into schema_version
//   5. Post-migration verification:
//        - metadata_definitions count = 47 × stations.count
//        - metadata_vocabulary count  = 35 × stations.count
//        - song_metadata_values count = 0 (no song data seeded)
//        - mutations row count unchanged
//        - all 9 indexes present
//        - schema_version = [1,2,3,4,5,6]

// payloadTransformer: identity. v6 adds tables only; no payload field changes.
module.exports = {
  payloadTransformer: function payloadTransformer(payload, fromVersion) {
    if (!payload || typeof payload !== 'object') return payload;
    return payload;
  },
};

// ── Migration body ────────────────────────────────────────────
// Pattern for migration scripts run under Electron: require.main !== module because
// Electron's bootstrapper owns require.main. Use _isMain guard below for all future
// migration scripts that must run via `electron --no-sandbox`.

const _scriptArg = process.argv.slice(1).find(a => !a.startsWith('-'));
const _isMain = require.main === module ||
  (_scriptArg && require('path').resolve(_scriptArg) === __filename);
if (_isMain) {

const path   = require('path');
const os     = require('os');
const fs     = require('fs');
const crypto = require('crypto');

const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const dbPath  = path.join(appData, 'com.ether.radio', 'openair.db');

if (!fs.existsSync(dbPath)) {
  console.error('[migrate-v6] ERROR: DB not found at', dbPath);
  process.exit(1);
}

const Database = require(path.join(__dirname, '../node_modules/better-sqlite3'));

// ── Helpers ───────────────────────────────────────────────────

function abort(db, msg) {
  console.error('[migrate-v6] ABORT:', msg);
  try { db.close(); } catch (_) {}
  process.exit(1);
}

// ── Backup ────────────────────────────────────────────────────

const datestamp = new Date().toISOString()
  .replace('T', '-')
  .replace(/:/g, '')
  .replace(/\..+Z$/, '')
  .replace(/^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})$/, '$1$2$3-$4$5$6');
const bakPath = dbPath + '.pre-v6.' + datestamp + '.bak';
console.log('[migrate-v6] Backing up DB to:', bakPath);
fs.copyFileSync(dbPath, bakPath);
console.log('[migrate-v6] Backup created ✓');
console.log('');

// ── Open DB ───────────────────────────────────────────────────

const db = new Database(dbPath, { timeout: 10000 });

// ── Pre-flight check 1: schema_version ───────────────────────

console.log('═'.repeat(60));
console.log('PRE-FLIGHT CHECKS');
console.log('═'.repeat(60));

const svVersions = db.prepare('SELECT version FROM schema_version ORDER BY version').all().map(r => r.version);
console.log('[migrate-v6] schema_version rows:', JSON.stringify(svVersions));

if (svVersions.includes(6)) {
  abort(db, 'v6 already applied — schema_version contains 6. Nothing to do.');
}
if (svVersions.length !== 5 || !([1,2,3,4,5].every((v,i) => svVersions[i] === v))) {
  abort(db, `expected schema_version = [1,2,3,4,5], got ${JSON.stringify(svVersions)}. Ensure migrations 1-5 have run.`);
}
console.log('[migrate-v6] Pre-flight 1: schema_version = [1,2,3,4,5] ✓');

// ── Pre-flight check 2: metadata_definitions must not exist ──

const mdExists = db.prepare(
  "SELECT name FROM sqlite_master WHERE type='table' AND name='metadata_definitions'"
).get();
if (mdExists) {
  abort(db, 'metadata_definitions table already exists — schema may already be patched. Check schema_version.');
}
console.log('[migrate-v6] Pre-flight 2: metadata_definitions does not exist yet ✓');

// ── Pre-migration counts ──────────────────────────────────────

const beforeMutationsCount = db.prepare('SELECT COUNT(*) AS n FROM mutations').get().n;
const stationCount         = db.prepare('SELECT COUNT(*) AS n FROM stations').get().n;
console.log('[migrate-v6] mutations row count before migration:', beforeMutationsCount);
console.log('[migrate-v6] stations count:', stationCount);
console.log('');

const EXPECTED_DEFS             = 47;
const EXPECTED_VOCAB_PER_STATION = 35; // 10+7+4+4+5+5
const expectedDefsTotal         = EXPECTED_DEFS * stationCount;
const expectedVocabTotal        = EXPECTED_VOCAB_PER_STATION * stationCount;
console.log(`[migrate-v6] Expected metadata_definitions after: ${expectedDefsTotal} (${EXPECTED_DEFS} × ${stationCount} station(s))`);
console.log(`[migrate-v6] Expected metadata_vocabulary after:  ${expectedVocabTotal} (${EXPECTED_VOCAB_PER_STATION} × ${stationCount} station(s))`);
console.log('');

// ── Seed data ─────────────────────────────────────────────────

const DEFINITIONS = [
  // ── User-editable built-ins ──────────────────────────────────
  { name: 'Title',             data_type: 'text',          description: 'Song title',                            display_order:  1 },
  { name: 'Artist',            data_type: 'text',          description: 'Primary artist name',                   display_order:  2 },
  { name: 'Album',             data_type: 'text',          description: 'Album name',                            display_order:  3 },
  { name: 'Album Artist',      data_type: 'text',          description: 'Album artist name',                     display_order:  4 },
  { name: 'Composer',          data_type: 'text',          description: 'Composer name',                         display_order:  5 },
  { name: 'Year',              data_type: 'number',        description: 'Release year',                          display_order:  6 },
  { name: 'Genre',             data_type: 'single_choice', description: 'Music genre',                           display_order:  7 },
  { name: 'BPM',               data_type: 'number',        description: 'Beats per minute',                      display_order:  8 },
  { name: 'Energy',            data_type: 'number',        description: 'Energy level (0-10)',                   display_order:  9 },
  { name: 'Mood',              data_type: 'single_choice', description: 'Song mood',                             display_order: 10 },
  { name: 'Comments',          data_type: 'text',          description: 'General comments',                      display_order: 11 },
  { name: 'Description',       data_type: 'text',          description: 'Song description',                      display_order: 12 },
  { name: 'Grouping',          data_type: 'text',          description: 'Content grouping',                      display_order: 13 },
  { name: 'Movement Name',     data_type: 'text',          description: 'Classical movement name',               display_order: 14 },
  { name: 'Movement Number',   data_type: 'number',        description: 'Classical movement number',             display_order: 15 },
  { name: 'Work',              data_type: 'text',          description: 'Musical work name',                     display_order: 16 },
  { name: 'Track Number',      data_type: 'number',        description: 'Track number on album',                 display_order: 17 },
  { name: 'Disc Number',       data_type: 'number',        description: 'Disc number',                           display_order: 18 },
  { name: 'Release Date',      data_type: 'date',          description: 'Official release date',                 display_order: 19 },
  { name: 'Purchase Date',     data_type: 'date',          description: 'Purchase date',                         display_order: 20 },
  { name: 'Rating',            data_type: 'number',        description: 'Song rating (0-5)',                     display_order: 21 },
  { name: 'Album Rating',      data_type: 'number',        description: 'Album rating (0-5)',                    display_order: 22 },
  { name: 'Favorite',          data_type: 'boolean',       description: 'Marked as favorite',                    display_order: 23 },
  { name: 'Era',               data_type: 'single_choice', description: 'Musical era or decade',                 display_order: 24 },
  { name: 'Tempo Feel',        data_type: 'single_choice', description: 'Subjective tempo feel',                 display_order: 25 },
  { name: 'Vocal Type',        data_type: 'single_choice', description: 'Vocal type or arrangement',             display_order: 26 },
  { name: 'ISRC',              data_type: 'text',          description: 'International Standard Recording Code', display_order: 27 },
  { name: 'Intro Time',        data_type: 'number',        description: 'Intro duration in seconds',             display_order: 28 },
  { name: 'Outro Time',        data_type: 'number',        description: 'Outro duration in seconds',             display_order: 29 },
  { name: 'Sort Title',        data_type: 'text',          description: 'Sort key for title',                    display_order: 30 },
  { name: 'Sort Artist',       data_type: 'text',          description: 'Sort key for artist',                   display_order: 31 },
  { name: 'Sort Album',        data_type: 'text',          description: 'Sort key for album',                    display_order: 32 },
  { name: 'Sort Album Artist', data_type: 'text',          description: 'Sort key for album artist',             display_order: 33 },
  { name: 'Sort Composer',     data_type: 'text',          description: 'Sort key for composer',                 display_order: 34 },
  // ── System-populated built-ins (auto-filled, user-editable) ──
  { name: 'Length',            data_type: 'number',        description: 'Track length in seconds (auto)',        display_order: 35 },
  { name: 'Date Added',        data_type: 'date',          description: 'Date added to library (auto)',          display_order: 36 },
  { name: 'Date Modified',     data_type: 'date',          description: 'Date file was last modified (auto)',    display_order: 37 },
  { name: 'Last Played',       data_type: 'date',          description: 'Date last played (auto)',               display_order: 38 },
  { name: 'Last Skipped',      data_type: 'date',          description: 'Date last skipped (auto)',              display_order: 39 },
  { name: 'Plays',             data_type: 'number',        description: 'Total play count (auto)',               display_order: 40 },
  { name: 'Skips',             data_type: 'number',        description: 'Total skip count (auto)',               display_order: 41 },
  { name: 'Bit Rate',          data_type: 'number',        description: 'Audio bit rate in kbps (auto)',         display_order: 42 },
  { name: 'Sample Rate',       data_type: 'number',        description: 'Audio sample rate in Hz (auto)',        display_order: 43 },
  { name: 'Size',              data_type: 'number',        description: 'File size in bytes (auto)',             display_order: 44 },
  { name: 'Kind',              data_type: 'single_choice', description: 'Audio file format (auto)',              display_order: 45 },
  { name: 'Cloud Download',    data_type: 'boolean',       description: 'Cloud download status (auto)',          display_order: 46 },
  { name: 'Cloud Status',      data_type: 'text',          description: 'Cloud sync status (auto)',              display_order: 47 },
];

// Starter vocabulary for the 6 single_choice definitions.
// Counts: Genre=10, Era=7, Tempo Feel=4, Vocal Type=4, Mood=5, Kind=5 → 35 total per station.
const VOCABULARY = {
  'Genre':      ['Rock', 'Pop', 'Country', 'Jazz', 'R&B', 'Hip-Hop', 'Electronic', 'Classical', 'Folk', 'World'],
  'Era':        ['60s', '70s', '80s', '90s', '2000s', '2010s', '2020s'],
  'Tempo Feel': ['Slow', 'Medium', 'Fast', 'Variable'],
  'Vocal Type': ['Male', 'Female', 'Group', 'Instrumental'],
  'Mood':       ['Upbeat', 'Mellow', 'Aggressive', 'Sad', 'Neutral'],
  'Kind':       ['MP3', 'WAV', 'AAC', 'FLAC', 'AIFF'],
};

// ── Atomic migration transaction ──────────────────────────────

console.log('═'.repeat(60));
console.log('RUNNING MIGRATION');
console.log('═'.repeat(60));
console.log('');

db.transaction(() => {

  // Step 1: CREATE TABLE metadata_definitions + 2 indexes
  console.log('[migrate-v6] Step 1: CREATE TABLE metadata_definitions');
  db.prepare(`
    CREATE TABLE metadata_definitions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      uuid          TEXT    NOT NULL UNIQUE,
      station_id    INTEGER NOT NULL REFERENCES stations(id),
      name          TEXT    NOT NULL,
      data_type     TEXT    NOT NULL CHECK (data_type IN ('text','number','single_choice','multi_choice','boolean','date')),
      description   TEXT,
      is_built_in   INTEGER NOT NULL DEFAULT 0,
      is_required   INTEGER NOT NULL DEFAULT 0,
      display_order INTEGER NOT NULL DEFAULT 0,
      created_at    TEXT    NOT NULL,
      updated_at    TEXT    NOT NULL,
      deleted_at    TEXT,
      UNIQUE (station_id, name)
    )
  `).run();
  db.prepare('CREATE INDEX idx_metadata_definitions_station_id ON metadata_definitions (station_id)').run();
  db.prepare('CREATE INDEX idx_metadata_definitions_uuid       ON metadata_definitions (uuid)').run();
  console.log('[migrate-v6] Step 1: metadata_definitions + 2 indexes ✓');

  // Step 2: CREATE TABLE metadata_vocabulary + 3 indexes
  console.log('[migrate-v6] Step 2: CREATE TABLE metadata_vocabulary');
  db.prepare(`
    CREATE TABLE metadata_vocabulary (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      uuid          TEXT    NOT NULL UNIQUE,
      station_id    INTEGER NOT NULL,
      definition_id INTEGER NOT NULL REFERENCES metadata_definitions(id),
      value         TEXT    NOT NULL,
      display_order INTEGER NOT NULL DEFAULT 0,
      color         TEXT,
      created_at    TEXT    NOT NULL,
      updated_at    TEXT    NOT NULL,
      deleted_at    TEXT,
      UNIQUE (definition_id, value)
    )
  `).run();
  db.prepare('CREATE INDEX idx_metadata_vocabulary_definition_id ON metadata_vocabulary (definition_id)').run();
  db.prepare('CREATE INDEX idx_metadata_vocabulary_station_id    ON metadata_vocabulary (station_id)').run();
  db.prepare('CREATE INDEX idx_metadata_vocabulary_uuid          ON metadata_vocabulary (uuid)').run();
  console.log('[migrate-v6] Step 2: metadata_vocabulary + 3 indexes ✓');

  // Step 3: CREATE TABLE song_metadata_values + 4 indexes
  console.log('[migrate-v6] Step 3: CREATE TABLE song_metadata_values');
  db.prepare(`
    CREATE TABLE song_metadata_values (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      uuid                TEXT    NOT NULL UNIQUE,
      station_id          INTEGER NOT NULL,
      song_id             INTEGER NOT NULL REFERENCES songs(id),
      definition_id       INTEGER NOT NULL REFERENCES metadata_definitions(id),
      value_text          TEXT,
      value_vocabulary_id INTEGER REFERENCES metadata_vocabulary(id),
      created_at          TEXT    NOT NULL,
      updated_at          TEXT    NOT NULL,
      deleted_at          TEXT
    )
  `).run();
  db.prepare('CREATE INDEX idx_song_metadata_values_song_id       ON song_metadata_values (song_id)').run();
  db.prepare('CREATE INDEX idx_song_metadata_values_definition_id ON song_metadata_values (definition_id)').run();
  db.prepare('CREATE INDEX idx_song_metadata_values_station_id    ON song_metadata_values (station_id)').run();
  db.prepare('CREATE INDEX idx_song_metadata_values_uuid          ON song_metadata_values (uuid)').run();
  console.log('[migrate-v6] Step 3: song_metadata_values + 4 indexes ✓');

  // Step 4: Seed definitions + vocabulary for each station
  const stations = db.prepare('SELECT id FROM stations').all();
  console.log(`[migrate-v6] Step 4: Seeding ${DEFINITIONS.length} definitions × ${stations.length} station(s)`);

  const now = new Date().toISOString();

  const insertDef = db.prepare(`
    INSERT INTO metadata_definitions
      (uuid, station_id, name, data_type, description, is_built_in, is_required, display_order, created_at, updated_at, deleted_at)
    VALUES
      (?, ?, ?, ?, ?, 1, 0, ?, ?, ?, NULL)
  `);

  const insertVocab = db.prepare(`
    INSERT INTO metadata_vocabulary
      (uuid, station_id, definition_id, value, display_order, color, created_at, updated_at, deleted_at)
    VALUES
      (?, ?, ?, ?, ?, NULL, ?, ?, NULL)
  `);

  for (const station of stations) {
    const defIdByName = {};
    for (const def of DEFINITIONS) {
      const result = insertDef.run(
        crypto.randomUUID(), station.id,
        def.name, def.data_type, def.description,
        def.display_order, now, now
      );
      defIdByName[def.name] = result.lastInsertRowid;
    }

    for (const [defName, values] of Object.entries(VOCABULARY)) {
      const defId = defIdByName[defName];
      values.forEach((value, idx) => {
        insertVocab.run(crypto.randomUUID(), station.id, defId, value, idx + 1, now, now);
      });
    }

    console.log(`[migrate-v6] Step 4:   station ${station.id} — ${DEFINITIONS.length} definitions + ${EXPECTED_VOCAB_PER_STATION} vocabulary rows ✓`);
  }

  // Step 5: Record schema version
  console.log('[migrate-v6] Step 5: INSERT version=6 into schema_version');
  db.prepare('INSERT INTO schema_version (version) VALUES (6)').run();
  console.log('[migrate-v6] Step 5: schema_version=6 written ✓');

})();

// ── Post-migration verification ───────────────────────────────

console.log('');
console.log('═'.repeat(60));
console.log('POST-MIGRATION VERIFICATION');
console.log('═'.repeat(60));

let allOk = true;
function verify(label, ok, detail) {
  if (ok) { console.log('  PASS  ' + label); }
  else     { console.error('  FAIL  ' + label + (detail ? ' — ' + detail : '')); allOk = false; }
}

// metadata_definitions count
const finalDefsCount = db.prepare('SELECT COUNT(*) AS n FROM metadata_definitions').get().n;
console.log('[migrate-v6] metadata_definitions count:', finalDefsCount);
verify(
  `metadata_definitions count = ${expectedDefsTotal} (${EXPECTED_DEFS} × ${stationCount})`,
  finalDefsCount === expectedDefsTotal,
  `got ${finalDefsCount}`
);

// metadata_vocabulary count
const finalVocabCount = db.prepare('SELECT COUNT(*) AS n FROM metadata_vocabulary').get().n;
console.log('[migrate-v6] metadata_vocabulary count:', finalVocabCount);
verify(
  `metadata_vocabulary count = ${expectedVocabTotal} (${EXPECTED_VOCAB_PER_STATION} × ${stationCount})`,
  finalVocabCount === expectedVocabTotal,
  `got ${finalVocabCount}`
);

// song_metadata_values empty
const smvCount = db.prepare('SELECT COUNT(*) AS n FROM song_metadata_values').get().n;
verify('song_metadata_values count = 0 (no song data seeded)', smvCount === 0, `got ${smvCount}`);

// mutations row count unchanged
const finalMutationsCount = db.prepare('SELECT COUNT(*) AS n FROM mutations').get().n;
verify(
  'mutations row count unchanged',
  finalMutationsCount === beforeMutationsCount,
  `expected ${beforeMutationsCount} got ${finalMutationsCount}`
);

// All 9 new indexes present
const allIndexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map(r => r.name);
const EXPECTED_INDEXES = [
  'idx_metadata_definitions_station_id',
  'idx_metadata_definitions_uuid',
  'idx_metadata_vocabulary_definition_id',
  'idx_metadata_vocabulary_station_id',
  'idx_metadata_vocabulary_uuid',
  'idx_song_metadata_values_song_id',
  'idx_song_metadata_values_definition_id',
  'idx_song_metadata_values_station_id',
  'idx_song_metadata_values_uuid',
];
for (const idx of EXPECTED_INDEXES) {
  verify(`index exists: ${idx}`, allIndexes.includes(idx));
}

// schema_version = [1,2,3,4,5,6]
const newSv = db.prepare('SELECT version FROM schema_version ORDER BY version').all().map(r => r.version);
verify('schema_version = [1,2,3,4,5,6]', JSON.stringify(newSv) === '[1,2,3,4,5,6]', `got ${JSON.stringify(newSv)}`);

console.log('');
if (allOk) {
  console.log('v6 migration COMPLETE ✓');
  console.log(`3 metadata tables created. ${EXPECTED_DEFS} definitions + ${EXPECTED_VOCAB_PER_STATION} vocabulary rows seeded per station (${stationCount} station(s)).`);
} else {
  console.error('One or more post-migration checks FAILED. DB backup preserved at:', bakPath);
}

db.close();
process.exit(allOk ? 0 : 1);

} // end if (_isMain)
