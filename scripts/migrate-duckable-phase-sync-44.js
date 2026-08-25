'use strict';
// Migration v44 — deck_configs.duckable: which decks step back when a source ducks.
//
// The ducker is a sidechain: a TRIGGER (a source channel with DUCK ON) and a SET OF CHANNELS it acts
// on. Until now that set was "everything that is not a source channel" — every rotation deck AND
// CART — with no say in it. Real consoles let you choose what the sidechain touches.
//
// Jeff's ruling, 2026-08-25: every deck is individually duckable or immune, chosen by the operator
// per station, from a checkbox list in that station's Ducker preferences. Not a baked-in rule about
// any particular deck.
//
// DEFAULT 1 — DUCKABLE, on purpose. That is exactly today's behaviour, so this migration changes
// nothing about how any existing station sounds. A station that wants sound effects to punch through
// a duck unchecks CART itself; a station that never opens the panel keeps what it has always had.
// The alternative — defaulting CART immune — would have altered the on-air sound of every install
// that never asked for it.
//
// The rule that a SOURCE channel is never itself ducked is NOT this column: it is structural, from
// the slot's kind in the mixer callback. You do not duck the thing that is doing the ducking.
//
// Idempotent — the column add is guarded on the live schema. Fail-soft is the caller's contract.
//
// Verify on a COPY first:
//   ELECTRON_RUN_AS_NODE=1 electron.exe scripts/migrate-duckable-phase-sync-44.js <copy.db>

const TABLE = 'deck_configs';

function tableExists(db, t) {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
}
function columns(db, t) {
  try { return db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name); }
  catch { return []; }
}
function isAlreadyMigrated(db) {
  return columns(db, TABLE).includes('duckable');
}

function applyMigration(db) {
  if (!tableExists(db, TABLE)) {
    console.log('[migrate-v44] deck_configs absent — nothing to migrate.');
    try { db.prepare('INSERT INTO schema_version (version) VALUES (44)').run(); } catch { /* recorded */ }
    return;
  }
  const migrate = db.transaction(() => {
    if (!columns(db, TABLE).includes('duckable')) {
      db.prepare(`ALTER TABLE ${TABLE} ADD COLUMN duckable INTEGER NOT NULL DEFAULT 1`).run();
      console.log('[migrate-v44] deck_configs.duckable added (default 1 — every deck ducks, as today).');
    } else {
      console.log('[migrate-v44] deck_configs.duckable already present — no-op.');
    }
    try { db.prepare('INSERT INTO schema_version (version) VALUES (44)').run(); } catch { /* recorded */ }
  });
  migrate();
  console.log('[migrate-v44] Transaction committed.');
}

module.exports = {
  // Pass-through: a new scalar on an already-synced table, registered in synced-tables.js. A payload
  // written before v44 simply lacks it and a reader without the column ignores it.
  payloadTransformer: function payloadTransformer(payload) { return payload; },
  applyMigration,
  isAlreadyMigrated,
};
