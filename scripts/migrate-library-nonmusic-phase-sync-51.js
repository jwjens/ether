'use strict';
// Migration v51 — the library holds the NON-MUSIC element types.
//
// docs/library-current-state.md  ← the source of truth; Jeff ruled Option 1 on 2026-08-27.
//
// THE RULING THIS IMPLEMENTS, VERBATIM IN EFFECT:
//   `songs` stays the sole source of truth for music, untouched. `library_asset` holds the element
//   types that had nowhere else to live as typed entries — SPOT, SWEEPER, ANNOUNCEMENT — and the UI
//   panels become filtered views over it.
//
// There is NO ruling to drop `songs` or to make library_asset authoritative for music. Nothing here
// assumes one, and no future migration may assume one without an explicit ruling.
//
// ── WHAT THIS DOES ──────────────────────────────────────────────────────────────────────────────
//   1. Retires the duplicated SONG rows v50 copied out of `songs`. They were never read by any UI,
//      and after the 4a revert nothing reads them at all. Leaving them is worse than removing them:
//      library_asset has no writer outside the sync layer, so those rows are a snapshot frozen at
//      v50 that drifts further from `songs` with every edit — a second, staler answer to "what is
//      this song", sitting in the table the panels are about to start reading.
//   2. Backfills the announcements as type='ANNOUNCEMENT', so every non-music element type is a
//      typed library entry.
//
// ── WHY THIS DOES NOT JOURNAL MUTATIONS ─────────────────────────────────────────────────────────
// It would be wrong here, not merely unnecessary. Migrations run on EVERY install, so a journalled
// backfill arrives twice on a peer: once from its own v51, once from the incoming mutation. v50
// journals zero mutations for exactly this reason.
//
// Convergence comes from DETERMINISM instead: the asset row REUSES the announcement's uuid, so every
// install computes byte-identical rows from data it already has. That is also the established
// contract in this tree — v50 reused songs.uuid and spots.uuid (543 and 3 rows match respectively),
// and the 4a join was `la.uuid = s.uuid`.
//
// The sanctioned sync path (withMutation) belongs on the RUNTIME writer — announcements created from
// now on — in electron/sync/handlers/library_asset.js. Not here.
//
// ── SAFETY ──────────────────────────────────────────────────────────────────────────────────────
// `songs`, `spots`, `announcements`, `station_programming` and `song_metadata_values` are NOT
// touched. No column is added, dropped or reshaped, so the database stays openable by the previous
// build — the 4.4.151 rule (docs/migration-safety-and-customer-recovery-2026-08-06.md).
//
// Verified before writing: nothing references the SONG asset rows. station_programming has 12 rows
// with asset_uuid populated on 0 of them; song_metadata_values has 0 rows. The delete orphans
// nothing.

const VERSION = 51;

function tableExists(db, name) {
  try {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  } catch { return false; }
}

/** Idempotent by OUTCOME, not by a flag: the work is done when no SONG rows remain and every live
 *  announcement has its asset row. Re-running then changes nothing. */
function isAlreadyMigrated(db) {
  if (!tableExists(db, 'library_asset')) return false;          // v50 never ran; nothing to do here
  try {
    const songs = db.prepare("SELECT COUNT(*) n FROM library_asset WHERE type='SONG'").get().n;
    if (songs > 0) return false;
    if (tableExists(db, 'spots')) {
      const spotGap = db.prepare(`
        SELECT COUNT(*) n FROM spots s
         WHERE s.deleted_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM library_asset la WHERE la.uuid = s.uuid AND la.type = 'SPOT')`).get().n;
      if (spotGap > 0) return false;
      const stray = db.prepare(`
        SELECT COUNT(*) n FROM library_asset la
         WHERE la.type = 'SPOT' AND la.deleted_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM spots s WHERE s.uuid = la.uuid AND s.deleted_at IS NULL)`).get().n;
      if (stray > 0) return false;
    }
    if (tableExists(db, 'announcements')) {
      const missing = db.prepare(`
        SELECT COUNT(*) n FROM announcements a
         WHERE a.deleted_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM library_asset la WHERE la.uuid = a.uuid)`).get().n;
      if (missing > 0) return false;
    }
    return true;
  } catch { return false; }
}

function applyMigration(db) {
  if (isAlreadyMigrated(db)) {
    try { db.prepare(`INSERT INTO schema_version (version) VALUES (${VERSION})`).run(); } catch (e) { /* recorded */ }
    console.log(`[migrate-v${VERSION}] already applied — nothing to do`);
    return;
  }

  if (!tableExists(db, 'library_asset')) {
    // v50 is a hard prerequisite and migrations are fail-soft, so say so loudly rather than throwing
    // into initDb() and dead-ending a launch.
    console.warn(`[migrate-v${VERSION}] library_asset absent — v50 has not run. Skipping; v51 will apply on the next open.`);
    return;
  }

  const migrate = db.transaction(() => {
    // ── 1. Retire the duplicated SONG rows ────────────────────────────────────────────────────
    // A hard DELETE, not a soft one. A soft delete would leave them matching `la.uuid = s.uuid`
    // joins and still colliding with the UNIQUE uuid index, so a later re-add of the same song
    // would fail. Nothing references them (verified above), and `songs` is untouched and remains
    // the complete record of every one of them.
    const songBefore = db.prepare("SELECT COUNT(*) n FROM library_asset WHERE type='SONG'").get().n;
    const del = db.prepare("DELETE FROM library_asset WHERE type = 'SONG'").run();
    console.log(`[migrate-v${VERSION}] retired ${del.changes} SONG rows (were ${songBefore}) — music lives in \`songs\``);

    // ── 2. Spots keyed by the SPOT system of record ───────────────────────────────────────────
    // v50 built SPOT assets from two sources — the `spots` table AND `songs` rows carrying
    // content_class='SPOT' — so the type ended up keyed inconsistently. On this install that left
    // 3 SPOT assets for 3 live spots sharing only ONE uuid between them, and the panel's
    // `la.uuid = s.uuid` join silently dropped the other two. A panel that hides a spot is how an
    // operator concludes the feature is broken.
    //
    // The rule, per type: key the asset by whatever table OWNS that type.
    //   SPOT         -> `spots`         (spots have their own table)
    //   ANNOUNCEMENT -> `announcements` (likewise)
    //   SWEEPER      -> `songs`         (sweepers have NO separate table; content_class JIN/SWP on
    //                                    songs is where they live, so keying by songs.uuid is
    //                                    correct and those 64 rows are deliberately left alone)
    let spotNew = 0, spotStray = 0;
    if (tableExists(db, 'spots')) {
      // Retire SPOT assets no live spot claims — the ones copied out of `songs`. The audio is still
      // in `songs`; only the duplicate library entry goes.
      spotStray = db.prepare(`
        DELETE FROM library_asset
         WHERE type = 'SPOT'
           AND NOT EXISTS (SELECT 1 FROM spots s WHERE s.uuid = library_asset.uuid AND s.deleted_at IS NULL)`).run().changes;

      const insSpot = db.prepare(`
        INSERT INTO library_asset (uuid, type, title, file_path, duration_ms, created_at, updated_at, deleted_at)
        VALUES (@uuid, 'SPOT', @title, @file_path, @duration_ms, @created_at, @updated_at, NULL)`);
      const existsA = db.prepare('SELECT 1 FROM library_asset WHERE uuid = ?');
      for (const sp of db.prepare('SELECT * FROM spots WHERE deleted_at IS NULL ORDER BY id').all()) {
        if (!sp.uuid || existsA.get(sp.uuid)) continue;
        const now = new Date().toISOString();
        insSpot.run({
          uuid: sp.uuid,
          title: sp.title || (sp.file_path ? String(sp.file_path).split(/[\\/]/).pop() : null) || 'Spot',
          file_path: sp.file_path || null,
          duration_ms: (sp.length_sec != null ? Math.round(sp.length_sec * 1000) : null),
          created_at: sp.created_at || now,
          updated_at: sp.updated_at || sp.created_at || now,
        });
        spotNew++;
      }
    }
    console.log(`[migrate-v${VERSION}] spots -> assets: ${spotNew} created, ${spotStray} stray asset(s) retired (had been copied from songs)`);

    // ── 3. Announcements become typed library entries ─────────────────────────────────────────
    let annNew = 0, annSkipped = 0, annNoUuid = 0;
    if (tableExists(db, 'announcements')) {
      // NOTE: `announcements` has NO file_key column — its columns are id, title, file_path,
      // trigger_time, days, duck_music, resume_music, duck_level, is_active, last_played_at,
      // created_at, station_id, uuid, updated_at, deleted_at, station_uuid, trigger_type,
      // close_offset_min. Identity is therefore the UUID, which every row carries and which is what
      // makes this deterministic across installs.
      const rows = db.prepare(`
        SELECT uuid, title, file_path, created_at, updated_at
          FROM announcements
         WHERE deleted_at IS NULL
         ORDER BY id`).all();

      const exists = db.prepare('SELECT 1 FROM library_asset WHERE uuid = ?');
      const ins = db.prepare(`
        INSERT INTO library_asset (uuid, type, title, file_path, created_at, updated_at, deleted_at)
        VALUES (@uuid, 'ANNOUNCEMENT', @title, @file_path, @created_at, @updated_at, NULL)`);

      for (const a of rows) {
        if (!a.uuid) {                     // cannot be made deterministic; skip rather than guess
          annNoUuid++;
          console.warn(`[migrate-v${VERSION}] announcement "${a.title}" has no uuid — skipped (the runtime writer will create its asset row)`);
          continue;
        }
        if (exists.get(a.uuid)) { annSkipped++; continue; }     // idempotent

        // Timestamps: ISO-8601 with milliseconds and a Z suffix, e.g. "2026-08-25T18:14:50.708Z".
        // Checked against the live table, not assumed. The announcement's own timestamps are reused
        // where present so the asset carries the same history; new() only fills a genuine gap.
        const now = new Date().toISOString();
        ins.run({
          uuid: a.uuid,
          title: a.title || null,
          file_path: a.file_path || null,
          created_at: a.created_at || now,
          updated_at: a.updated_at || a.created_at || now,
        });
        annNew++;
      }
    }
    console.log(`[migrate-v${VERSION}] announcements → assets: ${annNew} created, ${annSkipped} already present, ${annNoUuid} skipped (no uuid)`);

    // ── Report the resulting shape, so the log says what the library now IS ───────────────────
    const shape = db.prepare(`
      SELECT type, COUNT(*) n FROM library_asset WHERE deleted_at IS NULL GROUP BY type ORDER BY n DESC`).all();
    console.log(`[migrate-v${VERSION}] library_asset now holds: ` +
      (shape.length ? shape.map(r => `${r.type}=${r.n}`).join('  ') : '(empty)'));

    db.prepare(`INSERT INTO schema_version (version) VALUES (${VERSION})`).run();
  });

  migrate();
  console.log(`[migrate-v${VERSION}] committed — \`songs\` untouched and still authoritative for music.`);
}

module.exports = {
  payloadTransformer: function payloadTransformer(payload) {
    // Identity. This migration adds no columns and changes no payload shape — it only removes rows
    // this install had duplicated locally and adds rows an older peer simply will not have. An older
    // peer's payload applies unchanged.
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
  console.log('=== migrate-library-nonmusic-phase-sync-51.js ===');
  console.log('DB:', dbPath);
  applyMigration(db);
  db.close();
}
