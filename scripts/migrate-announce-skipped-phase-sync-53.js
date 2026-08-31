'use strict';
// Migration v53 — announcement_schedule.skipped_at, so a skipped entry says so.
//
// Jeff's ruling, 2026-08-31: "Closing time moving past a row's fire time: SKIP it tonight, but
// VISIBLY — show on screen it was skipped because its time passed. Never silently drop it."
//
// WHY THIS NEEDS A COLUMN AND NOT A HEALTH EVENT. An offset entry ("30 minutes before close") has no
// clock time of its own; its fire time is computed against that day's closing time at the moment the
// tick runs. Move the closing time earlier and a row's computed time can land in the past, where it
// will never match and never fire. Nothing today would say so — the row would simply sit there
// looking scheduled, and the operator would find out by noticing the announcement never played.
//
// A health event would report it once, into a log nobody has open at 9pm, and lose it on relaunch.
// The row itself has to carry the fact, because the row is what the operator is looking at both
// tonight and tomorrow morning. "Never silently drop it" is not satisfied by a message that
// disappears.
//
// SHAPE: nullable epoch seconds, exactly like last_played_at beside it. NULL means "not skipped",
// which is every existing row and the normal state of every future one. The scheduler clears it when
// a row fires and stamps it when a row is missed, so the two fields together read as the row's
// history for the day: fired at X, or skipped at Y, or neither yet.
//
// Additive and idempotent — an ALTER TABLE guarded by a column check, no table rewrite, no data
// touched. A build that has already applied it re-runs to a no-op.
//
//   ELECTRON_RUN_AS_NODE=1 electron.exe scripts/migrate-announce-skipped-phase-sync-53.js <copy.db>

const TABLE = 'announcement_schedule';
const COLUMN = 'skipped_at';

function tableExists(db) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(TABLE);
}

function hasColumn(db) {
  if (!tableExists(db)) return false;
  try { return db.prepare(`PRAGMA table_info(${TABLE})`).all().some(c => c.name === COLUMN); }
  catch { return false; }
}

function isAlreadyMigrated(db) {
  // A missing table is not a failure. announcement_schedule arrives in v47, and the chain runs in
  // ascending order, so by the time this runs the table normally exists. If it does not, v47 itself
  // failed — that is v47's problem to report, and this migration must not compound it by throwing.
  // Recording the version keeps the chain contiguous either way.
  if (!tableExists(db)) return true;
  return hasColumn(db);
}

function applyMigration(db) {
  const already = db.prepare('SELECT 1 FROM schema_version WHERE version = 53').get();

  if (isAlreadyMigrated(db)) {
    if (!already) db.prepare('INSERT INTO schema_version (version) VALUES (53)').run();
    console.log('[migrate-v53] skipped_at already present (or table absent) — nothing to do');
    return;
  }
  if (already) {
    // Version recorded but the column is missing: an interrupted run. Fall through and add it rather
    // than trusting the marker — a recorded version that does not match the shape is how a build
    // ends up querying a column that is not there.
    console.log('[migrate-v53] version recorded but column missing — repairing');
  }

  const migrate = db.transaction(() => {
    db.prepare(`ALTER TABLE ${TABLE} ADD COLUMN ${COLUMN} INTEGER`).run();
    if (!already) db.prepare('INSERT INTO schema_version (version) VALUES (53)').run();
  });
  migrate();
  console.log('[migrate-v53] added announcement_schedule.skipped_at');
}

module.exports = {
  payloadTransformer: function payloadTransformer(payload) {
    // A pre-v53 peer sends rows without skipped_at. Absent means "not skipped", which is exactly
    // what null means here, so nothing has to be invented — the field is normalised rather than
    // guessed, so an older peer's row cannot land looking as though it had been skipped.
    try {
      if (payload && typeof payload === 'object' && !(COLUMN in payload)) payload[COLUMN] = null;
    } catch { /* a transformer must never throw the chain */ }
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

  console.log('=== migrate-announce-skipped-phase-sync-53.js ===');
  console.log('DB:', dbPath);
  applyMigration(db);
  db.close();
}
