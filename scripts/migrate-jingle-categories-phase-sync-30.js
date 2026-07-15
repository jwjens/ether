'use strict';
// Migration v30 — jingle_categories: per-station jingle rotation pools with overlay timing + cadence
// (JINGLES Overlay v1; builds on v29 content_class). Design: docs/jingles-content-class-design-2026-07-09.md
// + docs/jingles-overlay-v1-build-proposal-2026-07-14.md (GO'd 2026-07-14, D2=A: jingle_categories table).
//
// ADDITIVE + non-switching:
//   • jingle_categories table — per-station, soft-deletable, synced (station_id scopes it; each station
//     gets its own set, names reusable across stations). Mirrors spot_categories (v24) + carries the
//     overlay timing that the design puts PER-CATEGORY:
//       - lead_in_sec     REAL  DEFAULT 5  (jingle starts this long before the outgoing song ends)
//       - underlap_sec    REAL  DEFAULT 2  (next song starts this long before the jingle ends)
//       - cadence_every_n INT   DEFAULT 4  (fire one LRP jingle from this category every N segues)
//   • songs.jingle_category_id column — which jingle pool a JIN song belongs to (NULL = unassigned; the
//     daemon then applies the category defaults). content_class='JIN' (v29) still marks the song a jingle;
//     this only groups jingles into rotation pools with their own timing/cadence.
//
// Jingles remain in the UNIFIED songs table (content_class='JIN', v29) — no parallel jingle song table.
// This adds only the CATEGORY grouping, exactly as spot_categories groups spots. Jingles stay excluded
// from music math / affidavit at the query layer (v29/1b) — untouched here.
//
// Idempotent: if jingle_categories already exists, just records v30 and returns.
// Verify on a COPY first: node scripts/migrate-jingle-categories-phase-sync-30.js <copy.db>

function tableExists(db, t) {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
}
function hasCol(db, t, col) {
  try { return db.prepare(`PRAGMA table_info("${t}")`).all().some(c => c.name === col); } catch { return false; }
}
function isAlreadyMigrated(db) { return tableExists(db, 'jingle_categories'); }

function applyMigration(db) {
  if (isAlreadyMigrated(db)) {
    try { db.prepare('INSERT INTO schema_version (version) VALUES (30)').run(); } catch (e) { /* already recorded */ }
    console.log('[migrate-v30] SKIP — jingle_categories already exists');
    return;
  }
  const migrate = db.transaction(() => {
    db.prepare(`
      CREATE TABLE jingle_categories (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        name            TEXT NOT NULL,
        color           TEXT,
        lead_in_sec     REAL NOT NULL DEFAULT 5,
        underlap_sec    REAL NOT NULL DEFAULT 2,
        cadence_every_n INTEGER NOT NULL DEFAULT 4,
        sort_order      INTEGER NOT NULL DEFAULT 0,
        station_id      INTEGER,
        uuid            TEXT,
        created_at      TEXT,
        updated_at      TEXT,
        deleted_at      TEXT
      )
    `).run();
    // Names unique WITHIN a station, reusable again after a soft-delete (mirrors spot_categories v24 / categories v23).
    db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_jingle_categories_name_station ON jingle_categories(name, station_id) WHERE deleted_at IS NULL').run();
    // songs.jingle_category_id — which jingle pool a JIN song belongs to (NULL = uncategorized).
    if (!hasCol(db, 'songs', 'jingle_category_id')) {
      db.prepare('ALTER TABLE songs ADD COLUMN jingle_category_id INTEGER').run();
    }
    db.prepare('INSERT INTO schema_version (version) VALUES (30)').run();
  });
  migrate();
  console.log('[migrate-v30] Transaction committed.');
}

module.exports = {
  payloadTransformer: function payloadTransformer(payload) {
    // Identity — jingle_categories is brand new (no older payloads to transform), and the new
    // songs.jingle_category_id simply defaults to NULL on any song payload that predates it.
    return payload;
  },
  applyMigration,
};

if (require.main === module) {
  const path = require('path');
  const os = require('os');
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const dbPath = process.argv[2] || path.join(localAppData, 'Ether', 'com.ether.radio', 'openair.db');
  const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));
  const db = new Database(dbPath);

  console.log('=== migrate-jingle-categories-phase-sync-30.js ===');
  console.log('DB:', dbPath, isAlreadyMigrated(db) ? '(already migrated — will no-op)' : '');

  const versions = db.prepare('SELECT version FROM schema_version ORDER BY version').all().map(r => r.version);
  console.log('schema_version rows:', JSON.stringify(versions));
  console.log('current schema_version:', Math.max(...versions));

  applyMigration(db);

  console.log('\n=== Post-verification ===');
  let allPass = true;
  const check = (label, pass, detail) => {
    console.log(`[${pass ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`);
    if (!pass) allPass = false;
  };
  const newVersion = Math.max(...db.prepare('SELECT version FROM schema_version ORDER BY version').all().map(r => r.version));
  check('schema_version = 30', newVersion === 30, `got ${newVersion}`);
  check('jingle_categories table exists', tableExists(db, 'jingle_categories'));
  const cols = db.prepare('PRAGMA table_info(jingle_categories)').all().map(r => r.name);
  for (const col of ['id', 'name', 'color', 'lead_in_sec', 'underlap_sec', 'cadence_every_n', 'sort_order', 'station_id', 'uuid', 'created_at', 'updated_at', 'deleted_at']) {
    check(`jingle_categories.${col} exists`, cols.includes(col), cols.join(', '));
  }
  const idxExists = !!db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_jingle_categories_name_station'").get();
  check('idx_jingle_categories_name_station index exists', idxExists);
  check('songs.jingle_category_id column exists', hasCol(db, 'songs', 'jingle_category_id'));
  const rowCount = db.prepare('SELECT COUNT(*) as c FROM jingle_categories').get().c;
  check('jingle_categories is empty', rowCount === 0, `rows: ${rowCount}`);
  // Defaults sanity: insert a probe row, confirm 5/2/4 defaults, then roll back.
  try {
    db.prepare('BEGIN').run();
    db.prepare("INSERT INTO jingle_categories (name, station_id) VALUES ('__probe__', 999)").run();
    const p = db.prepare("SELECT lead_in_sec, underlap_sec, cadence_every_n FROM jingle_categories WHERE name='__probe__'").get();
    check('defaults lead_in=5 / underlap=2 / cadence=4', p.lead_in_sec === 5 && p.underlap_sec === 2 && p.cadence_every_n === 4, JSON.stringify(p));
    db.prepare('ROLLBACK').run();
  } catch (e) { check('defaults probe', false, e.message); try { db.prepare('ROLLBACK').run(); } catch {} }

  db.close();
  if (!allPass) { console.error('\nOne or more post-verification checks FAILED.'); process.exit(1); }
  console.log('\nAll checks PASSED — migration v30 complete.');
}
