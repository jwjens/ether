'use strict';
// Migration v46 — date_closing_times: closing time for ONE specific date.
//
// docs/station-date-overrides-design-2026-08-26.md, as ruled by Jeff on 2026-08-26.
//
// Slice 5 gave a station seven recurring closing times, station_config_kv keys closing_time_0..6
// (Sunday..Saturday). That is the WEEKLY pattern. This table is the DATE-SPECIFIC exception on top
// of it: a park that shuts at 21:00 on a normal Tuesday but at 18:00 on Christmas Eve.
//
//   date          'YYYY-MM-DD', the LOCAL calendar date
//   closing_time  'HH:MM:SS' — or '' / NULL, meaning this date HAS no closing time
//
// PRECEDENCE, and it lives in exactly one resolver (main.js closingTimeForDate):
//   a row for this date  >  closing_time_<dow>  >  nothing
//
// THE ROW'S EXISTENCE IS THE OVERRIDE. That is why a blank closing_time is meaningful and is NOT
// the same as having no row:
//   no row                → use the weekday default
//   row, closing_time set → use that time on this date
//   row, closing_time ''  → this date has NO closing time, so no closing-relative announcement has
//                           a time to fire at — exactly what a blank weekday default already does
//                           today (dueTimeFor returns null). That is the whole mechanism.
//
// NO "CLOSED" FLAG, NO SUPPRESSION, deliberately (Jeff, 2026-08-26). This changes WHAT A DATE'S
// CLOSING TIME IS and nothing else. The slice 5 ruling stands untouched: firing is not airing, the
// board is the sole gate, and there is no closed-day logic anywhere in this feature.
//
// DATE IS TEXT, NOT AN EPOCH, deliberately. A calendar date is not an instant: an epoch would need a
// timezone to become "Dec 25" again and would drift across a DST boundary. 'YYYY-MM-DD' is
// unambiguous and sorts lexically in chronological order for free.
//
// Idempotent. Verify on a COPY first:
//   ELECTRON_RUN_AS_NODE=1 electron.exe scripts/migrate-date-closing-phase-sync-46.js <copy.db>

const TABLE = 'date_closing_times';

function isAlreadyMigrated(db) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(TABLE);
}

function applyMigration(db) {
  if (isAlreadyMigrated(db)) {
    try { db.prepare('INSERT INTO schema_version (version) VALUES (46)').run(); } catch (e) { /* already recorded */ }
    console.log('[migrate-v46] SKIP — date_closing_times already exists');
    return;
  }
  const migrate = db.transaction(() => {
    db.prepare(`
      CREATE TABLE ${TABLE} (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        date         TEXT NOT NULL,   -- 'YYYY-MM-DD', LOCAL calendar date
        closing_time TEXT,            -- 'HH:MM:SS'; '' or NULL = this date has no closing time
        station_id   INTEGER,
        uuid         TEXT,
        created_at   TEXT,
        updated_at   TEXT,
        deleted_at   TEXT
      )
    `).run();
    // One override per station per date. Partial on deleted_at so a soft-deleted row never blocks
    // setting that date again — the same shape every other station-scoped table here uses.
    db.prepare(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_date_closing_station_date
         ON ${TABLE}(station_id, date) WHERE deleted_at IS NULL`
    ).run();
    db.prepare('INSERT INTO schema_version (version) VALUES (46)').run();
  });
  migrate();
  console.log('[migrate-v46] Transaction committed — date_closing_times created.');
}

module.exports = {
  payloadTransformer: function payloadTransformer(payload) {
    // Identity — date_closing_times is brand new, so there are no older payloads to transform.
    return payload;
  },
  applyMigration,
};

if (require.main === module) {
  const path = require('path');
  const os   = require('os');
  // Resolve the DB the SAME way the app does (LocalAppData, NOT Roaming — Roaming is redirected to a
  // network share on managed boxes and SQLite WAL fails there). An explicit path as argv[2] lets this
  // be run against a COPY for verification.
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const dbPath = process.argv[2] || path.join(localAppData, 'Ether', 'com.ether.radio', 'openair.db');

  const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));
  const db = new Database(dbPath);

  console.log('=== migrate-date-closing-phase-sync-46.js ===');
  console.log('DB:', dbPath);
  applyMigration(db);
  const n = db.prepare(`SELECT COUNT(*) AS n FROM ${TABLE}`).get().n;
  console.log(`[migrate-v46] ${TABLE} rows: ${n}`);
  db.close();
}
