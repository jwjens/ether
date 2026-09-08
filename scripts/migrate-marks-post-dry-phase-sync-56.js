'use strict';
// Migration v56 — THE MARKS. `post_ms` on a song, `dry_ms` on a cut.
//
// NOTHING READS THESE YET. Slice 3 (chain types) is what consumes them; until then this migration adds
// six nullable columns to two tables and changes no behaviour of any kind. A build carrying this
// migration and nothing else sounds exactly like the build before it — there is no code path, in the
// generator, the daemon or the Rust engine, that looks at a mark.
//
// WHY post_ms AND NOT intro_end_ms (Jeff's ruling, 2026-09-06):
//   "intro_end already means silence trim and I won't have two columns a suffix apart meaning
//   different things."
// `intro_end` is the silence boundary and keeps its meaning and its readers. `intro_end_ms` is empty
// on every row and reusing it would leave two columns differing by a suffix and meaning entirely
// different things — a trap that already cost one wrong measurement. One column, one meaning.
//
//   post_ms  — milliseconds from file start to where the VOCAL begins. The post.
//   dry_ms   — milliseconds of a cut that carry no music under the voice. A stinger with no voice at
//              all is fully dry (dry_ms = duration), which is a meaningful value, not a missing one.
//
// AN AUTO VALUE IS A CANDIDATE, NEVER A FACT. That is what `*_source` exists for: 'auto' means a
// detector proposed it and no human has agreed; 'operator' means someone set it by ear. `*_confirmed_at`
// records when a human last agreed. A surface that cannot tell the two apart would let a guess put a
// voice over a vocal, which is the exact failure the mark exists to prevent.
//
// BOTH TABLES, because a sweeper is a `songs` row (content_class='SWP') joined by uuid to a
// `library_asset` row (type='SWEEPER'), and the two are read by different code: _placeJingles reads
// `songs`, RACK reads `library_asset`. The same duplication the existing cue columns already carry.
//
// ADDITIVE ONLY. Six ALTER TABLE ADD COLUMN, all nullable, no backfill, no rewrite. An older build
// opening this database ignores columns it does not know; this build opening an older database finds
// them missing and adds them. Neither is stranded.
//
//   ELECTRON_RUN_AS_NODE=1 electron.exe scripts/migrate-marks-post-dry-phase-sync-56.js <copy.db>

const VERSION = 56;

const COLUMNS = [
  ['post_ms',           'INTEGER'],
  ['post_source',       'TEXT'],
  ['post_confirmed_at', 'TEXT'],
  ['dry_ms',            'INTEGER'],
  ['dry_source',        'TEXT'],
  ['dry_confirmed_at',  'TEXT'],
];
const TABLES = ['songs', 'library_asset'];

function tableExists(db, t) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
}
function hasCol(db, t, c) {
  try { return db.prepare(`PRAGMA table_info(${t})`).all().some(x => x.name === c); }
  catch { return false; }
}

function applyMigration(db) {
  const already = !!db.prepare('SELECT 1 FROM schema_version WHERE version = ?').get(VERSION);

  const added = [];
  const skipped = [];
  const missing = [];

  const migrate = db.transaction(() => {
    for (const t of TABLES) {
      // `songs` is a VIEW over songs_all on a v4.4.151+ database. ALTER TABLE against a view throws,
      // so the real table is preferred when it exists and the view inherits the column. A migration
      // reports what it cannot reshape; it does not guess at it.
      const target = (t === 'songs' && tableExists(db, 'songs_all')) ? 'songs_all' : t;
      if (!tableExists(db, target)) { missing.push(target); continue; }
      for (const [col, type] of COLUMNS) {
        if (hasCol(db, target, col)) { skipped.push(`${target}.${col}`); continue; }
        db.prepare(`ALTER TABLE ${target} ADD COLUMN ${col} ${type}`).run();
        added.push(`${target}.${col}`);
      }
    }
    if (!already) db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(VERSION);
  });
  migrate();

  for (const c of added)   console.log(`[migrate-v56] added   ${c}`);
  for (const c of skipped) console.log(`[migrate-v56] present ${c} — left alone`);
  for (const t of missing) console.log(`[migrate-v56] table ${t} does not exist — skipped, not created`);
  console.log(`[migrate-v56] ${added.length} column(s) added, ${skipped.length} already present`);
  console.log('[migrate-v56] nothing reads these columns yet — slice 3 (chain types) is what consumes them');
}

module.exports = {
  payloadTransformer: function payloadTransformer(payload) {
    // A pre-v56 peer sends songs / library_asset rows with no marks. Left ALONE: an absent mark is
    // exactly right — it means nobody has marked this row, which is the truthful state. Inventing a
    // post here would be the guess the whole *_source mechanism exists to prevent.
    return payload;
  },
  applyMigration,
};

if (require.main === module) {
  const path = require('path');
  const os   = require('os');
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const dbPath = process.argv[2] || path.join(localAppData, 'Ether', 'com.ether.radio', 'openair.db');

  const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));
  const db = new Database(dbPath);

  console.log('=== migrate-marks-post-dry-phase-sync-56.js ===');
  console.log('DB:', dbPath);
  applyMigration(db);
  db.close();
}
