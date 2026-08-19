'use strict';
// Migration v41 — artwork_cache: locally cached cover art, WITH ITS PROVENANCE.
//
// Jeff's ruling, 2026-08-19: the Jukebox uses the library's existing artwork pipeline (embedded art
// first), and the iTunes Search API as the FALLBACK for tracks with no local cover — the same
// in-house, non-commercial use as the rest of Ether.
//
// This supersedes the 08-04 §3 ruling that banned music-store lookups on the wall. That ruling was
// about a REQUEST STORM — an uncached lookup per tile across thousands of songs. The objection was
// never to iTunes; it was to hammering it. With this table plus a disk cache and a rate limiter, a
// given (title, artist) is fetched at most once, ever.
//
// WHY THE SOURCE IS STORED, when nothing today reads it:
//   Apple's terms differ for commercial deployment. If Ether is ever sold into a context that needs
//   different artwork rights, the question "which images came from iTunes?" must be answerable by a
//   query, not by a code hunt through every render path. `source` makes that a config flip:
//   SELECT ... WHERE source = 'itunes' names every affected image and its local file.
//   It costs one TEXT column and changes no behaviour.
//
// NEGATIVE CACHING IS DELIBERATE. A lookup that finds nothing writes a row with local_path NULL, so
// a track with genuinely no cover art is asked about ONCE rather than on every render forever. That
// distinction matters: local_path NULL means "asked, nothing there", not "never asked" — the absence
// of a row is what means never asked.
//
// LOCAL-ONLY BY CONSTRUCTION: no uuid column, absent from synced-tables.js. This is one machine's
// disk cache — the files it points at exist only here, so a row travelling to a peer would name a
// path that machine does not have. Written with raw SQL so nothing is journalled.
//
// Idempotent. Verify on a COPY first:
//   ELECTRON_RUN_AS_NODE=1 electron.exe scripts/migrate-artwork-cache-phase-sync-41.js <copy.db>

const TABLE = 'artwork_cache';

function tableExists(db, t) {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
}
function isAlreadyMigrated(db) { return tableExists(db, TABLE); }

function applyMigration(db) {
  const migrate = db.transaction(() => {
    if (!tableExists(db, TABLE)) {
      db.prepare(`
        CREATE TABLE ${TABLE} (
          -- normalised "title::artist", lowercased and stripped of the noise that makes the same song
          -- look like three (feat., remaster suffixes). Built by electron/artwork-cache.js:cacheKey.
          cache_key   TEXT PRIMARY KEY,
          title       TEXT,
          artist      TEXT,
          -- PROVENANCE. 'itunes' today. The whole point of the column: a future rights decision is a
          -- query, not an archaeology exercise.
          source      TEXT    NOT NULL,
          -- the remote URL the image came from, kept so a cached file can be traced to its origin
          source_url  TEXT,
          -- absolute path to the cached file on THIS machine. NULL = looked up, nothing found
          -- (negative cache). No row at all = never looked up. Those are different facts.
          local_path  TEXT,
          fetched_at  INTEGER NOT NULL,
          bytes       INTEGER
        )`).run();
      // Answering "what came from iTunes, and how much of it is there?" should not be a table scan.
      db.prepare(`CREATE INDEX idx_${TABLE}_source ON ${TABLE} (source)`).run();
    }
    try { db.prepare('INSERT INTO schema_version (version) VALUES (41)').run(); } catch { /* recorded */ }
    console.log(`[migrate-v41] ${TABLE} ready.`);
  });
  migrate();
  console.log('[migrate-v41] Transaction committed.');
}

module.exports = {
  // Pass-through: artwork_cache is local-only and absent from synced-tables.js, so no payload ever
  // carries it and there is nothing on the wire to rewrite.
  payloadTransformer: function payloadTransformer(payload) { return payload; },
  applyMigration,
  isAlreadyMigrated,
};

if (require.main === module) {
  const path = require('path');
  const Database = require('better-sqlite3');

  const dbPath = process.argv[2];
  if (!dbPath) {
    console.error('Usage: node scripts/migrate-artwork-cache-phase-sync-41.js <path-to-db-COPY>');
    console.error('NEVER point this at the live openair.db while Ether is open.');
    process.exit(1);
  }
  console.log(`[migrate-v41] target: ${path.resolve(dbPath)}`);
  const db = new Database(dbPath);

  applyMigration(db);

  let allPass = true;
  const check = (label, ok, detail) => {
    if (!ok) allPass = false;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  };

  check(`${TABLE} exists`, tableExists(db, TABLE));

  const cols = db.prepare(`PRAGMA table_info("${TABLE}")`).all().map(c => c.name);
  for (const c of ['cache_key', 'title', 'artist', 'source', 'source_url', 'local_path', 'fetched_at', 'bytes']) {
    check(`column ${c}`, cols.includes(c), cols.join(','));
  }

  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=?").all(TABLE)
                .map(r => r.name);
  check('source index exists', idx.includes(`idx_${TABLE}_source`), idx.join(','));

  // A hit and a negative both round-trip, and they stay distinguishable.
  try {
    db.exec('BEGIN');
    const ins = db.prepare(`INSERT INTO ${TABLE} (cache_key, title, artist, source, source_url, local_path, fetched_at, bytes)
                            VALUES (?,?,?,?,?,?,?,?)`);
    const now = Math.floor(Date.now() / 1000);
    ins.run('be our guest::angela lansbury', 'Be Our Guest', 'Angela Lansbury', 'itunes',
            'https://is1.example/600x600bb.jpg', 'C:/cache/abc.jpg', now, 40213);
    ins.run('unknown track::nobody', 'Unknown Track', 'Nobody', 'itunes', null, null, now, null);

    const hit = db.prepare(`SELECT * FROM ${TABLE} WHERE cache_key = 'be our guest::angela lansbury'`).get();
    const neg = db.prepare(`SELECT * FROM ${TABLE} WHERE cache_key = 'unknown track::nobody'`).get();
    check('a cached image records its local file and its source', !!hit && hit.local_path === 'C:/cache/abc.jpg' && hit.source === 'itunes');
    check('a miss is cached NEGATIVELY — asked, nothing there', !!neg && neg.local_path === null);
    check('"asked and found nothing" is distinguishable from "never asked"',
          !!neg && db.prepare(`SELECT * FROM ${TABLE} WHERE cache_key = 'never asked::at all'`).get() === undefined);

    const itunes = db.prepare(`SELECT COUNT(*) c FROM ${TABLE} WHERE source = 'itunes'`).get().c;
    check('provenance is queryable — the future rights decision is one SELECT', itunes === 2, `${itunes} rows`);
    db.exec('ROLLBACK');
  } catch (e) {
    check('rows round-trip', false, e.message);
    try { db.exec('ROLLBACK'); } catch { /* already */ }
  }

  try {
    applyMigration(db);
    check('second run is a clean no-op', tableExists(db, TABLE));
  } catch (e) {
    check('second run is a clean no-op', false, e.message);
  }

  db.close();
  if (!allPass) { console.error('\nOne or more post-verification checks FAILED.'); process.exit(1); }
  console.log('\nAll checks PASSED — migration v41 complete.');
}
