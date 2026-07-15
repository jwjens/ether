'use strict';
// Migration v31 — transition-attached JIN placement rows in generated_schedule (JINGLES Overlay v1).
// Architecture: ONE scheduler (ether-v2 §26; scheduler-rework-status #4). SELECTION stays in Generate —
// Generate applies the per-category cadence and writes a JIN placement ROW into generated_schedule bound
// to the seam it bridges (design doc jingles-content-class-design §Data shape, lines 187-197). The daemon
// stays a LOG-READER: it reads the placement and orchestrates the real-time overlay fire on CART. No
// in-daemon jingle selection (avoids the "two schedulers" the scheduler rework forbids).
//
// ADDITIVE — adds to generated_schedule:
//   • content_class    TEXT DEFAULT 'MUSIC'  — 'JIN' marks a jingle placement (not a deck/music row)
//   • channel          TEXT                  — 'CART' for a JIN row (overlay bus); NULL for music/spot
//   • lead_in_sec      REAL                  — snapshot of the jingle category's lead_in at placement time
//   • underlap_sec     REAL                  — snapshot of the jingle category's underlap at placement time
//   • jingle_category_id INTEGER             — which jingle pool this placement came from (reporting/color)
//
// A JIN row references the jingle song via the existing song_id column; the daemon resolves file_path via
// the songs join (COALESCE(gs.file_path, s.file_path)), exactly like readGeneratedSchedule. A JIN row does
// NOT hold a deck and MUST be excluded from the deck-queue fill (loggen) — it is read only as a seam overlay.
//
// Idempotent: adds only missing columns. Verify on a COPY first:
//   node scripts/migrate-generated-schedule-jingle-placement-phase-sync-31.js <copy.db>

function hasCol(db, t, col) {
  try { return db.prepare(`PRAGMA table_info("${t}")`).all().some(c => c.name === col); } catch { return false; }
}
function tableExists(db, t) {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
}
function isAlreadyMigrated(db) { return hasCol(db, 'generated_schedule', 'content_class'); }

function applyMigration(db) {
  const migrate = db.transaction(() => {
    let added = 0;
    if (tableExists(db, 'generated_schedule')) {
      const add = (col, ddl) => { if (!hasCol(db, 'generated_schedule', col)) { db.prepare(`ALTER TABLE generated_schedule ADD COLUMN ${ddl}`).run(); added++; } };
      add('content_class',     "content_class TEXT DEFAULT 'MUSIC'");
      add('channel',           'channel TEXT');
      add('lead_in_sec',       'lead_in_sec REAL');
      add('underlap_sec',      'underlap_sec REAL');
      add('jingle_category_id','jingle_category_id INTEGER');
      // Existing rows are all music → normalize any NULL class so the daemon's "exclude JIN" filter is well-defined.
      db.prepare("UPDATE generated_schedule SET content_class='MUSIC' WHERE content_class IS NULL OR content_class=''").run();
      // Reader index: the daemon queries JIN rows by (station, scheduled_at) at each seam.
      db.prepare("CREATE INDEX IF NOT EXISTS idx_gensched_class_station_at ON generated_schedule(station_id, content_class, scheduled_at)").run();
    }
    try { db.prepare('INSERT INTO schema_version (version) VALUES (31)').run(); } catch { /* already recorded */ }
    console.log(`[migrate-v31] generated_schedule JIN placement: +${added} column(s) (content_class/channel/lead_in_sec/underlap_sec/jingle_category_id).`);
  });
  migrate();
  console.log('[migrate-v31] Transaction committed.');
}

module.exports = {
  // JIN placement columns default to MUSIC/NULL on any pre-v31 generated_schedule payload — a music/spot
  // row that predates the columns is unaffected (content_class defaults MUSIC, channel NULL).
  payloadTransformer: function payloadTransformer(payload) {
    if (payload && (payload.content_class === undefined || payload.content_class === null || payload.content_class === '')) {
      payload.content_class = 'MUSIC';
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

  console.log('=== migrate-generated-schedule-jingle-placement-phase-sync-31.js ===');
  console.log('DB:', dbPath, isAlreadyMigrated(db) ? '(already migrated — will no-op)' : '');
  const versions = db.prepare('SELECT version FROM schema_version ORDER BY version').all().map(r => r.version);
  console.log('current schema_version:', Math.max(...versions));

  applyMigration(db);

  console.log('\n=== Post-verification ===');
  let allPass = true;
  const check = (label, pass, detail) => { console.log(`[${pass ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`); if (!pass) allPass = false; };
  const newVersion = Math.max(...db.prepare('SELECT version FROM schema_version ORDER BY version').all().map(r => r.version));
  check('schema_version = 31', newVersion === 31, `got ${newVersion}`);
  for (const col of ['content_class', 'channel', 'lead_in_sec', 'underlap_sec', 'jingle_category_id']) {
    check(`generated_schedule.${col} exists`, hasCol(db, 'generated_schedule', col));
  }
  const idxExists = !!db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_gensched_class_station_at'").get();
  check('idx_gensched_class_station_at index exists', idxExists);
  const nullClass = db.prepare("SELECT COUNT(*) c FROM generated_schedule WHERE content_class IS NULL OR content_class=''").get().c;
  check('no NULL content_class rows remain', nullClass === 0, `got ${nullClass}`);

  db.close();
  if (!allPass) { console.error('\nOne or more post-verification checks FAILED.'); process.exit(1); }
  console.log('\nAll checks PASSED — migration v31 complete.');
}
