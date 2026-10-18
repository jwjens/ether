'use strict';
// Migration v63 — what aired is the record (docs/scheduler-rotation-playout-design.md §3.9, Phase 1; Jeff GO 2026-10-18).
//
// 1. play_log.row_uuid   — the row this play fulfils: a generated_schedule row's uuid, or (source = 'announcement')
//                          the announcements row's uuid (announcements never enter generated_schedule). A uuid, never a local integer id:
//                          play_log travels to every machine on the account and integer ids differ per install.
//                          (play_log.scheduled_log_id is an INTEGER link to a table retired in v61; it stays
//                          as it is and is no longer the link.)
//    play_log.machine_id — the machine that aired it (client_identity.client_id), so a standby machine's plays stay in
//                          history, marked, and never decide anything for the broadcast owner (design §3.9, decision 8).
//    Both SYNC (synced-tables.js): history that travels must say the same thing everywhere.
//
// 2. log_row_changes     — LOCAL ONLY (not in the sync registry): an append-only record of every UPDATE or DELETE
//                          of a generated_schedule row that has already aired or been retired (state not 'pending'),
//                          written by two database TRIGGERS, so every code path is caught — including ones not yet
//                          written and a sync applying another machine's change (design §6, alert `aired-row-changed`).
//                          The one normal transition, playing → played with nothing else changed, is not a change.
//                          The table is only appended to by the triggers and read by the health monitor.
//
// SHAPE: additive and idempotent. Two nullable TEXT columns (old rows have no link: they were written before the record
// existed), one new table, two triggers (CREATE ... IF NOT EXISTS). No data is touched.
// SYNC NOTE (as v62): a mutation stamped v63 is quarantined by a v62 peer (merge-engine.js) until it upgrades — every
// table. Ship v63 to the whole fleet together.
//
//   ELECTRON_RUN_AS_NODE=1 electron.exe scripts/migrate-play-record-phase-sync-63.js <copy.db>

const VERSION = 63;
const PLAY_COLUMNS = [
  { name: 'row_uuid',   ddl: 'TEXT' },
  { name: 'machine_id', ddl: 'TEXT' },
];
// What a change to an aired row is measured on. updated_at / generated_at / pick_reason / seq are bookkeeping.
const WATCHED = ['scheduled_at', 'song_id', 'title', 'artist', 'file_key', 'file_path', 'duration_s', 'category_id',
  'content_class', 'played_at', 'deleted_at', 'station_id', 'uuid', 'state'];

function tableExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}
function columnsOf(db, table) {
  try { return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name)); } catch { return new Set(); }
}

const CHANGES_DDL = `CREATE TABLE IF NOT EXISTS log_row_changes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          INTEGER NOT NULL DEFAULT (unixepoch()),
  op          TEXT NOT NULL,            -- 'update' | 'delete'
  row_id      INTEGER,
  row_uuid    TEXT,
  station_id  INTEGER,
  old_state   TEXT,
  new_state   TEXT,
  old_row     TEXT,                     -- JSON of the watched columns before
  new_row     TEXT                      -- JSON of the watched columns after (NULL for a delete)
)`;
const json = (alias, cols) => `json_object(${cols.map(c => `'${c}', ${alias}.${c}`).join(', ')})`;

function triggerSql(cols) {
  const changed = cols.map(c => `OLD.${c} IS NOT NEW.${c}`).join(' OR ');
  const othersSame = cols.filter(c => c !== 'state').map(c => `OLD.${c} IS NEW.${c}`).join(' AND ');
  return [
    `CREATE TRIGGER IF NOT EXISTS trg_log_row_aired_update AFTER UPDATE ON generated_schedule
       WHEN OLD.state IS NOT NULL AND OLD.state != 'pending'
        AND (${changed})
        AND NOT (OLD.state = 'playing' AND NEW.state = 'played' AND ${othersSame})
     BEGIN
       INSERT INTO log_row_changes (op, row_id, row_uuid, station_id, old_state, new_state, old_row, new_row)
       VALUES ('update', OLD.id, OLD.uuid, OLD.station_id, OLD.state, NEW.state, ${json('OLD', cols)}, ${json('NEW', cols)});
     END`,
    `CREATE TRIGGER IF NOT EXISTS trg_log_row_aired_delete AFTER DELETE ON generated_schedule
       WHEN OLD.state IS NOT NULL AND OLD.state != 'pending'
     BEGIN
       INSERT INTO log_row_changes (op, row_id, row_uuid, station_id, old_state, new_state, old_row, new_row)
       VALUES ('delete', OLD.id, OLD.uuid, OLD.station_id, OLD.state, NULL, ${json('OLD', cols)}, NULL);
     END`,
  ];
}

function applyMigration(db) {
  const already = db.prepare('SELECT 1 FROM schema_version WHERE version = ?').get(VERSION);
  const migrate = db.transaction(() => {
    if (tableExists(db, 'play_log')) {
      const have = columnsOf(db, 'play_log');
      for (const c of PLAY_COLUMNS) if (!have.has(c.name)) db.prepare(`ALTER TABLE play_log ADD COLUMN ${c.name} ${c.ddl}`).run();
    }
    db.prepare(CHANGES_DDL).run();
    if (tableExists(db, 'generated_schedule')) {
      // Watch only the columns this install's table has (an old fixture may lack one).
      const have = columnsOf(db, 'generated_schedule');
      const cols = WATCHED.filter(c => have.has(c));
      if (cols.includes('state')) for (const sql of triggerSql(cols)) db.prepare(sql).run();
    }
    if (!already) db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(VERSION);
  });
  migrate();
  console.log(`[migrate-v63] play_log.row_uuid / machine_id, log_row_changes + its two triggers ${already ? 'checked' : 'added'}`);
}

module.exports = {
  payloadTransformer: function payloadTransformer(payload) {
    // ADDS NOTHING, deliberately (the v62 lesson): a pre-v63 peer's play_log payload has neither field, and ABSENT
    // is right — an INSERT leaves them NULL (that machine wrote no link), an UPDATE keeps this machine's values.
    // log_row_changes never syncs. A transformer must still exist: the chain dead-letters a version with no script.
    return payload;
  },
  applyMigration,
  _test: { triggerSql, WATCHED, CHANGES_DDL },
};

if (require.main === module) {
  const path = require('path');
  const os   = require('os');
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const dbPath = process.argv[2] || path.join(localAppData, 'Ether', 'com.ether.radio', 'openair.db');
  const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));
  const db = new Database(dbPath);

  console.log('=== migrate-play-record-phase-sync-63.js ===');
  console.log('DB:', dbPath);
  applyMigration(db);
  db.close();
}
