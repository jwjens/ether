'use strict';
// Migration v60 — jukebox_requests.requester_token: who asked, on the web.
//
// Jeff, 2026-09-11: "One song at a time is the rule."
//
// THE PROBLEM IT SOLVES. "One pending request per requester" needs a requester. Today the only thing
// identifying anyone on the public request page is a typed name capped at 40 characters — so the rule
// would be defeated by typing a different name, which is not a rule at all. The page will mint a
// random token into localStorage and send it with every request; this column is where it lands.
//
// WHAT IT IS NOT. Not an identity, and it must never be described as one in the UI. It is defeated by
// clearing site data, a private window, or a second phone. It exists to stop the ACCIDENTAL twenty —
// the double-tap, the impatient re-send, the friend borrowing the phone. The deliberate twenty is
// stopped by the paywall that comes after this, which is the honest division of labour: the guards
// make abuse orderly, the price makes it self-limiting.
//
// NULLABLE, and that is not laziness. Three kinds of row will never have one:
//   • every row already on OV today (there is no prior source — no backfill is possible or wanted);
//   • kiosk requests, typed at the machine, where the person is standing in front of the operator;
//   • a web request from a browser that refuses localStorage.
// The gate treats a missing token by falling back to the requester's NAME, which is weaker and is
// meant to be — see jukeboxAdmit() in electron/main.js.
//
// NOT SYNCED. jukebox_requests is local-only by design (see the v38 header): a request is a live event
// at one venue on one night, not shared state. The column inherits that and is not registered in
// synced-tables.js. A token is per-device-per-venue and would be meaningless on another install.
//
// INDEX. The gate's hot query is "does this token already have something pending at this station",
// which runs on every incoming request, so (station_id, requester_token, status) earns its keep.
//
// Idempotent: adds nothing if the column is already there, and records v60 either way.

const TABLE = 'jukebox_requests';

function tableExists(db, t) {
  try { return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t); }
  catch { return false; }
}

function columns(db, t) {
  try { return db.prepare(`PRAGMA table_info(${t})`).all().map(r => r.name); }
  catch { return []; }
}

function isAlreadyMigrated(db) {
  if (!tableExists(db, TABLE)) return true;          // nothing to migrate on this install
  return columns(db, TABLE).includes('requester_token');
}

function applyMigration(db) {
  const migrate = db.transaction(() => {
    if (!tableExists(db, TABLE)) {
      console.log('[migrate-v60] jukebox_requests absent — nothing to migrate.');
    } else if (!columns(db, TABLE).includes('requester_token')) {
      db.prepare(`ALTER TABLE ${TABLE} ADD COLUMN requester_token TEXT`).run();
      console.log('[migrate-v60] jukebox_requests.requester_token added.');
      try {
        db.prepare(`CREATE INDEX IF NOT EXISTS idx_${TABLE}_token ON ${TABLE} (station_id, requester_token, status)`).run();
        console.log('[migrate-v60] index on (station_id, requester_token, status) created.');
      } catch (e) {
        console.warn('[migrate-v60] index not created (non-fatal):', e.message);
      }
    } else {
      console.log('[migrate-v60] jukebox_requests.requester_token already present — no-op.');
    }
    try { db.prepare('INSERT INTO schema_version (version) VALUES (60)').run(); } catch { /* recorded */ }
  });
  migrate();
  console.log('[migrate-v60] Transaction committed.');
}

module.exports = {
  // Pass-through: jukebox_requests is not a synced table, so nothing about this column reaches a wire.
  payloadTransformer: function payloadTransformer(payload) { return payload; },
  applyMigration,
  isAlreadyMigrated,
  TABLES: [TABLE],
};
