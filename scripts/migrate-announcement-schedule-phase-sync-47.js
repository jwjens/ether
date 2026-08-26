'use strict';
// Migration v47 — announcement_schedule: the schedule comes OFF the announcement.
//
// docs/announcement-schedule-frame-design-2026-08-26.md, as ruled by Jeff on 2026-08-26. PASS 1.
//
// Until now one announcements row was BOTH the audio asset AND its schedule — which is exactly why an
// announcement could only ever have one time and one set of days. Jeff's model needs "closes in 30"
// at 8:30, "15 minutes" at 8:45 and "closing" at 9:00, and the same audio reusable at a different
// time on a different day. So the schedule becomes its own row:
//
//   announcements          → the ASSET.  title, file_path, is_active. What it is.
//   announcement_schedule  → the ENTRY.  which announcement, what time, which day(s) or date.
//                                        When it plays. MANY per asset.
//
// ONE ENTRY = one (announcement, time) pair attached either to a set of WEEKDAYS ('56' = Fri+Sat) or
// to a single DATE. A date's entries replace the weekday entries for that date (precedence lives in
// main.js scheduleForDate, one resolver, same discipline as v46's closingTimeForDate).
//
// announcement_uuid, NOT announcement_id. Routing a cross-row reference by the local integer is the
// defect already recorded for peer-sync: the integer means different things on different installs.
// The uuid is the identity the fire path already keys on.
//
// last_played_at LIVES ON THE ENTRY, and this is load-bearing rather than tidy. The 120s double-fire
// guard used to key on the ASSET. Under this model that breaks the feature outright: "closes in 30"
// at 8:45 and "closing" at 9:00 may be the same audio file, and an asset-level guard would let the
// first fire suppress the second.
//
// THE BACKFILL MUST CHANGE NOTHING. Every live announcement becomes exactly one weekday entry
// carrying its current days/type/time/offset AND its current last_played_at, so every station keeps
// firing precisely what it fires today, at the same times, on the same days, with its double-fire
// state intact. The upgrade is invisible until someone adds a second entry.
//
// The old announcements scheduling columns (trigger_time, days, trigger_type, close_offset_min) are
// LEFT IN PLACE and stop being read by the tick. Not dropped: SQLite drops are disruptive, and an
// older build rolled back onto this DB would still read them and behave sanely. Pass 1 keeps them
// mirrored on write (see electron/sync/handlers/announcements.js) so the existing panel — which has
// not been rebuilt yet — still works. Pass 2 rebuilds the panel and removes that mirror.
//
// Idempotent. Verify on a COPY first:
//   ELECTRON_RUN_AS_NODE=1 electron.exe scripts/migrate-announcement-schedule-phase-sync-47.js <copy.db>

const crypto = require('crypto');
const TABLE  = 'announcement_schedule';

function isAlreadyMigrated(db) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(TABLE);
}

function applyMigration(db) {
  if (isAlreadyMigrated(db)) {
    try { db.prepare('INSERT INTO schema_version (version) VALUES (47)').run(); } catch (e) { /* already recorded */ }
    console.log('[migrate-v47] SKIP — announcement_schedule already exists');
    return;
  }

  const migrate = db.transaction(() => {
    db.prepare(`
      CREATE TABLE ${TABLE} (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        station_id        INTEGER,
        uuid              TEXT,
        announcement_uuid TEXT NOT NULL,                  -- WHICH announcement, by uuid
        scope             TEXT NOT NULL DEFAULT 'weekday',-- 'weekday' | 'date'
        days              TEXT,                           -- weekday scope: '56' = Fri+Sat
        date              TEXT,                           -- date scope: 'YYYY-MM-DD'
        trigger_type      TEXT NOT NULL DEFAULT 'absolute',
        trigger_time      TEXT,
        close_offset_min  INTEGER NOT NULL DEFAULT 0,
        sort_order        INTEGER NOT NULL DEFAULT 0,
        last_played_at    INTEGER,                        -- the 120s guard, PER ENTRY
        created_at        TEXT,
        updated_at        TEXT,
        deleted_at        TEXT
      )
    `).run();
    db.prepare(
      `CREATE INDEX IF NOT EXISTS idx_ann_sched_station_scope
         ON ${TABLE}(station_id, scope) WHERE deleted_at IS NULL`
    ).run();
    db.prepare(
      `CREATE INDEX IF NOT EXISTS idx_ann_sched_date
         ON ${TABLE}(station_id, date) WHERE deleted_at IS NULL`
    ).run();

    // ── THE INVISIBLE BACKFILL ───────────────────────────────────────────────────────────────────
    let made = 0, skipped = 0;
    let src = [];
    try {
      src = db.prepare(
        "SELECT uuid, station_id, days, trigger_time, last_played_at, " +
        "COALESCE(trigger_type,'absolute') AS trigger_type, COALESCE(close_offset_min,0) AS close_offset_min " +
        "FROM announcements WHERE deleted_at IS NULL"
      ).all();
    } catch (e) {
      // No announcements table on this DB — nothing to carry forward, and not an error.
      console.log('[migrate-v47] announcements not readable (' + e.message + ') — table created empty.');
      src = [];
    }

    const now = new Date().toISOString();
    const ins = db.prepare(
      `INSERT INTO ${TABLE}
         (station_id, uuid, announcement_uuid, scope, days, date, trigger_type, trigger_time,
          close_offset_min, sort_order, last_played_at, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, 'weekday', ?, NULL, ?, ?, ?, 0, ?, ?, ?, NULL)`
    );
    for (const a of src) {
      // An announcement with no uuid cannot be referenced — and could never fire from the scheduler
      // anyway, because fireAnnouncement looks the row up BY uuid. Skipped and counted, never
      // silently invented.
      if (!a.uuid) { skipped++; continue; }
      ins.run(
        a.station_id, crypto.randomUUID(), a.uuid,
        a.days ?? '0123456', a.trigger_type, a.trigger_time,
        a.close_offset_min, a.last_played_at, now, now
      );
      made++;
    }
    console.log(`[migrate-v47] backfilled ${made} weekday entr${made === 1 ? 'y' : 'ies'} from announcements` +
                (skipped ? ` (${skipped} skipped — no uuid, never schedulable)` : ''));

    db.prepare('INSERT INTO schema_version (version) VALUES (47)').run();
  });
  migrate();
  console.log('[migrate-v47] Transaction committed — announcement_schedule created and backfilled.');
}

module.exports = {
  payloadTransformer: function payloadTransformer(payload) {
    // Identity — announcement_schedule is brand new, so there are no older payloads to transform.
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

  console.log('=== migrate-announcement-schedule-phase-sync-47.js ===');
  console.log('DB:', dbPath);
  applyMigration(db);
  const n = db.prepare(`SELECT COUNT(*) AS n FROM ${TABLE} WHERE deleted_at IS NULL`).get().n;
  console.log(`[migrate-v47] ${TABLE} live rows: ${n}`);
  db.close();
}
