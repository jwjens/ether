'use strict';
// Migration v33 — playhead + per-row lifecycle on generated_schedule (Log-Reader Flip, Phase 0).
// Design: docs/log-reader-single-source-playout-design-2026-07-20.md (§2.2, §5, §6). APPROVED.
//
// Goal of the whole arc: generated_schedule IS the single source of playout — no parallel queue that
// can diverge. Phase 0 is ADDITIVE + INERT: it adds the columns the playhead needs and backfills
// existing rows. Nothing reads or writes these columns yet (the shadow writer is Phase 1; the read
// flip is Phase 3, behind a flag). This migration changes NO runtime behavior.
//
// ADDITIVE — adds to generated_schedule:
//   • state      TEXT DEFAULT 'pending'  — per-row lifecycle: 'pending' | 'playing' | 'played' | 'skipped'.
//                                          The PLAYHEAD is the derived row where state='playing' (§2.2).
//   • played_at  INTEGER                 — unix seconds the row actually aired (stamped by the engine, Phase 1).
//   • seq        REAL                    — explicit monotonic play-order, decoupled from scheduled_at so a
//                                          future reorder/insert (Phase 4) needn't restamp meaningful times (§6.2).
//
// SYNC (§5, load-bearing): these three columns are LOCAL-AUTHORITATIVE playout state — registered
// 'local-only' in electron/sync/synced-tables.js so serializePayload NEVER puts them in a mutation
// payload. They are per-machine truth (the always-on local engine owns the playhead), pushed for
// display only, NEVER CRDT-merged — this is what avoids the peer-sync last-write-wins fight over the
// playhead (see project_peer_sync_station_uuid). The plan columns (scheduled_at/song_id/…) stay synced.
//
// Idempotent: adds only missing columns; backfill is safe to re-run. Verify on a COPY first:
//   node scripts/migrate-generated-schedule-playhead-lifecycle-phase-sync-33.js <copy.db>

function hasCol(db, t, col) {
  try { return db.prepare(`PRAGMA table_info("${t}")`).all().some(c => c.name === col); } catch { return false; }
}
function tableExists(db, t) {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
}
function isAlreadyMigrated(db) { return hasCol(db, 'generated_schedule', 'state'); }

function applyMigration(db) {
  const migrate = db.transaction(() => {
    let added = 0;
    if (tableExists(db, 'generated_schedule')) {
      const add = (col, ddl) => { if (!hasCol(db, 'generated_schedule', col)) { db.prepare(`ALTER TABLE generated_schedule ADD COLUMN ${ddl}`).run(); added++; } };
      add('state',     "state TEXT DEFAULT 'pending'");
      add('played_at', 'played_at INTEGER');
      add('seq',       'seq REAL');

      // Backfill state: rows whose scheduled time is already in the past are effectively consumed →
      // 'played'; everything at/after now stays 'pending'. NOTE: `ADD COLUMN … DEFAULT 'pending'`
      // already pre-fills EVERY existing row with 'pending', so the past-row backfill must guard on
      // state='pending' (the default), NOT on NULL. The 'pending' guard also makes this idempotent and
      // safe if ever re-run: it never clobbers a runtime 'playing'/'skipped'/'played'. 'playing' and
      // played_at are set only at runtime (Phase 1), never by backfill. (scheduled_at is unix SECONDS.)
      const nowSec = Math.floor(Date.now() / 1000);
      db.prepare("UPDATE generated_schedule SET state='pending' WHERE state IS NULL OR state=''").run();       // belt: normalize any stray NULL
      db.prepare("UPDATE generated_schedule SET state='played'  WHERE state='pending' AND scheduled_at < ?").run(nowSec);

      // Backfill seq: dense play-order per station, ordered by scheduled_at then id (the current
      // effective sequence). REAL so future inserts-between can use fractional keys without a rewrite.
      // Re-number ALL rows every run (NOT `WHERE seq IS NULL`) so the backfill is truly idempotent: a
      // NULL-guarded fill collides on re-run once new (runway-appended) rows sit alongside already-
      // numbered ones — ROW_NUMBER restarts at 1 and overlaps existing seq. Re-numbering all rows keeps
      // seq unique+dense on every run. (On the live DB this runs once, version-gated; Generate-side seq
      // for rows added AFTER this migration lands in a later phase — until then new rows carry NULL seq,
      // which the Phase 3 read path resolves via a scheduled_at fallback.)
      db.prepare(`
        WITH ranked AS (
          SELECT id, ROW_NUMBER() OVER (PARTITION BY station_id ORDER BY scheduled_at, id) AS rn
          FROM generated_schedule
        )
        UPDATE generated_schedule
           SET seq = (SELECT rn FROM ranked WHERE ranked.id = generated_schedule.id)
      `).run();

      // Playhead read index: the engine will resolve "current + next N pending rows" by (station, state, seq).
      db.prepare("CREATE INDEX IF NOT EXISTS idx_gensched_playhead ON generated_schedule(station_id, state, seq)").run();
    }
    try { db.prepare('INSERT INTO schema_version (version) VALUES (33)').run(); } catch { /* already recorded */ }
    console.log(`[migrate-v33] generated_schedule playhead lifecycle: +${added} column(s) (state/played_at/seq) + backfill + idx_gensched_playhead.`);
  });
  migrate();
  console.log('[migrate-v33] Transaction committed.');
}

module.exports = {
  // The lifecycle columns are LOCAL-ONLY (§5): serializePayload already excludes them outbound. This
  // transformer enforces the same INBOUND — defensively strip state/played_at/seq from any incoming
  // sync payload (e.g. a legacy or misbehaving peer) so a remote write can NEVER clobber this machine's
  // playhead. A synced-in plan row then simply takes state DEFAULT 'pending' + seq NULL locally.
  payloadTransformer: function payloadTransformer(payload) {
    if (payload && typeof payload === 'object') {
      delete payload.state;
      delete payload.played_at;
      delete payload.seq;
    }
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

  console.log('=== migrate-generated-schedule-playhead-lifecycle-phase-sync-33.js ===');
  console.log('DB:', dbPath, isAlreadyMigrated(db) ? '(already migrated — will no-op the ALTERs)' : '');
  const versions0 = db.prepare('SELECT version FROM schema_version ORDER BY version').all().map(r => r.version);
  console.log('current schema_version:', versions0.length ? Math.max(...versions0) : '(none)');
  const before = db.prepare("SELECT COUNT(*) c FROM generated_schedule").get().c;
  console.log('generated_schedule rows:', before);

  applyMigration(db);

  console.log('\n=== Post-verification ===');
  let allPass = true;
  const check = (label, pass, detail) => { console.log(`[${pass ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`); if (!pass) allPass = false; };
  const newVersion = Math.max(...db.prepare('SELECT version FROM schema_version ORDER BY version').all().map(r => r.version));
  check('schema_version = 33', newVersion === 33, `got ${newVersion}`);
  for (const col of ['state', 'played_at', 'seq']) check(`generated_schedule.${col} exists`, hasCol(db, 'generated_schedule', col));
  const idxExists = !!db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_gensched_playhead'").get();
  check('idx_gensched_playhead index exists', idxExists);
  const nullState = db.prepare("SELECT COUNT(*) c FROM generated_schedule WHERE state IS NULL OR state=''").get().c;
  check('no NULL/empty state rows remain', nullState === 0, `got ${nullState}`);
  const badState = db.prepare("SELECT COUNT(*) c FROM generated_schedule WHERE state NOT IN ('pending','playing','played','skipped')").get().c;
  check('all state values in the allowed set', badState === 0, `got ${badState}`);
  // Backfill correctness: past rows → played, future rows → pending (guards the DEFAULT-'pending' + unit trap).
  const nowSec2 = Math.floor(Date.now() / 1000);
  const pastNotPlayed = db.prepare("SELECT COUNT(*) c FROM generated_schedule WHERE scheduled_at < ? AND state != 'played'").get(nowSec2).c;
  check('all past rows backfilled to played', pastNotPlayed === 0, `${pastNotPlayed} past rows not played`);
  const futureNotPending = db.prepare("SELECT COUNT(*) c FROM generated_schedule WHERE scheduled_at >= ? AND state != 'pending'").get(nowSec2).c;
  check('all future rows are pending', futureNotPending === 0, `${futureNotPending} future rows not pending`);
  const total = db.prepare("SELECT COUNT(*) c FROM generated_schedule").get().c;
  const nullSeq = db.prepare("SELECT COUNT(*) c FROM generated_schedule WHERE seq IS NULL").get().c;
  check('every existing row got a seq', nullSeq === 0, `${nullSeq} NULL of ${total}`);
  // seq must be unique + contiguous within each station (dense rank).
  const dupSeq = db.prepare("SELECT COUNT(*) c FROM (SELECT station_id, seq FROM generated_schedule GROUP BY station_id, seq HAVING COUNT(*) > 1)").get().c;
  check('seq is unique within each station', dupSeq === 0, `${dupSeq} collisions`);
  check('row count unchanged (additive only)', total === before, `before ${before}, after ${total}`);

  db.close();
  if (!allPass) { console.error('\nOne or more post-verification checks FAILED.'); process.exit(1); }
  console.log('\nAll checks PASSED — migration v33 complete.');
}
