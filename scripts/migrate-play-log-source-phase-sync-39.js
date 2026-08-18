'use strict';
// Migration v39 — `source` provenance on play_log: which SOURCE aired this row.
//
// Design: docs/jukebox-deck-source-design-2026-08-17.md §4, and Jeff's clarification of 2026-08-17:
// "The play_log mark is for honest history only."
//
// The jukebox is an EVENT TOOL patched into a deck (D/E/F), not playout. Its plays are real air and
// must appear in Play History like any other deck source — but an operator reading the log needs to
// see that the public picked it, not the scheduler. Without a mark, a jukebox night is indistinguishable
// from rotation in the history, which is the dishonest outcome.
//
// ADDITIVE + NULLABLE:
//   • source TEXT — NULL = ordinary playout (everything that has ever been logged, untouched).
//                   'jukebox' = aired from the jukebox deck source.
//
// NO BACKFILL, deliberately. Every existing row predates the jukebox source, and stamping them with
// anything at all would be inventing history. NULL means "not marked", which is exactly true.
//
// SYNC TREATMENT — SYNCED, unlike the v34 generated_schedule.source it is named after.
//   v34's `source` is local-authoritative PLAYOUT STATE, so it is registered local-only and stripped
//   inbound. This one is the opposite kind of fact: play_log is append-only HISTORY that already syncs
//   (scope 'station'), and the affidavit/reporting reads it. If the row travels and the mark does not,
//   the history is honest on one machine and misleading on every other — the defect this column exists
//   to prevent. So `source` is a plain synced scalar in synced-tables.js, riding with the row it
//   describes. It is never used to make a playout decision, so a remote value cannot steer anything.
//
// Backward compat: a payload from a v38 peer simply has no `source` key; the column is nullable and
// the row lands as unmarked. The transformer below is therefore a pass-through — there is nothing to
// rewrite, and stripping the field would defeat the point above.
//
// Idempotent: adds only the missing column. Verify on a COPY first:
//   ELECTRON_RUN_AS_NODE=1 electron.exe scripts/migrate-play-log-source-phase-sync-39.js <copy.db>

function hasCol(db, t, col) {
  try { return db.prepare(`PRAGMA table_info("${t}")`).all().some(c => c.name === col); } catch { return false; }
}
function tableExists(db, t) {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
}
function isAlreadyMigrated(db) { return hasCol(db, 'play_log', 'source'); }

function applyMigration(db) {
  const migrate = db.transaction(() => {
    let added = 0;
    if (tableExists(db, 'play_log')) {
      if (!hasCol(db, 'play_log', 'source')) {
        db.prepare("ALTER TABLE play_log ADD COLUMN source TEXT").run();   // NULL = ordinary playout
        added++;
      }
    }
    try { db.prepare('INSERT INTO schema_version (version) VALUES (39)').run(); } catch { /* already recorded */ }
    console.log(`[migrate-v39] play_log.source provenance: +${added} column(s).`);
  });
  migrate();
  console.log('[migrate-v39] Transaction committed.');
}

module.exports = {
  // Pass-through by design (see the SYNC TREATMENT note above): `source` is part of the history the
  // row carries, so it must survive the wire in both directions. A v38 payload has no `source` key and
  // lands unmarked, which is accurate rather than a guess.
  payloadTransformer: function payloadTransformer(payload) {
    return payload;
  },
  applyMigration,
  isAlreadyMigrated,
};

if (require.main === module) {
  const path = require('path');
  const Database = require('better-sqlite3');

  const dbPath = process.argv[2];
  if (!dbPath) {
    console.error('Usage: node scripts/migrate-play-log-source-phase-sync-39.js <path-to-db-COPY>');
    console.error('NEVER point this at the live openair.db while Ether is open.');
    process.exit(1);
  }
  console.log(`[migrate-v39] target: ${path.resolve(dbPath)}`);
  const db = new Database(dbPath);

  const before = tableExists(db, 'play_log')
    ? db.prepare('SELECT COUNT(*) c FROM play_log').get().c : 0;

  applyMigration(db);

  let allPass = true;
  const check = (label, ok, detail) => {
    if (!ok) allPass = false;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  };

  check('play_log.source exists', hasCol(db, 'play_log', 'source'));

  if (tableExists(db, 'play_log')) {
    const after = db.prepare('SELECT COUNT(*) c FROM play_log').get().c;
    check('no rows added or lost', after === before, `${before} → ${after}`);
    const marked = db.prepare("SELECT COUNT(*) c FROM play_log WHERE source IS NOT NULL").get().c;
    check('NO backfill — existing history is left unmarked, not invented', marked === 0, `${marked} marked`);
  }

  // The registry must carry the column, or the mark would be dropped from every outbound payload and
  // the history would be honest only on the machine that aired it.
  try {
    const { REGISTRY } = require('../electron/sync/synced-tables.js');
    const cols = REGISTRY && REGISTRY.play_log && REGISTRY.play_log.columns;
    check('registered in synced-tables.js play_log.columns', !!cols && cols.source === 'scalar',
          cols ? `source=${cols.source}` : 'registry unreadable');
  } catch (e) {
    check('registered in synced-tables.js play_log.columns', false, e.message);
  }

  // A marked row round-trips, and an unmarked one stays NULL rather than defaulting to something.
  try {
    db.exec('BEGIN');
    const now = new Date().toISOString();
    const ins = db.prepare(`INSERT INTO play_log (title, artist, deck, deck_id, station_id, uuid, created_at, updated_at, played_at, source)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    ins.run('Probe Jukebox', 'The Probes', 'D', 'D', 2, 'probe-uuid-jukebox', now, now, Math.floor(Date.now() / 1000), 'jukebox');
    ins.run('Probe Rotation', 'The Probes', 'A', 'A', 2, 'probe-uuid-rotation', now, now, Math.floor(Date.now() / 1000), null);
    const j = db.prepare("SELECT source, deck FROM play_log WHERE uuid = 'probe-uuid-jukebox'").get();
    const r = db.prepare("SELECT source FROM play_log WHERE uuid = 'probe-uuid-rotation'").get();
    check("a jukebox play marks source='jukebox' on its deck", j && j.source === 'jukebox' && j.deck === 'D');
    check('an ordinary play stays NULL — unmarked, not mislabelled', r && r.source === null);
    db.exec('ROLLBACK');
  } catch (e) {
    check('a marked row round-trips', false, e.message);
    try { db.exec('ROLLBACK'); } catch { /* already */ }
  }

  try {
    applyMigration(db);
    check('second run is a clean no-op', hasCol(db, 'play_log', 'source'));
  } catch (e) {
    check('second run is a clean no-op', false, e.message);
  }

  db.close();
  if (!allPass) { console.error('\nOne or more post-verification checks FAILED.'); process.exit(1); }
  console.log('\nAll checks PASSED — migration v39 complete.');
}
