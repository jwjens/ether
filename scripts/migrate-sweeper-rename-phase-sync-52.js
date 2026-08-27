'use strict';
// Migration v52 — "jingle" is retired. One imaging concept: SWEEPER.
//
// docs/jingle-eradication-plan-2026-08-27.md · docs/library-current-state.md
//
// Jeff's ruling, 2026-08-27: the jingle name was a mistake and comes out of the system entirely —
// UI, code and data. JIN → SWP, one type, one tab, one vocabulary.
//
// FILE NAME: this follows the repo's transformer convention, `migrate-<name>-phase-sync-<N>.js` in
// `scripts/`. The chain verifier discovers migrations with /^migrate-.+-phase-sync-(\d+)\.js$/ and
// scans `scripts/` only — a file at `scripts/migrations/052-*.js` would never be found or run.
//
// ── WHY THIS IS A PLAIN UPDATE ──────────────────────────────────────────────────────────────────
// Verified against the live database before this was written:
//   • no CHECK constraint on content_class (songs / generated_schedule / play_log)
//   • no CHECK constraint on jingle_categories.type
//   • no declared foreign key anywhere referencing jingle_categories
// So no table rebuild, no column reshape — the database stays openable by the PREVIOUS build, which
// is the 4.4.151 rule (docs/migration-safety-and-customer-recovery-2026-08-06.md).
//
// SWP was entirely unused (0 rows in every table), so this is a pure relabel of one value. Nothing
// is merged and nothing collides.
//
// ── THE ATOMIC PAIRING, AND WHY IT IS THE WHOLE POINT ───────────────────────────────────────────
// The overlay scheduler selects imaging with
//     WHERE s.jingle_category_id = ? AND s.content_class = ?        (electron/main.js:7887)
// and supplies that second parameter from the POOL'S TYPE (main.js:7914). Retype the pools without
// the songs — or the songs without the pools — and resolvePool() matches nothing, returns an empty
// candidate list, and IMAGING SILENTLY STOPS AIRING: the error is swallowed by a catch and the
// caller simply continues. Hence one transaction, both tables, never separately.
//
// ── WHY THIS DOES NOT JOURNAL ───────────────────────────────────────────────────────────────────
// Raw UPDATEs, deliberately NOT withMutation. Three reasons, in order of severity:
//   1. Double application. Migrations run on EVERY install, so a journalled change arrives twice on
//      a peer — once from its own v52, once from the incoming mutation. v50 and v51 journal zero for
//      exactly this reason.
//   2. Journal flood. 62,774 rows. generated_schedule already carries 27,886 journal entries and
//      play_log 6,538; docs/backlog.md records generated_schedule as the single largest contributor
//      to sync backlog. This would roughly triple it in one migration.
//   3. Convergence does not need it. The transformation is deterministic — every install computes
//      the identical result from data it already holds.
//
// ── WHAT THIS DOES NOT TOUCH ────────────────────────────────────────────────────────────────────
// The `jingle_categories` TABLE NAME stays. It is a synced table and the receiver dispatches on
// REGISTRY[m.table_name] (merge-engine.js:111, :330), so a renamed install would silently DROP a
// peer's mutation carrying the old name — two installs diverging with nothing on screen to say so.
// The name is invisible to operators; the ruling was about what users see.
//
// Also untouched: library_asset (already SWEEPER=64), songs.jingle_category_id values,
// station_programming, song_metadata_values.

const VERSION = 52;
const OLD = 'JIN';
const NEW = 'SWP';

function tableExists(db, name) {
  try {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  } catch { return false; }
}

function countJin(db) {
  const out = {};
  for (const [t, c] of [['jingle_categories', 'type'], ['songs', 'content_class'],
                        ['generated_schedule', 'content_class'], ['play_log', 'content_class']]) {
    if (!tableExists(db, t)) { out[t] = null; continue; }
    try { out[t] = db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE ${c} = ?`).get(OLD).n; }
    catch { out[t] = null; }
  }
  return out;
}

/** Idempotent by OUTCOME, not by a flag: the work is done when no 'JIN' remains anywhere. */
function isAlreadyMigrated(db) {
  const c = countJin(db);
  return Object.values(c).every(n => n === null || n === 0);
}

function applyMigration(db) {
  if (isAlreadyMigrated(db)) {
    try { db.prepare(`INSERT INTO schema_version (version) VALUES (${VERSION})`).run(); } catch (e) { /* recorded */ }
    console.log(`[migrate-v${VERSION}] already applied — no '${OLD}' rows remain`);
    return;
  }

  const before = countJin(db);
  console.log(`[migrate-v${VERSION}] before: ` +
    Object.entries(before).map(([t, n]) => `${t}=${n === null ? 'absent' : n}`).join('  '));

  const migrate = db.transaction(() => {
    const now = new Date().toISOString();
    let pools = 0, songs = 0, sched = 0, plays = 0;

    // 1 + 2. THE ATOMIC PAIRING. Pools and songs move together or imaging stops airing.
    if (tableExists(db, 'jingle_categories')) {
      pools = db.prepare(`UPDATE jingle_categories SET type = ?, updated_at = ? WHERE type = ?`)
                .run(NEW, now, OLD).changes;
    }
    if (tableExists(db, 'songs')) {
      songs = db.prepare(`UPDATE songs SET content_class = ?, updated_at = ? WHERE content_class = ?`)
                .run(NEW, now, OLD).changes;
    }

    // 3. The log. Mostly the FUTURE log, not history — 44,098 of these rows were still pending when
    //    this was written, so they are migrated rather than left to air under a retired name.
    if (tableExists(db, 'generated_schedule')) {
      sched = db.prepare(`UPDATE generated_schedule SET content_class = ? WHERE content_class = ?`)
                .run(NEW, OLD).changes;
    }

    // 4. The as-run record. Migrated per the ruling that the name goes entirely.
    if (tableExists(db, 'play_log')) {
      plays = db.prepare(`UPDATE play_log SET content_class = ? WHERE content_class = ?`)
                .run(NEW, OLD).changes;
    }

    console.log(`[migrate-v${VERSION}] jingle_categories.type   ${OLD}->${NEW}: ${pools}`);
    console.log(`[migrate-v${VERSION}] songs.content_class      ${OLD}->${NEW}: ${songs}`);
    console.log(`[migrate-v${VERSION}] generated_schedule       ${OLD}->${NEW}: ${sched}`);
    console.log(`[migrate-v${VERSION}] play_log                 ${OLD}->${NEW}: ${plays}`);

    // THE INVARIANT THAT MATTERS. Every sweeper song must still point at a pool whose type matches
    // its class, because that pairing is what resolvePool() joins on. If this is ever non-zero the
    // transaction rolls back rather than leaving an install whose imaging cannot resolve.
    if (tableExists(db, 'songs') && tableExists(db, 'jingle_categories')) {
      const orphaned = db.prepare(`
        SELECT COUNT(*) n FROM songs s
          JOIN jingle_categories jc ON jc.id = s.jingle_category_id
         WHERE s.deleted_at IS NULL AND s.content_class = ? AND jc.type != ?`).get(NEW, NEW).n;
      if (orphaned > 0) {
        throw new Error(`[migrate-v${VERSION}] ${orphaned} sweeper song(s) point at a pool whose type ` +
          `is not ${NEW} — resolvePool would return nothing and imaging would stop airing. Rolled back.`);
      }
    }

    db.prepare(`INSERT INTO schema_version (version) VALUES (${VERSION})`).run();
  });

  migrate();

  const after = countJin(db);
  const remaining = Object.entries(after).filter(([, n]) => n).map(([t, n]) => `${t}=${n}`);
  console.log(`[migrate-v${VERSION}] committed — ` +
    (remaining.length ? `WARNING, '${OLD}' still present: ${remaining.join(' ')}` : `no '${OLD}' remains anywhere`));
}

module.exports = {
  payloadTransformer: function payloadTransformer(payload) {
    // A pre-v52 peer still says JIN. Rewriting the class on the way in keeps this install's data in
    // one vocabulary rather than letting the retired name back in through sync. Only the class value
    // changes; the payload shape is identical, so an older peer applies our payloads unchanged too
    // (it reads SWP, which it has always understood as a sweeper).
    if (payload && typeof payload === 'object') {
      if (payload.content_class === OLD) payload.content_class = NEW;
      if (payload.type === OLD) payload.type = NEW;
    }
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
  console.log('=== migrate-sweeper-rename-phase-sync-52.js ===');
  console.log('DB:', dbPath);
  applyMigration(db);
  db.close();
}
