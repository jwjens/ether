'use strict';
// Migration v32 — JINGLES/SWEEPERS v2: per-music-category overlay ASSIGNMENT (supersedes v1 cadence).
// Design: docs/jingles-sweepers-v2-design-2026-07-15.md (GO'd 2026-07-15). Builds on v30 (jingle_categories)
// + v31 (transition-attached placement rows). ONE-scheduler compliant — this only changes the SELECTION
// rule (Generate resolves an assignment); the daemon log-reader + CART overlay are unchanged.
//
// ADDITIVE:
//   • jingle_categories.type TEXT DEFAULT 'JIN'  — types the overlay pool: 'JIN' (jingles) | 'SWP' (sweepers).
//     The v30 table now organizes the whole overlay library; each row is a rotating pool (LRP, burnout-safe).
//   • categories overlay-assignment columns (the core of v2): each MUSIC category names EITHER a specific
//     overlay item OR a pool, with its own timing + active hours.
//       - overlay_kind        TEXT     NULL | 'item' | 'pool'
//       - overlay_song_id     INTEGER  the specific JIN/SWP song (kind='item')
//       - overlay_category_id INTEGER  the pool to rotate within (kind='pool') -> jingle_categories.id
//       - overlay_lead_in_sec REAL     per-assignment lead-in (default at resolve time: jingle 5 / sweeper 2)
//       - overlay_underlap_sec REAL    per-assignment underlap (default: jingle 2 / sweeper 1)
//       - overlay_active_hours INTEGER 24-bit daypart mask, DEFAULT 16777215 (always) — keep imaging out of hours
//
// SWP content_class needs NO schema change (content_class is TEXT; 'SWP' is a new value, excluded from music
// math by the same Phase-1b filters as 'JIN'). The station-level fallback pool is stored in station_config_kv
// (key 'overlay_fallback_category_id') — no schema churn. generated_schedule needs no new columns (v31 carries
// SWP placements). Cadence (jingle_categories.cadence_every_n) is RETIRED — left as a dead column (no drops).
//
// Idempotent: adds only missing columns. Verify on a COPY first:
//   node scripts/migrate-overlay-assignment-phase-sync-32.js <copy.db>

function hasCol(db, t, col) {
  try { return db.prepare(`PRAGMA table_info("${t}")`).all().some(c => c.name === col); } catch { return false; }
}
function tableExists(db, t) { return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t); }
function isAlreadyMigrated(db) { return hasCol(db, 'categories', 'overlay_kind'); }

function applyMigration(db) {
  const migrate = db.transaction(() => {
    let added = 0;
    if (tableExists(db, 'jingle_categories') && !hasCol(db, 'jingle_categories', 'type')) {
      db.prepare("ALTER TABLE jingle_categories ADD COLUMN type TEXT DEFAULT 'JIN'").run(); added++;
    }
    if (tableExists(db, 'jingle_categories')) {
      db.prepare("UPDATE jingle_categories SET type='JIN' WHERE type IS NULL OR type=''").run();
    }
    if (tableExists(db, 'categories')) {
      const add = (col, ddl) => { if (!hasCol(db, 'categories', col)) { db.prepare(`ALTER TABLE categories ADD COLUMN ${ddl}`).run(); added++; } };
      add('overlay_kind',        'overlay_kind TEXT');
      add('overlay_song_id',     'overlay_song_id INTEGER');
      add('overlay_category_id', 'overlay_category_id INTEGER');
      add('overlay_lead_in_sec', 'overlay_lead_in_sec REAL');
      add('overlay_underlap_sec','overlay_underlap_sec REAL');
      add('overlay_active_hours','overlay_active_hours INTEGER DEFAULT 16777215');
    }
    try { db.prepare('INSERT INTO schema_version (version) VALUES (32)').run(); } catch { /* already recorded */ }
    console.log(`[migrate-v32] overlay assignment: +${added} column(s) (jingle_categories.type + categories.overlay_*). Cadence retired.`);
  });
  migrate();
  console.log('[migrate-v32] Transaction committed.');
}

module.exports = {
  // Overlay-assignment columns default to NULL / always-hours on any pre-v32 payload; jingle_categories.type
  // defaults to 'JIN' so an older pool syncs in as a jingle pool (never blank/unknown).
  payloadTransformer: function payloadTransformer(payload) {
    if (payload && (payload.type === undefined || payload.type === null || payload.type === '')) {
      // Only stamp 'type' on jingle_categories payloads — a categories/other payload has no 'type' field so
      // this is harmless there (the field simply isn't persisted for tables that don't have the column).
      payload.type = 'JIN';
    }
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

  console.log('=== migrate-overlay-assignment-phase-sync-32.js ===');
  console.log('DB:', dbPath, isAlreadyMigrated(db) ? '(already migrated — will no-op)' : '');
  const versions = db.prepare('SELECT version FROM schema_version ORDER BY version').all().map(r => r.version);
  console.log('current schema_version:', Math.max(...versions));

  applyMigration(db);

  console.log('\n=== Post-verification ===');
  let allPass = true;
  const check = (label, pass, detail) => { console.log(`[${pass ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`); if (!pass) allPass = false; };
  const newVersion = Math.max(...db.prepare('SELECT version FROM schema_version ORDER BY version').all().map(r => r.version));
  check('schema_version = 32', newVersion === 32, `got ${newVersion}`);
  check('jingle_categories.type exists', hasCol(db, 'jingle_categories', 'type'));
  for (const col of ['overlay_kind', 'overlay_song_id', 'overlay_category_id', 'overlay_lead_in_sec', 'overlay_underlap_sec', 'overlay_active_hours']) {
    check(`categories.${col} exists`, hasCol(db, 'categories', col));
  }
  // default active_hours = always (16777215) on a fresh categories row
  try {
    db.prepare('BEGIN').run();
    db.prepare("INSERT INTO categories (code, name, station_id) VALUES ('__probe32__', 'probe', 999)").run();
    const p = db.prepare("SELECT overlay_active_hours, overlay_kind FROM categories WHERE code='__probe32__'").get();
    check('overlay_active_hours defaults 16777215 (always), overlay_kind NULL', p.overlay_active_hours === 16777215 && p.overlay_kind == null, JSON.stringify(p));
    db.prepare('ROLLBACK').run();
  } catch (e) { check('defaults probe', false, e.message); try { db.prepare('ROLLBACK').run(); } catch {} }
  const jinType = (() => { try { return db.prepare("SELECT COUNT(*) c FROM jingle_categories WHERE type IS NULL OR type=''").get().c; } catch { return -1; } })();
  check('no NULL jingle_categories.type', jinType === 0, `got ${jinType}`);

  db.close();
  if (!allPass) { console.error('\nOne or more post-verification checks FAILED.'); process.exit(1); }
  console.log('\nAll checks PASSED — migration v32 complete.');
}
