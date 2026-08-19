'use strict';
// Migration v40 — jukebox_requests.source: 'kiosk' → 'jukebox'.
//
// The feature is called the JUKEBOX. "kiosk" was internal shorthand that leaked into a STORED VALUE
// (v38 created `source TEXT NOT NULL DEFAULT 'kiosk'`, and the renderer wrote it literally), so it is
// not a find-and-replace — the rows on disk say 'kiosk' and every reader has to agree with them.
//
// Two halves, both needed, or the name is only half-renamed:
//   1. EXISTING ROWS   — UPDATE ... SET source='jukebox' WHERE source='kiosk'.
//   2. THE DEFAULT     — v38's column default is 'kiosk'. SQLite cannot ALTER a default, so the table
//                        is REBUILT. Without this, any future insert that omits `source` would write
//                        'kiosk' again and the rename would silently undo itself one row at a time.
//
// The rebuild also makes old and new installs CONVERGE: a fresh install runs v38 (default 'kiosk')
// then immediately v40 (rebuilt to 'jukebox'), landing in the same shape as an upgraded install.
//
// 'web' is untouched — it is the Phase 2 value for a request scanned from the QR code, and it was
// never the thing being renamed.
//
// LOCAL-ONLY TABLE: jukebox_requests has no uuid column and is absent from synced-tables.js, so no
// payload carries `source` across the wire and the transformer is a pass-through.
//
// Idempotent: re-running finds no 'kiosk' rows and a default that is already 'jukebox'.
// Verify on a COPY first:
//   ELECTRON_RUN_AS_NODE=1 electron.exe scripts/migrate-jukebox-source-rename-phase-sync-40.js <copy.db>

const TABLE = 'jukebox_requests';

function tableExists(db, t) {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
}
/** The stored CREATE TABLE text, which is where a column DEFAULT actually lives. */
function ddl(db, t) {
  const r = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(t);
  return r && r.sql ? r.sql : '';
}
function defaultIsJukebox(db) {
  const s = ddl(db, TABLE);
  return /source\s+TEXT\s+NOT\s+NULL\s+DEFAULT\s+'jukebox'/i.test(s);
}
function kioskRows(db) {
  if (!tableExists(db, TABLE)) return 0;
  try { return db.prepare(`SELECT COUNT(*) c FROM ${TABLE} WHERE source = 'kiosk'`).get().c; }
  catch { return 0; }
}
// Migrated when the table is gone entirely (nothing to rename), or when no 'kiosk' row remains AND
// the default has been rebuilt. Both halves, deliberately — a DB with the rows fixed but the old
// default still in place is NOT migrated; it would regress on the next default-using insert.
function isAlreadyMigrated(db) {
  if (!tableExists(db, TABLE)) return true;
  return kioskRows(db) === 0 && defaultIsJukebox(db);
}

function applyMigration(db) {
  const migrate = db.transaction(() => {
    if (!tableExists(db, TABLE)) {
      // A pre-v38 database. v38 creates the table; this migration has nothing to rename.
      try { db.prepare('INSERT INTO schema_version (version) VALUES (40)').run(); } catch { /* recorded */ }
      console.log(`[migrate-v40] SKIP — ${TABLE} does not exist yet (pre-v38 database).`);
      return;
    }

    const renamed = db.prepare(`UPDATE ${TABLE} SET source = 'jukebox' WHERE source = 'kiosk'`).run().changes;

    let rebuilt = false;
    if (!defaultIsJukebox(db)) {
      // Standard SQLite column-default change: build beside it, copy, swap, re-index. Inside the
      // outer transaction, so a failure anywhere leaves the original table exactly as it was.
      db.prepare(`
        CREATE TABLE ${TABLE}_v40 (
          id             INTEGER PRIMARY KEY,
          station_id     INTEGER NOT NULL,
          requester_name TEXT    NOT NULL,
          song_id        INTEGER,
          file_path      TEXT    NOT NULL,
          title          TEXT    NOT NULL,
          artist         TEXT,
          status         TEXT    NOT NULL DEFAULT 'queued',
          donation_cents INTEGER NOT NULL DEFAULT 0,
          payment_status TEXT    NOT NULL DEFAULT 'none',
          -- 'jukebox' (typed at the machine) or 'web' (Phase 2, scanned the QR).
          source         TEXT    NOT NULL DEFAULT 'jukebox',
          qid            TEXT,
          created_at     INTEGER NOT NULL,
          played_at      INTEGER,
          cancelled_at   INTEGER
        )`).run();

      db.prepare(`
        INSERT INTO ${TABLE}_v40
          (id, station_id, requester_name, song_id, file_path, title, artist, status,
           donation_cents, payment_status, source, qid, created_at, played_at, cancelled_at)
        SELECT
           id, station_id, requester_name, song_id, file_path, title, artist, status,
           donation_cents, payment_status,
           CASE WHEN source = 'kiosk' THEN 'jukebox' ELSE source END,
           qid, created_at, played_at, cancelled_at
        FROM ${TABLE}`).run();

      db.prepare(`DROP TABLE ${TABLE}`).run();
      db.prepare(`ALTER TABLE ${TABLE}_v40 RENAME TO ${TABLE}`).run();
      // Indexes go with the dropped table — recreate both, exactly as v38 defined them.
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_${TABLE}_rail ON ${TABLE} (station_id, status, created_at)`).run();
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_${TABLE}_qid  ON ${TABLE} (qid)`).run();
      rebuilt = true;
    }

    try { db.prepare('INSERT INTO schema_version (version) VALUES (40)').run(); } catch { /* recorded */ }
    console.log(`[migrate-v40] source 'kiosk' → 'jukebox': ${renamed} row(s) renamed; ` +
                `default ${rebuilt ? 'rebuilt' : 'already jukebox'}.`);
  });
  migrate();
  console.log('[migrate-v40] Transaction committed.');
}

module.exports = {
  // Pass-through: jukebox_requests is local-only (no uuid, absent from synced-tables.js), so no
  // payload carries this column and there is nothing on the wire to rewrite.
  payloadTransformer: function payloadTransformer(payload) {
    return payload;
  },
  applyMigration,
  isAlreadyMigrated,
};

if (require.main === module) {
  const path = require('path');
  const Database = require('better-sqlite3');

  const dbPath = process.argv[2];
  if (!dbPath) {
    console.error('Usage: node scripts/migrate-jukebox-source-rename-phase-sync-40.js <path-to-db-COPY>');
    console.error('NEVER point this at the live openair.db while Ether is open.');
    process.exit(1);
  }
  console.log(`[migrate-v40] target: ${path.resolve(dbPath)}`);
  const db = new Database(dbPath);

  const had = tableExists(db, TABLE);
  const before = had ? db.prepare(`SELECT COUNT(*) c FROM ${TABLE}`).get().c : 0;
  const beforeKiosk = kioskRows(db);

  applyMigration(db);

  let allPass = true;
  const check = (label, ok, detail) => {
    if (!ok) allPass = false;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  };

  if (had) {
    const after = db.prepare(`SELECT COUNT(*) c FROM ${TABLE}`).get().c;
    check('no rows added or lost', after === before, `${before} → ${after}`);
    check("no 'kiosk' rows remain", kioskRows(db) === 0, `${beforeKiosk} renamed`);
    check("column default is now 'jukebox'", defaultIsJukebox(db));

    // Both indexes must survive the rebuild — the rail query and the qid join depend on them.
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=?").all(TABLE)
                  .map(r => r.name);
    check('rail index survived the rebuild', idx.includes(`idx_${TABLE}_rail`), idx.join(','));
    check('qid index survived the rebuild', idx.includes(`idx_${TABLE}_qid`), idx.join(','));

    // A default-using insert must now land 'jukebox' — this is the half that stops the rename undoing
    // itself one row at a time.
    try {
      db.exec('BEGIN');
      db.prepare(`INSERT INTO ${TABLE} (station_id, requester_name, file_path, title, created_at)
                  VALUES (?, ?, ?, ?, ?)`)
        .run(2, 'Probe', 'C:/probe.mp3', 'Probe Song', Math.floor(Date.now() / 1000));
      const row = db.prepare(`SELECT source FROM ${TABLE} ORDER BY id DESC LIMIT 1`).get();
      check("an insert that omits source defaults to 'jukebox'", row && row.source === 'jukebox',
            row ? row.source : 'no row');
      db.exec('ROLLBACK');
    } catch (e) {
      check("an insert that omits source defaults to 'jukebox'", false, e.message);
      try { db.exec('ROLLBACK'); } catch { /* already */ }
    }

    // 'web' is a different fact and must not be swept up in the rename.
    try {
      db.exec('BEGIN');
      db.prepare(`INSERT INTO ${TABLE} (station_id, requester_name, file_path, title, created_at, source)
                  VALUES (?, ?, ?, ?, ?, 'web')`)
        .run(2, 'Probe Web', 'C:/probe2.mp3', 'Probe Web Song', Math.floor(Date.now() / 1000));
      const row = db.prepare(`SELECT source FROM ${TABLE} ORDER BY id DESC LIMIT 1`).get();
      check("'web' is left alone — it was never the value being renamed", row && row.source === 'web');
      db.exec('ROLLBACK');
    } catch (e) {
      check("'web' is left alone", false, e.message);
      try { db.exec('ROLLBACK'); } catch { /* already */ }
    }
  } else {
    check('pre-v38 database handled without error', true, 'table absent, nothing to rename');
  }

  try {
    applyMigration(db);
    check('second run is a clean no-op', isAlreadyMigrated(db));
  } catch (e) {
    check('second run is a clean no-op', false, e.message);
  }

  db.close();
  if (!allPass) { console.error('\nOne or more post-verification checks FAILED.'); process.exit(1); }
  console.log('\nAll checks PASSED — migration v40 complete.');
}
