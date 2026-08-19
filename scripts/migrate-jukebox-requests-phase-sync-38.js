'use strict';
// Migration v38 — jukebox_requests: who asked for what, on the public jukebox.
//
// Cause (docs/jukebox-rebuild-design-2026-08-17.md §0.4):
//   The jukebox queue rail has to show a REQUESTER'S NAME next to each song, and the daemon's queue
//   has no such field — it carries qid/filePath/title, nothing about the person who asked. The name
//   needs somewhere to live, and Phase 2 (the public web request page) needs the same record with a
//   donation step slotted in front of "queued".
//
// LOCAL-ONLY, DELIBERATELY — the same call as deletion_queue at v37, for the same two reasons. It is
// NOT added to electron/sync/synced-tables.js and carries NO `uuid` column, because those are what
// make a table replicate. It matters here specifically:
//
//   docs/sync-systems-map.md §2 records that cloud-authored rows written through ordinary IPC
//   handlers BECOME CRDT MUTATIONS and propagate to peers — "Two machines both importing the same
//   staged programming will both journal it." A public song request is a statement about ONE jukebox
//   in front of ONE station on ONE night. Journalling it would push a stranger's typed name to every
//   peer install in the account and re-play their pick on machines that never had a jukebox open.
//
//   Hazard A in that same map (integer station ids in a uuid world) is the second reason: this table
//   references station_id as an integer, and integer station ids are exactly what the 2026-08-17
//   re-key pass had to stop crossing machine boundaries.
//
// PAYMENTS ARE NOT BUILT. donation_cents and payment_status exist and are written by nothing in this
// release. They are here so the donation step can slot in FRONT of 'queued' later without a second
// migration touching a table that by then holds live request history:
//
//   status: 'pending' -> 'awaiting' -> 'queued' -> 'played' | 'cancelled'
//                        ^ where a donation/payment gate goes, when Jeff asks for one
//
// STATUS VOCABULARY:
//   pending    created, not yet accepted onto the queue (Phase 2 web requests land here first)
//   awaiting   RESERVED — a payment/donation gate is holding it. Nothing sets this today.
//   queued     accepted; the song is on the daemon's queue (qid records which entry)
//   played     it aired
//   cancelled  withdrawn by staff, or refused (cap/repeat/missing file)
//
// created_at / played_at / cancelled_at are INTEGER epoch SECONDS — matching deletion_queue and
// play_log.played_at rather than the ISO TEXT used by the synced tables. The v37 header records why
// that choice is load-bearing: comparing an INTEGER epoch against datetime('now', …) TEXT is always
// false, and that trap already produced one wrong answer in this codebase (0 rows vs the real 442).
//
// Idempotent: if jukebox_requests already exists, records v38 and returns.
//
// Verified on a COPY before any live run. The live DB is migrated BY THE APP at startup
// (electron/main.js auto-discovers migrate-*-phase-sync-N.js and calls applyMigration) — never by
// running this script against the live file while Ether is open.

const TABLE = 'jukebox_requests';

function tableExists(db, t) {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
}
function isAlreadyMigrated(db) {
  return tableExists(db, TABLE);
}

function applyMigration(db) {
  if (isAlreadyMigrated(db)) {
    try { db.prepare('INSERT INTO schema_version (version) VALUES (38)').run(); } catch { /* recorded */ }
    console.log(`[migrate-v38] SKIP — ${TABLE} already exists`);
    return;
  }
  const migrate = db.transaction(() => {
    db.prepare(`
      CREATE TABLE ${TABLE} (
        id             INTEGER PRIMARY KEY,
        station_id     INTEGER NOT NULL,
        -- What the public typed. Length is capped by the UI, not the schema; SQLite would not
        -- enforce it anyway and a silent truncation is worse than a long name.
        requester_name TEXT    NOT NULL,
        -- song_id is the library row it came from. NULLABLE on purpose: a song can be deleted out
        -- from under a pending request, and losing the request's own record of WHAT was asked for
        -- would make the queue rail lie. file_path/title/artist are captured at request time so the
        -- row still renders after the library moves underneath it.
        song_id        INTEGER,
        file_path      TEXT    NOT NULL,
        title          TEXT    NOT NULL,
        artist         TEXT,
        status         TEXT    NOT NULL DEFAULT 'queued',
        -- RESERVED for the donation step. Written by nothing in this release.
        donation_cents INTEGER NOT NULL DEFAULT 0,
        payment_status TEXT    NOT NULL DEFAULT 'none',
        -- 'jukebox' (typed at the machine) or 'web' (Phase 2, scanned the QR). Present now so Phase 2
        -- does not need a migration to tell the two apart in the queue rail.
        source         TEXT    NOT NULL DEFAULT 'jukebox',
        -- The daemon queue entry this request became, once accepted. The join back to honest state:
        -- the rail renders the DAEMON's queue and reads names from here, never the other way round.
        qid            TEXT,
        created_at     INTEGER NOT NULL,
        played_at      INTEGER,
        cancelled_at   INTEGER
      )`).run();

    // The queue rail's own query — this station's live requests, oldest first.
    db.prepare(`CREATE INDEX idx_${TABLE}_rail ON ${TABLE} (station_id, status, created_at)`).run();
    // Reconciling a daemon queue entry back to the person who asked for it.
    db.prepare(`CREATE INDEX idx_${TABLE}_qid ON ${TABLE} (qid)`).run();

    // No backfill. There is no prior source of requester names — the feature did not record them.

    db.prepare('INSERT INTO schema_version (version) VALUES (38)').run();
  });
  migrate();
  console.log(`[migrate-v38] Transaction committed — ${TABLE} created.`);
}

module.exports = {
  // v38 adds a NEW LOCAL-ONLY table and alters no synced table. A payload from a v37 peer is
  // untouched by it — there is no wire representation of jukebox_requests to transform, and per the
  // header there never should be.
  payloadTransformer: function payloadTransformer(payload) {
    return payload;
  },
  applyMigration,
  isAlreadyMigrated,
  TABLE,
};

if (require.main === module) {
  const path = require('path');
  const Database = require('better-sqlite3');

  const dbPath = process.argv[2];
  if (!dbPath) {
    console.error('Usage: node scripts/migrate-jukebox-requests-phase-sync-38.js <path-to-db-COPY>');
    console.error('NEVER point this at the live openair.db while Ether is open.');
    process.exit(1);
  }
  console.log(`[migrate-v38] target: ${path.resolve(dbPath)}`);
  const db = new Database(dbPath);

  applyMigration(db);

  // ── Post-verification ──────────────────────────────────────────────────────────────────────
  let allPass = true;
  const check = (label, ok, detail) => {
    if (!ok) allPass = false;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  };

  check('table exists', tableExists(db, TABLE));

  const columns = db.prepare(`PRAGMA table_info(${TABLE})`).all().map(c => c.name);
  for (const c of ['station_id', 'requester_name', 'file_path', 'title', 'status',
                   'donation_cents', 'payment_status', 'source', 'qid', 'created_at']) {
    check(`column ${c} present`, columns.includes(c));
  }
  check('NO uuid column — this table must not replicate', !columns.includes('uuid'),
        columns.includes('uuid') ? 'uuid present' : 'absent as designed');

  // It must be absent from the synced-table registry, or every request would hit the wire.
  try {
    const registry = require('../electron/sync/synced-tables.js');
    const names = JSON.stringify(registry);
    check('not registered in synced-tables.js', !names.includes(TABLE));
  } catch (e) {
    check('not registered in synced-tables.js', false, `registry unreadable: ${e.message}`);
  }

  const idx = db.prepare(`PRAGMA index_list(${TABLE})`).all().map(i => i.name);
  check('rail index present', idx.includes(`idx_${TABLE}_rail`));
  check('qid index present', idx.includes(`idx_${TABLE}_qid`));

  // A row round-trips, the defaults are what the design says, and the NOT NULLs actually bite.
  try {
    db.exec('BEGIN');
    const now = Math.floor(Date.now() / 1000);
    db.prepare(`INSERT INTO ${TABLE} (station_id, requester_name, song_id, file_path, title, artist, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(2, 'Jeff', 41, 'C:\\probe.mp3', 'Probe Song', 'The Probes', now);
    const row = db.prepare(`SELECT * FROM ${TABLE} WHERE requester_name = 'Jeff'`).get();
    check('a request row round-trips', !!row && row.title === 'Probe Song');
    check("  status defaults to 'queued'", row && row.status === 'queued', row ? row.status : 'none');
    check('  donation_cents defaults to 0 and is UNUSED', row && row.donation_cents === 0);
    check("  payment_status defaults to 'none'", row && row.payment_status === 'none', row ? row.payment_status : 'none');
    check("  source defaults to 'jukebox'", row && row.source === 'jukebox', row ? row.source : 'none');
    check('  qid starts NULL — set only once the daemon accepts it', row && row.qid === null);

    let threw = false;
    try { db.prepare(`INSERT INTO ${TABLE} (station_id, file_path, title, created_at) VALUES (2,'x','y',1)`).run(); }
    catch { threw = true; }
    check('requester_name NOT NULL is enforced', threw);

    // The donation seam: a row can sit in front of 'queued' without any code existing for it yet.
    db.prepare(`UPDATE ${TABLE} SET status='awaiting', payment_status='awaiting', donation_cents=200
                 WHERE requester_name='Jeff'`).run();
    const held = db.prepare(`SELECT * FROM ${TABLE} WHERE requester_name='Jeff'`).get();
    check('a donation step can slot in front of queued', held.status === 'awaiting' && held.donation_cents === 200);

    db.exec('ROLLBACK');
  } catch (e) {
    check('a request row round-trips', false, e.message);
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
  console.log('\nAll checks PASSED — migration v38 complete.');
}
