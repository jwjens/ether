'use strict';
// Migration v37 — deletion_queue: the local record of songs whose R2 audio may eventually be
// released, and the complete row needed to put them back.
//
// Cause (docs/song-delete-sync-diagnosis-2026-08-14.md and the 2026-08-14 decisions):
//   Deleting a song has never removed its audio from R2. Releasing it safely needs three things the
//   product did not have: a durable record of WHAT was deleted, a grace period during which it can
//   be restored, and a place to record the outcome of the ownership checks. This table is all three.
//
// LOCAL-ONLY, DELIBERATELY. It is NOT added to electron/sync/synced-tables.js and carries no `uuid`
// column, because both of those are what make a table replicate. That matters more here than
// usual: a queue row is a statement about THIS machine's view of a file, and a released object is
// irreversible. A peer must never be able to push a deletion instruction into another install's
// queue. The authoritative account-scoped ownership check belongs to the backend, later.
//
// REPORT-ONLY at v37. Nothing in this release sends a DELETE to R2 or to any backend.
//
// STATUS VOCABULARY (see the sweep):
//   pending           grace period has not expired, or a check is still holding it
//   marked            every local check passed — eligible for a future DELETE, still not deleted
//   permanent_shared  another LIVE song references the same file_key — terminal, never re-reported
//   error             transient failure; retried on the next sweep
//   done              the R2 object has been released (or was already absent) — terminal
//   out_of_scope      hash-named (64-hex, content-addressed) object — NEVER released, terminal.
//                     Added with the mirror-on-delete release pass; one hash object backs any
//                     number of rows on any number of installs, so "sole reference" is a claim
//                     this queue is structurally unable to make about it.
//   unverifiable      a check could not be executed at all (e.g. no file_path to match play_log on).
//                     NOT the same as passing. Expected to be 0 today — every soft-deleted song
//                     still has its file_path — and exists so a future change that nulls the field
//                     degrades to "cannot tell" rather than silently to "clear".
//
// deleted_at and grace_expires_at are INTEGER epoch SECONDS. play_log.played_at is also an INTEGER
// epoch in seconds, and comparing that against datetime('now', …) TEXT is always false — a trap
// that already produced one wrong answer (0 rows vs the real 442). Keeping this table's time
// columns the same type as the ones they are compared against is the point.
//
// Idempotent: if deletion_queue already exists, records v37 and returns.
//
// Verified on a COPY before any live run. The live DB is migrated BY THE APP at startup
// (electron/main.js auto-discovers migrate-*-phase-sync-N.js and calls applyMigration) — never by
// running this script against the live file while Ether is open.

const TABLE = 'deletion_queue';

function tableExists(db, t) {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
}
function cols(db, t) {
  try { return db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name); } catch { return []; }
}
function isAlreadyMigrated(db) {
  return tableExists(db, TABLE);
}

function applyMigration(db) {
  if (isAlreadyMigrated(db)) {
    try { db.prepare('INSERT INTO schema_version (version) VALUES (37)').run(); } catch { /* recorded */ }
    console.log(`[migrate-v37] SKIP — ${TABLE} already exists`);
    return;
  }
  const migrate = db.transaction(() => {
    db.prepare(`
      CREATE TABLE ${TABLE} (
        id               INTEGER PRIMARY KEY,
        file_key         TEXT    NOT NULL,
        file_path        TEXT,
        station_id       INTEGER NOT NULL,
        -- The whole song row as it was BEFORE deletion. This is what makes the 30 days genuinely
        -- reversible rather than nominally so: restoring from a partial capture would resurrect a
        -- song missing its cue points, loudness and category.
        song_json        TEXT    NOT NULL,
        deleted_at       INTEGER NOT NULL,
        grace_expires_at INTEGER NOT NULL,
        status           TEXT    NOT NULL DEFAULT 'pending',
        reason           TEXT,
        last_checked_at  INTEGER
      )`).run();
    // The sweep's own query: rows past grace, in a workable status. Without this it is a full scan
    // on every daily tick.
    db.prepare(`CREATE INDEX idx_${TABLE}_sweep ON ${TABLE} (status, grace_expires_at)`).run();
    // Answering "is this key already queued" during enqueue.
    db.prepare(`CREATE INDEX idx_${TABLE}_file_key ON ${TABLE} (file_key)`).run();

    // ── BACKFILL — a product decision, not a convenience ──────────────────────────────────────
    // Songs deleted before this table existed were deleted WITH INTENT. Without a backfill they are
    // permanently unreachable by the pipeline: the enqueue hook only fires on future deletes, so
    // the existing backlog would never be cleaned and its R2 objects would sit there forever.
    //
    // deleted_at is THE SONG'S OWN deletion time, converted from its ISO TEXT to epoch seconds —
    // NOT now(). The grace period is a promise about how long a delete stays reversible, and it has
    // been running since the operator deleted the song. Stamping now() would silently restart a
    // clock that is already 39 days through, and hold back audio the operator released in July.
    //
    // GROUP BY file_key: several songs can share a key (22 such keys in the live DB). One object,
    // one queue row. MIN(deleted_at) is the conservative choice for the grace start… except it is
    // not needed here, because a key shared with a LIVE song resolves to permanent_shared anyway.
    // Taking the earliest keeps the row honest about when the first delete happened.
    const backfilled = db.prepare(`
      INSERT INTO ${TABLE} (file_key, file_path, station_id, song_json, deleted_at, grace_expires_at, status)
      SELECT s.file_key,
             MAX(s.file_path),
             -- the songs table has NO station_id column (library is account-scoped, not per-station), so
             -- backfilled rows carry 0. Rows enqueued by the live delete hook use whatever the song
             -- row actually provides, which is also 0 today. Kept NOT NULL in the schema because a
             -- future station-scoped library would need it and a nullable column would hide that.
             0,
             json_object('backfilled', 1, 'id', MAX(s.id), 'uuid', MAX(s.uuid),
                         'title', MAX(s.title), 'file_key', s.file_key,
                         'file_path', MAX(s.file_path), 'deleted_at', MIN(s.deleted_at)),
             CAST(strftime('%s', MIN(s.deleted_at)) AS INTEGER),
             CAST(strftime('%s', MIN(s.deleted_at)) AS INTEGER) + ${30 * 86400},
             'pending'
        FROM songs s
       WHERE s.deleted_at IS NOT NULL
         AND s.file_key IS NOT NULL AND TRIM(s.file_key) <> ''
         AND strftime('%s', s.deleted_at) IS NOT NULL
       GROUP BY s.file_key`).run();
    console.log(`[migrate-v37] backfilled ${backfilled.changes} queue row(s) from existing soft-deleted songs`);

    db.prepare('INSERT INTO schema_version (version) VALUES (37)').run();
  });
  migrate();
  console.log(`[migrate-v37] Transaction committed — ${TABLE} created.`);
}

module.exports = {
  // v37 adds a NEW LOCAL-ONLY table and alters no synced table. A payload from a v36 peer is
  // untouched by it — there is no wire representation of deletion_queue to transform, and there
  // never should be.
  payloadTransformer: function payloadTransformer(payload) {
    return payload;
  },
  applyMigration,
  isAlreadyMigrated,
  TABLE,
};

if (require.main === module) {
  const path = require('path');
  const os = require('os');
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const dbPath = process.argv[2] || path.join(localAppData, 'Ether', 'com.ether.radio', 'openair.db');
  const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));
  const db = new Database(dbPath);

  console.log('=== migrate-deletion-queue-phase-sync-37.js ===');
  console.log('DB:', dbPath, isAlreadyMigrated(db) ? '(already migrated — will no-op)' : '');

  const v0 = db.prepare('SELECT version FROM schema_version ORDER BY version').all().map(r => r.version);
  console.log('current schema_version:', v0.length ? Math.max(...v0) : '(none)');

  // Snapshot the tables this migration must not touch.
  const songsBefore = db.prepare('SELECT COUNT(*) c FROM songs').get().c;
  const mutsBefore  = db.prepare('SELECT COUNT(*) c FROM mutations').get().c;
  console.log(`songs rows before: ${songsBefore} · mutations rows before: ${mutsBefore}`);

  applyMigration(db);

  console.log('\n=== Post-verification ===');
  let allPass = true;
  const check = (label, pass, detail) => {
    console.log(`[${pass ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`);
    if (!pass) allPass = false;
  };

  const newVersion = Math.max(...db.prepare('SELECT version FROM schema_version ORDER BY version').all().map(r => r.version));
  check('schema_version = 37', newVersion === 37, `got ${newVersion}`);
  check(`${TABLE} exists`, tableExists(db, TABLE));

  const info = db.prepare(`PRAGMA table_info(${TABLE})`).all();
  const byName = Object.fromEntries(info.map(c => [c.name, c]));
  const want = {
    id: 'INTEGER', file_key: 'TEXT', file_path: 'TEXT', station_id: 'INTEGER',
    song_json: 'TEXT', deleted_at: 'INTEGER', grace_expires_at: 'INTEGER',
    status: 'TEXT', reason: 'TEXT', last_checked_at: 'INTEGER',
  };
  check('column set is exactly as specified',
    Object.keys(want).length === info.length && Object.keys(want).every(k => byName[k]),
    `got: ${info.map(c => c.name).join(', ')}`);
  for (const [name, type] of Object.entries(want)) {
    if (byName[name]) check(`  ${name} is ${type}`, String(byName[name].type).toUpperCase() === type, byName[name].type);
  }
  for (const nn of ['file_key', 'station_id', 'song_json', 'deleted_at', 'grace_expires_at', 'status']) {
    check(`  ${nn} is NOT NULL`, byName[nn] && byName[nn].notnull === 1, byName[nn] ? `notnull=${byName[nn].notnull}` : 'missing');
  }
  check("  status defaults to 'pending'", byName.status && String(byName.status.dflt_value).replace(/'/g, '') === 'pending',
        byName.status ? String(byName.status.dflt_value) : 'missing');

  // LOCAL-ONLY proof: no uuid column, and absent from synced-tables.js.
  check('has NO uuid column (local-only tables do not replicate)', !byName.uuid);
  try {
    const src = require('fs').readFileSync(path.join(__dirname, '..', 'electron', 'sync', 'synced-tables.js'), 'utf8');
    check('absent from synced-tables.js', !src.includes(`'${TABLE}'`) && !src.includes(`"${TABLE}"`));
  } catch (e) {
    check('absent from synced-tables.js', false, e.message);
  }

  const idx = db.prepare(`PRAGMA index_list(${TABLE})`).all().map(i => i.name);
  check('sweep index present', idx.includes(`idx_${TABLE}_sweep`), idx.join(', '));
  check('file_key index present', idx.includes(`idx_${TABLE}_file_key`));

  check('songs untouched', db.prepare('SELECT COUNT(*) c FROM songs').get().c === songsBefore);
  check('mutations untouched', db.prepare('SELECT COUNT(*) c FROM mutations').get().c === mutsBefore);
  // BACKFILL verification — the grace period must run from the SONG'S deletion date, not from now.
  const expectKeys = db.prepare(`
    SELECT COUNT(DISTINCT file_key) c FROM songs
     WHERE deleted_at IS NOT NULL AND file_key IS NOT NULL AND TRIM(file_key) <> ''`).get().c;
  const queued = db.prepare(`SELECT COUNT(*) c FROM ${TABLE}`).get().c;
  check('backfilled one row per deleted file_key', queued === expectKeys, `queued ${queued}, distinct keys ${expectKeys}`);

  const mismatched = db.prepare(`
    SELECT COUNT(*) c FROM ${TABLE} q
     WHERE q.deleted_at <> (SELECT CAST(strftime('%s', MIN(s.deleted_at)) AS INTEGER)
                              FROM songs s WHERE s.file_key = q.file_key AND s.deleted_at IS NOT NULL)`).get().c;
  check("deleted_at is the SONG'S real deletion time, not now()", mismatched === 0, `${mismatched} mismatched`);

  const nowChk = Math.floor(Date.now() / 1000);
  const stampedNow = db.prepare(`SELECT COUNT(*) c FROM ${TABLE} WHERE ABS(deleted_at - ?) < 3600`).get(nowChk).c;
  check('no row was stamped with the current time', stampedNow === 0, `${stampedNow} look like now()`);

  const graceBad = db.prepare(`SELECT COUNT(*) c FROM ${TABLE} WHERE grace_expires_at - deleted_at <> ${30 * 86400}`).get().c;
  check('every backfilled grace is exactly 30 days', graceBad === 0, `${graceBad} wrong`);

  const alreadyDue = db.prepare(`SELECT COUNT(*) c FROM ${TABLE} WHERE grace_expires_at <= ?`).get(nowChk).c;
  console.log(`       (of ${queued} backfilled rows, ${alreadyDue} are ALREADY past their 30-day grace)`);

  // A row round-trips, and the NOT NULLs actually bite.
  try {
    db.exec('BEGIN');
    const now = Math.floor(Date.now() / 1000);
    db.prepare(`INSERT INTO ${TABLE} (file_key, file_path, station_id, song_json, deleted_at, grace_expires_at)
                VALUES (?, ?, ?, ?, ?, ?)`).run('probe.mp3', 'C:\\probe.mp3', 2, JSON.stringify({ id: 1, title: 'probe' }), now, now + 30 * 86400);
    // BY KEY — the table is no longer empty after the backfill, so a bare SELECT would read a
    // backfilled row instead of the probe.
    const row = db.prepare(`SELECT * FROM ${TABLE} WHERE file_key = 'probe.mp3'`).get();
    check('a queue row round-trips', row && row.file_key === 'probe.mp3' && JSON.parse(row.song_json).title === 'probe');
    check("  status defaulted to 'pending'", row && row.status === 'pending', row ? row.status : 'none');
    check('  grace is 30 days after deleted_at', row && (row.grace_expires_at - row.deleted_at) === 30 * 86400);
    let threw = false;
    try { db.prepare(`INSERT INTO ${TABLE} (file_key, station_id, deleted_at, grace_expires_at) VALUES ('x', 1, 1, 1)`).run(); }
    catch { threw = true; }
    check('song_json NOT NULL is enforced', threw);
    db.exec('ROLLBACK');
  } catch (e) {
    check('a queue row round-trips', false, e.message);
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
  console.log('\nAll checks PASSED — migration v37 complete.');
}
