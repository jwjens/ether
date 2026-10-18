'use strict';
// Migration v65 — shows.start_minute and shows.end_minute.
//
// Jeff, 2026-10-18: "The show schedule is the boundary: a show that ends at 1:30 automates until 1:30. Shows start
// and end at any minute." A show runs start_hour:start_minute → end_hour:end_minute (audiod/show-window.js).
//
// SHAPE: two INTEGER columns, NOT NULL DEFAULT 0 — every existing show keeps its exact hours (:00 → :00). Both SYNC
// (synced-tables.js): they are part of what the programmer set, like start_hour / end_hour beside them. A pre-v65
// peer reads only the columns its own registry lists, so it ignores them (and treats a 1:30 show as 1:00). A pre-v65
// payload arriving here is passed through UNCHANGED (the v62 lesson): an insert takes the defaults, an update keeps
// this machine's minutes. Any mutation stamped v65 is quarantined by a pre-v65 peer until it upgrades — ship v65 to
// the whole fleet together.
//
// Additive and idempotent — ALTER TABLE guarded by column checks, no table rewrite, no data touched.
//
//   ELECTRON_RUN_AS_NODE=1 electron.exe scripts/migrate-show-minutes-phase-sync-65.js <copy.db>

const TABLE = 'shows';
const VERSION = 65;
const COLUMNS = [
  { name: 'start_minute', ddl: 'INTEGER NOT NULL DEFAULT 0' },
  { name: 'end_minute',   ddl: 'INTEGER NOT NULL DEFAULT 0' },
];

function tableExists(db) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(TABLE);
}
function missingColumns(db) {
  if (!tableExists(db)) return [];
  let have;
  try { have = new Set(db.prepare(`PRAGMA table_info(${TABLE})`).all().map(c => c.name)); }
  catch { return []; }
  return COLUMNS.filter(c => !have.has(c.name));
}

function applyMigration(db) {
  const already = db.prepare('SELECT 1 FROM schema_version WHERE version = ?').get(VERSION);
  const missing = missingColumns(db);
  if (missing.length === 0) {
    if (!already) db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(VERSION);
    console.log('[migrate-v65] shows.start_minute / end_minute already present (or table absent) — nothing to do');
    return;
  }
  if (already) console.log('[migrate-v65] version recorded but columns missing — repairing');
  const migrate = db.transaction(() => {
    for (const c of missing) db.prepare(`ALTER TABLE ${TABLE} ADD COLUMN ${c.name} ${c.ddl}`).run();
    if (!already) db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(VERSION);
  });
  migrate();
  console.log('[migrate-v65] added shows.' + missing.map(c => c.name).join(', '));
}

module.exports = {
  payloadTransformer: function payloadTransformer(payload) {
    // ADDS NOTHING (the v62 lesson): absent fields take the column defaults on insert and leave this machine's
    // minutes alone on update. A transformer must still exist: the chain dead-letters a version with no script.
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
  console.log('=== migrate-show-minutes-phase-sync-65.js ===');
  console.log('DB:', dbPath);
  applyMigration(db);
  db.close();
}
