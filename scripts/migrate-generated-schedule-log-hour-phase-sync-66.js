'use strict';
// Migration v66 — generated_schedule.log_hour_ts: the log hour (or show piece) a row BELONGS to.
//
// Jeff, 2026-10-18: "Generate places EVERY row on the clock. Nothing is trimmed to fit the hour." A clock with extra rows
// writes rows past :00. Those rows still belong to the hour their clock built: they air only if that hour runs short,
// and they never mix with the next hour's rows. scheduled_at is the planned start time and can be past :00, so it
// cannot say which hour a row belongs to. log_hour_ts can: the start of the piece Generate built it in (the top of the
// hour, or a show's start minute inside it — audiod/show-window.js).
//
// NULL = a row written before v66, or by a writer that does not know its hour: the reader and the Program Log then use
// scheduled_at, exactly as before (every pre-v66 row starts inside its own hour, so the two agree).
//
// SYNC: generated_schedule is syncExcluded (electron/sync/synced-tables.js, Ruling A) — every install builds its own
// log. The column never travels. The transformer adds nothing.
//
// Additive and idempotent — ALTER TABLE guarded by a column check, no table rewrite, no data touched.
//
//   ELECTRON_RUN_AS_NODE=1 electron.exe scripts/migrate-generated-schedule-log-hour-phase-sync-66.js <copy.db>

const TABLE = 'generated_schedule';
const VERSION = 66;
const COLUMN = { name: 'log_hour_ts', ddl: 'INTEGER' };

function hasColumn(db) {
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(TABLE)) return true;   // no table: nothing to add
    return db.prepare(`PRAGMA table_info(${TABLE})`).all().some(c => c.name === COLUMN.name);
  } catch { return true; }
}

function applyMigration(db) {
  const already = db.prepare('SELECT 1 FROM schema_version WHERE version = ?').get(VERSION);
  if (hasColumn(db)) {
    if (!already) db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(VERSION);
    console.log('[migrate-v66] generated_schedule.log_hour_ts already present (or table absent) — nothing to do');
    return;
  }
  if (already) console.log('[migrate-v66] version recorded but column missing — repairing');
  db.transaction(() => {
    db.prepare(`ALTER TABLE ${TABLE} ADD COLUMN ${COLUMN.name} ${COLUMN.ddl}`).run();
    if (!already) db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(VERSION);
  })();
  console.log('[migrate-v66] added generated_schedule.log_hour_ts');
}

module.exports = {
  payloadTransformer: function payloadTransformer(payload) {
    // ADDS NOTHING: the table does not sync. A transformer must still exist: the chain dead-letters a version with no
    // script.
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
  try { applyMigration(db); } finally { db.close(); }
}
