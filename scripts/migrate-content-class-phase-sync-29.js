'use strict';
// Migration v29 — content_class: jingles as a first-class content class (Phase 1 of
// docs/jingles-content-class-design-2026-07-09.md; GO'd 2026-07-09).
//
// ADDITIVE + non-switching: adds `content_class TEXT` to `songs` (DEFAULT 'MUSIC') and `play_log`. Jingles
// live in the UNIFIED songs table as content_class='JIN' — no parallel jingle table (decision) — and are
// excluded from music math / affidavit at the QUERY layer (later phases), never by storage. All existing
// library rows are music → default MUSIC. Idempotent — re-running is a no-op.
// Verify on a COPY first: node scripts/migrate-content-class-phase-sync-29.js <copy.db>
//
// NOTE (flagged, not done here): unifying the separate `spots` table into `songs` (content_class='SPOT') is
// a larger, separate migration — spots stay in `spots` for now, tagged SPOT at the query/UI layer.

function hasCol(db, t, col) {
  try { return db.prepare(`PRAGMA table_info("${t}")`).all().some(c => c.name === col); } catch { return false; }
}
function tableExists(db, t) {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
}
function isAlreadyMigrated(db) { return hasCol(db, 'songs', 'content_class'); }

function applyMigration(db) {
  const migrate = db.transaction(() => {
    let added = 0;
    if (tableExists(db, 'songs')) {
      if (!hasCol(db, 'songs', 'content_class')) {
        db.prepare("ALTER TABLE songs ADD COLUMN content_class TEXT DEFAULT 'MUSIC'").run();
        added++;
      }
      db.prepare("UPDATE songs SET content_class='MUSIC' WHERE content_class IS NULL OR content_class=''").run();
      db.prepare("CREATE INDEX IF NOT EXISTS idx_songs_content_class ON songs(content_class)").run();
    }
    // play_log: flag each play's class for honest reporting. Going forward the logger sets MUSIC/JIN/SPOT;
    // historical rows default MUSIC (the affidavit's spot proof comes from the spots mirror, not this field).
    if (tableExists(db, 'play_log') && !hasCol(db, 'play_log', 'content_class')) {
      db.prepare("ALTER TABLE play_log ADD COLUMN content_class TEXT DEFAULT 'MUSIC'").run();
      added++;
    }
    try { db.prepare('INSERT INTO schema_version (version) VALUES (29)').run(); } catch { /* already recorded */ }
    console.log(`[migrate-v29] content_class: +${added} column(s) (songs DEFAULT MUSIC + play_log). Jingles=JIN live in songs; excluded from music math at the query layer.`);
  });
  migrate();
  console.log('[migrate-v29] Transaction committed.');
}

module.exports = {
  // content_class IS authored/synced per song row. An OLD peer's payload lacks it → default to MUSIC so a
  // pre-v29 song never syncs in as blank/unknown and never accidentally reads as a jingle.
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
  console.log('=== migrate-content-class-phase-sync-29.js ===');
  console.log('DB:', dbPath, isAlreadyMigrated(db) ? '(already migrated — will no-op)' : '');
  applyMigration(db);
  try {
    console.log('--- songs by content_class ---');
    for (const r of db.prepare("SELECT content_class, COUNT(*) n FROM songs GROUP BY content_class").all()) {
      console.log(`  ${r.content_class || '(null)'}: ${r.n}`);
    }
  } catch (e) { console.log('  readout failed:', e.message); }
  db.close();
}
