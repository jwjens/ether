'use strict';
// Migration v49 — remove date_closing_times. The feature it backed no longer exists.
//
// v46 added per-date closing times as the exception layer over seven weekday closing times. Jeff then
// removed the closing-time concept from the product entirely (2026-08-26): an announcement carries a
// clock time, and nothing scheduled means nothing plays. v48 removed the weekday scope that the
// "before closing" trigger was the last consumer of. That left this table reachable by nothing —
// no UI, no IPC, no resolver, and no entry type that could ever use a closing time.
//
// A synced table nobody can reach is not harmless. It keeps a registry entry, a handler, a sync
// contract and a shape that a future reader would have to understand before touching anything near
// it — and dead surface area is how something gets rediscovered and re-wired years later on the
// assumption it was load-bearing. So it goes.
//
// WHAT THIS DOES
//   1. DROP TABLE date_closing_times.
//   2. Delete this table's rows from `mutations`. They are outbound sync journal entries for a table
//      that no longer exists in the registry: a peer receiving one now answers "protocol violation:
//      received excluded/local-only mutation" (merge-engine Step 2) and rejects it. Leaving them
//      would push a permanent stream of rejections at every peer, forever.
//
// SAFE TO DROP, and this is the reason rather than an assumption: nothing reads it. The IPC handlers
// (get/set/list/clear/resolve closing times), the `closingTimeFor` / `closingTimeForDate` resolvers,
// the `dateClosing` prepared statement and the preload bridges were all removed in the same arc, and
// the panel that edited it was deleted. Verified by grep at the time of writing: the only remaining
// mentions were comments.
//
// v46 STAYS IN THE CHAIN and still creates the table on a fresh install; this then drops it. That is
// deliberate — migrations are history and are not rewritten. A fresh install does a create and a
// drop, which costs microseconds and keeps every machine reaching the same schema the same way.
//
// Idempotent: if the table is already absent it records v49 and returns.
//
//   ELECTRON_RUN_AS_NODE=1 electron.exe scripts/migrate-drop-date-closing-phase-sync-49.js <copy.db>

const TABLE = 'date_closing_times';

function tableExists(db, t) {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
}

function isAlreadyMigrated(db) {
  return !tableExists(db, TABLE);
}

function applyMigration(db) {
  if (isAlreadyMigrated(db)) {
    try { db.prepare('INSERT INTO schema_version (version) VALUES (49)').run(); } catch (e) { /* recorded */ }
    console.log('[migrate-v49] SKIP — date_closing_times is already gone');
    return;
  }

  const migrate = db.transaction(() => {
    let rows = 0;
    try { rows = db.prepare(`SELECT COUNT(*) n FROM ${TABLE}`).get().n; } catch { rows = 0; }

    // Said out loud rather than dropped silently. If a station somehow had closing times set, this is
    // the line that tells whoever reads the log what went away and how much of it there was.
    console.log(`[migrate-v49] dropping ${TABLE} (${rows} row${rows === 1 ? '' : 's'}) — the closing-time feature was removed`);
    db.prepare(`DROP TABLE ${TABLE}`).run();

    // The outbound journal for a table that no longer exists in the registry. Wrapped: a machine with
    // no mutations table (or an unexpected shape) must still get the drop.
    try {
      const n = db.prepare("DELETE FROM mutations WHERE table_name = ?").run(TABLE).changes;
      if (n) console.log(`[migrate-v49] removed ${n} orphaned sync mutation(s) for ${TABLE}`);
    } catch (e) {
      console.log('[migrate-v49] mutations cleanup skipped (' + e.message + ') — the drop still stands');
    }

    db.prepare('INSERT INTO schema_version (version) VALUES (49)').run();
  });
  migrate();
  console.log('[migrate-v49] Transaction committed.');
}

module.exports = {
  payloadTransformer: function payloadTransformer(payload) {
    // Identity. A v46-era peer can still send a date_closing_times mutation; it is rejected at
    // merge-engine Step 2 because the table is no longer in the registry, which is the correct
    // outcome and needs no transform.
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

  console.log('=== migrate-drop-date-closing-phase-sync-49.js ===');
  console.log('DB:', dbPath);
  applyMigration(db);
  db.close();
}
