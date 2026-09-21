'use strict';
// Migration v61 — drop scheduled_log. The table nothing ever wrote.
//
// Program Log slice 6, 2026-09-20 (docs/program-log-one-surface-2026-09-17.md §6). The Program Log
// reads and writes generated_schedule — the log the engine airs — since slices 1–4. scheduled_log was
// the panel's original target: every INSERT into it silently failed (column names that never existed
// on the live table), so it held 0 rows on every install ever measured (docs/program-log-wiring-
// 2026-09-17.md §3, docs/phase-3.5-programlog-deferred.md). Its last readers (Schedule Preview, the
// Voice Tracker's hour context, Listener Analytics' category panel, Cloud Backup's restore branch) and
// its code (the sync handler, the preload namespace, the registry entry) were removed in the same
// commit as this file.
//
// WHAT THIS DOES
//   1. REFUSES if the table is not empty. It is expected to be empty everywhere; if a machine somehow
//      holds rows, this migration throws with the count, runMigrationChain logs it as a non-fatal skip
//      (the app still starts, the table stays, v61 is not recorded, it retries next launch) and a
//      human decides. Nothing is migrated because there is nothing to migrate — and if there were,
//      dropping it silently would be the wrong answer.
//   2. DROP TABLE scheduled_log.
//   3. Deletes this table's rows from `mutations` — outbound journal entries for a table no longer in
//      the registry, which a peer would reject at merge-engine Step 2 forever (the v49 precedent).
//
// v0 (the baseline), v1 and v2 STAY IN THE CHAIN and still create / touch the table on a fresh
// install; this then drops it. Migrations are history and are not rewritten (the v49 rule): a fresh
// install does a create and a drop, and every machine reaches the same schema the same way.
//
// play_log.scheduled_log_id is a COLUMN on play_log (v0 baseline, synced, written NULL by the daemon)
// and is untouched — it is not this table.
//
// Idempotent: if the table is already absent it records v61 and returns.
//
//   ELECTRON_RUN_AS_NODE=1 electron.exe scripts/migrate-drop-scheduled-log-phase-sync-61.js <copy.db>

const TABLE = 'scheduled_log';
const VERSION = 61;

function tableExists(db, t) {
  try { return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t); }
  catch { return false; }
}

function isAlreadyMigrated(db) {
  return !tableExists(db, TABLE);
}

function applyMigration(db) {
  if (isAlreadyMigrated(db)) {
    try { db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(VERSION); } catch { /* recorded */ }
    console.log(`[migrate-v${VERSION}] SKIP — ${TABLE} is already gone`);
    return;
  }

  // The refusal happens BEFORE the transaction: a table with rows is not ours to drop.
  const rows = db.prepare(`SELECT COUNT(*) n FROM ${TABLE}`).get().n;
  if (rows !== 0) {
    throw new Error(`[migrate-v${VERSION}] REFUSED — ${TABLE} holds ${rows} row(s); it was expected to be empty on every install. Nothing dropped, v${VERSION} not recorded. Inspect the rows before deciding.`);
  }

  const migrate = db.transaction(() => {
    console.log(`[migrate-v${VERSION}] dropping ${TABLE} (0 rows) — the Program Log reads and writes generated_schedule`);
    db.prepare(`DROP TABLE ${TABLE}`).run();
    try {
      const n = db.prepare('DELETE FROM mutations WHERE table_name = ?').run(TABLE).changes;
      if (n) console.log(`[migrate-v${VERSION}] removed ${n} orphaned sync mutation(s) for ${TABLE}`);
    } catch (e) {
      console.log(`[migrate-v${VERSION}] mutations cleanup skipped (${e.message}) — the drop still stands`);
    }
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(VERSION);
  });
  migrate();
  console.log(`[migrate-v${VERSION}] Transaction committed.`);
}

module.exports = {
  // Identity. An older peer can still send a scheduled_log mutation; it is rejected at merge-engine
  // Step 2 because the table is no longer in the registry — the correct outcome, no transform needed.
  payloadTransformer: function payloadTransformer(payload) { return payload; },
  applyMigration,
  isAlreadyMigrated,
  TABLES: [TABLE],
};

if (require.main === module) {
  const path = require('path');
  const os   = require('os');
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const dbPath = process.argv[2] || path.join(localAppData, 'Ether', 'com.ether.radio', 'openair.db');
  const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));
  const db = new Database(dbPath);
  console.log('=== migrate-drop-scheduled-log-phase-sync-61.js ===');
  console.log('DB:', dbPath);
  applyMigration(db);
  db.close();
}
