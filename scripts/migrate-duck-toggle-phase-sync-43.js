'use strict';
// Migration v43 — deck_configs.duck: the per-channel ducker toggle.
//
// Slice 3 of docs/aux-channel-ducker-announcements-design-2026-08-21.md (§B.6: "Enabled — per-aux-
// channel toggle"). When a SOURCE channel has audio, the programme ducks UNDER it and rises back
// when it stops. Whether a given channel does that is a property OF THAT CHANNEL, so it lives on the
// channel's own row rather than in a side table keyed by slot — "no migration needed" is how a
// temporary shape becomes permanent.
//
// DEFAULT 0 — OFF, deliberately, like every other processing toggle on this bus. An install's audio
// does not change until an operator asks for it, and the native default matches (BusState::new sets
// duck_enabled all-false), so the two cannot disagree on a fresh machine.
//
// ONLY SOURCE CHANNELS CAN DUCK, and that is enforced in Rust, not here: the detector reads the
// slot's declared SlotKind, so a Rotation deck or CART cannot arm the ducker even with this column
// set to 1 (native/src/audio.rs, and proven by duck_regression::rotation_and_cart_can_never_duck).
// A sweeper must never duck the song it is sweeping into. This column is a preference; the kind is
// the rule.
//
// Idempotent — the column add is guarded on the live schema, so a second run is a clean no-op.
// Fail-soft is the caller's contract (runMigrationChain logs and continues).
//
// Verify on a COPY first:
//   ELECTRON_RUN_AS_NODE=1 electron.exe scripts/migrate-duck-toggle-phase-sync-43.js <copy.db>

const TABLE = 'deck_configs';

function tableExists(db, t) {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
}
function columns(db, t) {
  try { return db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name); }
  catch { return []; }
}
function isAlreadyMigrated(db) {
  return columns(db, TABLE).includes('duck');
}

function applyMigration(db) {
  if (!tableExists(db, TABLE)) {
    console.log('[migrate-v43] deck_configs absent — nothing to migrate.');
    try { db.prepare('INSERT INTO schema_version (version) VALUES (43)').run(); } catch { /* recorded */ }
    return;
  }

  const migrate = db.transaction(() => {
    if (!columns(db, TABLE).includes('duck')) {
      db.prepare(`ALTER TABLE ${TABLE} ADD COLUMN duck INTEGER NOT NULL DEFAULT 0`).run();
      console.log('[migrate-v43] deck_configs.duck added (default 0 — ducking off everywhere).');
    } else {
      console.log('[migrate-v43] deck_configs.duck already present — no-op.');
    }
    try { db.prepare('INSERT INTO schema_version (version) VALUES (43)').run(); } catch { /* recorded */ }
  });
  migrate();
  console.log('[migrate-v43] Transaction committed.');
}

module.exports = {
  // Pass-through: `duck` is a new scalar on an already-synced table, registered in synced-tables.js.
  // A payload written before v43 simply lacks it and a reader without the column ignores it — there
  // is nothing on the wire to rewrite.
  payloadTransformer: function payloadTransformer(payload) { return payload; },
  applyMigration,
  isAlreadyMigrated,
};
