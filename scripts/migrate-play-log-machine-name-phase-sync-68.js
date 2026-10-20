'use strict';
// Migration v68 — play_log.machine_name: the NAME of the computer that aired the play (Jeff, 2026-10-20: "The Play Log gets
// an 'Aired on' column with the computer's name, and a filter by computer"). docs/per-computer-logs-play-log-aired-on-plan-2026-10-20.md §3.
//
// play_log.machine_id (v63) already records WHICH computer aired a play, as its client id; no computer can name another
// from that. machine_name is the airing computer's own name (its hostname) at the moment it aired — a snapshot, so a
// computer renamed later never rewrites history. NULL = a play written before v68 (the Play Log shows the short id, or
// "Not recorded" before v63).
//
// SYNC: play_log is synced; the column travels with every new play (registered in electron/sync/synced-tables.js). An
// older sender's payload simply has no machine_name — nothing to transform.
//
// Additive and idempotent — ALTER TABLE guarded by a column check.
//
//   ELECTRON_RUN_AS_NODE=1 electron.exe scripts/migrate-play-log-machine-name-phase-sync-68.js <copy.db>

const TABLE = 'play_log';
const VERSION = 68;
const COLUMN = { name: 'machine_name', ddl: 'TEXT' };

function hasColumn(db) {
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(TABLE)) return true;
    return db.prepare(`PRAGMA table_info(${TABLE})`).all().some(c => c.name === COLUMN.name);
  } catch { return true; }
}

function applyMigration(db) {
  const already = db.prepare('SELECT 1 FROM schema_version WHERE version = ?').get(VERSION);
  if (hasColumn(db)) {
    if (!already) db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(VERSION);
    console.log('[migrate-v68] play_log.machine_name already present (or table absent) — nothing to do');
    return;
  }
  db.transaction(() => {
    db.prepare(`ALTER TABLE ${TABLE} ADD COLUMN ${COLUMN.name} ${COLUMN.ddl}`).run();
    if (!already) db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(VERSION);
  })();
  console.log('[migrate-v68] added play_log.machine_name');
}

module.exports = {
  payloadTransformer: function payloadTransformer(payload) {
    // ADDS NOTHING: an older play simply has no machine_name; the Play Log falls back to the machine id.
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
