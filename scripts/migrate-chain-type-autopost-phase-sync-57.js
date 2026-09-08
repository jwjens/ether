'use strict';
// Migration v57 — AUTO-POST: the opt-in, what a placement carries, and the outro column's NAME.
//
// UNSET IS TODAY, BYTE FOR BYTE. `categories.overlay_chain_type` is NULL on every row this creates, and
// a NULL chain type takes the existing LEAD path unchanged. Nothing about any seam moves until an
// operator sets one category to 'auto_post'. That is the whole safety property of this slice.
//
// WHAT AUTO-POST IS. The song owns the timing: its `post_ms` says how much room exists before the
// vocal, the engine picks a cut that fits, and the cut ends exactly on the post.
//   selection:  cut_end_ms <= post_ms - segueOverlap
//   fire:       when the INCOMING deck's position >= post - cut_end
// The subtraction of segueOverlap is Jeff's ruling of 2026-09-08 — strict rather than clever. It is
// also what protects the OUTGOING song: the incoming starts when the outgoing has segueOverlap left, so
// firing at or after that point means a sweeper can never talk over the end of a song.
//
// COLUMNS ON THE PLACEMENT, so the daemon never queries at fire time and ON DECK can explain itself:
//   chain_type            what was ASKED for  ('auto_post' | NULL = lead)
//   chain_type_effective  what actually APPLIED ('auto_post' | 'lead' | 'none') and therefore why
//   post_ms               the incoming song's post, copied at Generate
//   cut_end_ms            the chosen cut's AUDIBLE end from file start (cue_out, else outro_start,
//                         else duration) — the engine plays from sample 0, so this is the number the
//                         fire point is computed against, not a trimmed length
//
// THE OUTRO COLUMN IS NAMED AND NOTHING READS IT (Jeff's ruling): `end_post_ms` on songs and
// library_asset, with the same _source / _confirmed_at honesty as post_ms, so the pair reads as a pair
// before either ships near a peer. Deliberate outro imaging is a slice of its own and is not built.
//
//   ELECTRON_RUN_AS_NODE=1 electron.exe scripts/migrate-chain-type-autopost-phase-sync-57.js <copy.db>

const VERSION = 57;

const ADDS = [
  ['categories',         'overlay_chain_type',    'TEXT'],
  ['generated_schedule', 'chain_type',            'TEXT'],
  ['generated_schedule', 'chain_type_effective',  'TEXT'],
  ['generated_schedule', 'post_ms',               'INTEGER'],
  ['generated_schedule', 'cut_end_ms',            'INTEGER'],
  ['songs',              'end_post_ms',           'INTEGER'],
  ['songs',              'end_post_source',       'TEXT'],
  ['songs',              'end_post_confirmed_at', 'TEXT'],
  ['library_asset',      'end_post_ms',           'INTEGER'],
  ['library_asset',      'end_post_source',       'TEXT'],
  ['library_asset',      'end_post_confirmed_at', 'TEXT'],
];

function tableExists(db, t) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
}
function hasCol(db, t, c) {
  try { return db.prepare(`PRAGMA table_info(${t})`).all().some(x => x.name === c); }
  catch { return false; }
}

function applyMigration(db) {
  const already = !!db.prepare('SELECT 1 FROM schema_version WHERE version = ?').get(VERSION);
  const added = [], skipped = [], missing = [];

  const migrate = db.transaction(() => {
    for (const [table, col, type] of ADDS) {
      // `songs` is a VIEW over songs_all on a v4.4.151+ database; ALTER against a view throws, so the
      // real table takes the column and the view inherits it. Reported, never guessed at.
      const target = (table === 'songs' && tableExists(db, 'songs_all')) ? 'songs_all' : table;
      if (!tableExists(db, target)) { missing.push(`${target}.${col}`); continue; }
      if (hasCol(db, target, col)) { skipped.push(`${target}.${col}`); continue; }
      db.prepare(`ALTER TABLE ${target} ADD COLUMN ${col} ${type}`).run();
      added.push(`${target}.${col}`);
    }
    if (!already) db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(VERSION);
  });
  migrate();

  for (const c of added)   console.log(`[migrate-v57] added   ${c}`);
  for (const c of skipped) console.log(`[migrate-v57] present ${c} — left alone`);
  for (const c of missing) console.log(`[migrate-v57] table for ${c} does not exist — skipped, not created`);
  console.log(`[migrate-v57] ${added.length} column(s) added, ${skipped.length} already present`);
  console.log('[migrate-v57] overlay_chain_type is NULL everywhere — every seam behaves exactly as before');
  console.log('[migrate-v57] end_post_ms is NAMED ONLY — nothing reads it');
}

module.exports = {
  payloadTransformer: function payloadTransformer(payload) {
    // A pre-v57 peer sends categories rows with no chain type and placements with no post. Left ALONE:
    // absent means "the LEAD path", which is what that peer is running. Filling it in here would make a
    // peer's row claim a behaviour that peer does not have.
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
  console.log('=== migrate-chain-type-autopost-phase-sync-57.js ===');
  console.log('DB:', dbPath);
  applyMigration(db);
  db.close();
}
