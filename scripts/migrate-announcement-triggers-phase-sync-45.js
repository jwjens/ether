'use strict';
// Migration v45 — announcements gain a TRIGGER TYPE and a closing-time offset.
//
// Slice 5 of docs/aux-channel-ducker-announcements-design-2026-08-21.md (§C.2).
//
// Until now an announcement had exactly one kind of trigger: an absolute clock time. The park case
// needs the other kind — "30 minutes before we close", "15 before", "1 before", "at close" — and
// closing time is not the same on every day, so a relative trigger has to be computed against THAT
// DAY's closing time rather than a single station-wide value.
//
//   trigger_type      'absolute'      → fire at trigger_time (unchanged, and the default)
//                     'close_offset'  → fire close_offset_min BEFORE that weekday's closing time
//   close_offset_min  minutes before close. 0 = at closing time itself.
//
// DEFAULT 'absolute' — every existing row keeps firing exactly when it always has. Nothing about an
// existing station's schedule changes.
//
// WHERE CLOSING TIME LIVES: station_config_kv, seven keys, closing_time_0..6 (Sunday..Saturday), so
// it needs no schema of its own and no migration when a station changes its hours.
//
// FIRING vs AIRING, per Jeff's ruling (2026-08-25): a trigger decides WHEN an announcement fires
// onto the Announcement source channel. Whether anyone hears it is the board's business — fader up
// and channel ON — exactly like every other channel. There is no "closed day" suppression anywhere
// in this feature: a channel that is down is simply a channel that is down.
//
// Idempotent. Verify on a COPY first:
//   ELECTRON_RUN_AS_NODE=1 electron.exe scripts/migrate-announcement-triggers-phase-sync-45.js <copy.db>

const TABLE = 'announcements';

function tableExists(db, t) {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
}
function columns(db, t) {
  try { return db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name); }
  catch { return []; }
}
function isAlreadyMigrated(db) {
  const c = columns(db, TABLE);
  return c.includes('trigger_type') && c.includes('close_offset_min');
}

function applyMigration(db) {
  if (!tableExists(db, TABLE)) {
    console.log('[migrate-v45] announcements absent — nothing to migrate.');
    try { db.prepare('INSERT INTO schema_version (version) VALUES (45)').run(); } catch { /* recorded */ }
    return;
  }
  const migrate = db.transaction(() => {
    const c = columns(db, TABLE);
    if (!c.includes('trigger_type')) {
      db.prepare(`ALTER TABLE ${TABLE} ADD COLUMN trigger_type TEXT NOT NULL DEFAULT 'absolute'`).run();
      console.log("[migrate-v45] announcements.trigger_type added (default 'absolute' — existing rows unchanged).");
    }
    if (!c.includes('close_offset_min')) {
      db.prepare(`ALTER TABLE ${TABLE} ADD COLUMN close_offset_min INTEGER NOT NULL DEFAULT 0`).run();
      console.log('[migrate-v45] announcements.close_offset_min added (default 0).');
    }
    try { db.prepare('INSERT INTO schema_version (version) VALUES (45)').run(); } catch { /* recorded */ }
  });
  migrate();
  console.log('[migrate-v45] Transaction committed.');
}

module.exports = {
  // Pass-through: new scalars on an already-synced table, registered in synced-tables.js. A payload
  // written before v45 simply lacks them; a reader without the columns ignores them.
  payloadTransformer: function payloadTransformer(payload) { return payload; },
  applyMigration,
  isAlreadyMigrated,
};
